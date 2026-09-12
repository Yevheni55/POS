<?php
/**
 * Surf Spirit — objednávky s doručením (Wolt Drive), verejné API na Websupporte.
 *
 * Kasa (POS) je za NAT-om bez verejnej adresy. Tento súbor preto objednávky
 * zapisuje do Neon (tabuľka web_orders) a kasa si ich sama každých pár sekúnd
 * vyzdvihne (server/lib/web-orders-bridge.js); stav zapisuje späť a zákazník
 * ho číta tu. Ceny sa berú VŽDY z guest_menu (kasa ju sem synchronizuje),
 * nikdy z klienta. Či je doručenie dostupné, hovorí web_delivery_config —
 * zapisuje ju kasa a jej updated_at je „heartbeat".
 *
 * Routovanie cez PATH_INFO — rovnaké cesty ako priame API kasy (/api/public):
 *   GET  /menu
 *   GET  /online-orders/config
 *   POST /online-orders/quote            { street, city, postCode, scheduledFor? }
 *   POST /online-orders                  { customer, dropoff, items, note, paymentMethod, promiseId, scheduledFor?, consent }
 *   GET  /online-orders/{SS-XXXXX}
 *   POST /online-orders/wolt/webhook     { token: <JWT HS256> }
 *
 * Tajomstvá: .secrets.ini (sekcie [neon] a [wolt]) — .htaccess ho nepustí von.
 * Nasadenie: bash scripts/deploy-surfspirit-html.sh
 */
declare(strict_types=1);

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // bez 0/O, 1/I
const CACHE_DIR = __DIR__ . '/.cache';
const HEARTBEAT_MAX_S = 90;   // kasa píše každých ~8 s; po 90 s ticha je doručenie „nedostupné"
const MENU_CACHE_S = 30;

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

$origin = (string)($_SERVER['HTTP_ORIGIN'] ?? '');
$allowedOrigins = ['https://surfspirit.sk', 'https://www.surfspirit.sk', 'http://localhost:3080', 'http://127.0.0.1:3080'];
if ($origin !== '' && in_array($origin, $allowedOrigins, true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    header('Access-Control-Max-Age: 600');
}
$method = (string)($_SERVER['REQUEST_METHOD'] ?? 'GET');
if ($method === 'OPTIONS') { http_response_code(204); exit; }
$path = '/' . trim((string)($_SERVER['PATH_INFO'] ?? ($_GET['path'] ?? '')), '/');

// ── Pomocníci ────────────────────────────────────────────────────────────────
function out(array $data, int $code = 200): never {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
function fail(string $msg, int $code = 400, array $extra = []): never { out(['error' => $msg] + $extra, $code); }
function body(): array {
    $raw = file_get_contents('php://input');
    $j = json_decode($raw ?: '', true);
    if (!is_array($j)) fail('Neplatné telo požiadavky');
    return $j;
}
function secrets(): array {
    static $s = null;
    if ($s === null) { $f = __DIR__ . '/.secrets.ini'; $s = is_file($f) ? (parse_ini_file($f, true) ?: []) : []; }
    return $s;
}
function pdo(): PDO {
    static $pdo = null;
    if ($pdo) return $pdo;
    $neon = secrets()['neon'] ?? null;
    if (!$neon) fail('Konfigurácia databázy chýba', 500);
    $dsn = sprintf('pgsql:host=%s;port=%s;dbname=%s;sslmode=require', $neon['host'], $neon['port'] ?? 5432, $neon['dbname']);
    try {
        $pdo = new PDO($dsn, $neon['user'], $neon['password'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_TIMEOUT => 10,
        ]);
        $pdo->exec("SET TIME ZONE 'UTC'");
    } catch (PDOException $e) {
        fail('Databáza nie je dostupná', 503);
    }
    return $pdo;
}
function clientIp(): string {
    $raw = (string)($_SERVER['HTTP_CF_CONNECTING_IP'] ?? $_SERVER['HTTP_X_FORWARDED_FOR'] ?? $_SERVER['REMOTE_ADDR'] ?? '');
    return substr(trim(explode(',', $raw)[0]), 0, 64);
}
/** Limit podľa IP — súborový (jeden hosting), zámok cez flock. Bez súboru radšej pustí. */
function rateLimit(string $key, int $max, int $windowS): bool {
    $dir = CACHE_DIR . '/rl';
    if (!is_dir($dir)) @mkdir($dir, 0755, true);
    $fh = @fopen($dir . '/' . sha1($key) . '.json', 'c+');
    if (!$fh) return true;
    $now = time();
    flock($fh, LOCK_EX);
    $hits = json_decode(stream_get_contents($fh) ?: '[]', true);
    if (!is_array($hits)) $hits = [];
    $hits = array_values(array_filter($hits, fn($t) => is_int($t) && $now - $t < $windowS));
    $ok = count($hits) < $max;
    if ($ok) $hits[] = $now;
    ftruncate($fh, 0); rewind($fh); fwrite($fh, json_encode($hits)); fflush($fh);
    flock($fh, LOCK_UN); fclose($fh);
    return $ok;
}
function round2($n): float { return round((float)$n, 2); }
function publicCode(): string {
    $s = '';
    for ($i = 0; $i < 5; $i++) $s .= CODE_ALPHABET[random_int(0, strlen(CODE_ALPHABET) - 1)];
    return 'SS-' . $s;
}
/** Časová pečiatka z Postgresu (session je v UTC) → ISO 8601 v UTC, ako to vracia kasa. */
function iso(?string $ts): ?string {
    if (!$ts) return null;
    try { return (new DateTimeImmutable($ts, new DateTimeZone('UTC')))->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s.v\Z'); }
    catch (Throwable) { return null; }
}
function str($v, int $min, int $max, string $label): string {
    $s = is_string($v) ? trim($v) : '';
    $len = mb_strlen($s);
    if ($len < $min || $len > $max) fail($label);
    return $s;
}

// ── Konfigurácia od kasy ─────────────────────────────────────────────────────
function deliveryConfig(PDO $pdo): array {
    $row = $pdo->query("SELECT value, EXTRACT(EPOCH FROM (now() - updated_at)) AS age FROM web_delivery_config WHERE key = 'config'")->fetch();
    $v = $row ? (json_decode((string)$row['value'], true) ?: []) : [];
    $alive = $row && (float)$row['age'] <= HEARTBEAT_MAX_S;
    $enabled = $alive && !empty($v['deliveryEnabled']);
    return [
        'deliveryEnabled' => $enabled,
        'mode' => $enabled ? (string)($v['mode'] ?? 'off') : 'off',
        'paymentMethods' => is_array($v['paymentMethods'] ?? null) ? $v['paymentMethods'] : ['transfer'],
        'minOrderEur' => (float)($v['minOrderEur'] ?? 10),
        'pickup' => $v['pickup'] ?? ['name' => 'Surf Spirit Draždiak', 'street' => 'Tematínska 3270/3', 'city' => 'Bratislava'],
        'minPrepMinutes' => (int)($v['minPrepMinutes'] ?? 20),
        'mockFeeEur' => (float)($v['mockFeeEur'] ?? 2.9),
    ];
}

// ── Menu (guest_menu s id položiek z kasy) ───────────────────────────────────
function menu(PDO $pdo): array {
    $cache = CACHE_DIR . '/objednavky-menu.json';
    if (is_file($cache) && time() - filemtime($cache) < MENU_CACHE_S) {
        $j = json_decode((string)file_get_contents($cache), true);
        if (is_array($j)) return $j;
    }
    $rows = $pdo->query("
        SELECT pos_item_id, category_slug, category_label, category_icon, category_sort, item_name, item_emoji, item_price, item_desc
        FROM guest_menu
        WHERE active = true AND pos_item_id IS NOT NULL
        ORDER BY NULLIF(regexp_replace(category_sort, '[^0-9]', '', 'g'), '')::int NULLS LAST, id")->fetchAll();
    $cats = [];
    foreach ($rows as $r) {
        $slug = (string)$r['category_slug'];
        if (!isset($cats[$slug])) {
            $cats[$slug] = ['slug' => $slug, 'label' => $r['category_label'], 'icon' => $r['category_icon'], 'sort' => (string)$r['category_sort'], 'items' => []];
        }
        $cats[$slug]['items'][] = [
            'id' => (int)$r['pos_item_id'],
            'name' => $r['item_name'],
            'emoji' => $r['item_emoji'],
            'price' => number_format((float)$r['item_price'], 2, '.', ''),
            'desc' => (string)$r['item_desc'],
        ];
    }
    $menu = ['menu' => array_values($cats)];
    if (!is_dir(CACHE_DIR)) @mkdir(CACHE_DIR, 0755, true);
    @file_put_contents($cache, json_encode($menu, JSON_UNESCAPED_UNICODE), LOCK_EX);
    return $menu;
}

// ── Wolt Drive: cena a čas doručenia (shipment promise) ──────────────────────
function woltBase(string $mode): string {
    return $mode === 'production' ? 'https://daas-public-api.wolt.com' : 'https://daas-public-api.development.dev.woltapi.com';
}
/** Wolt: pri doručení do hodiny sa scheduled_dropoff_time NEPOSIELA. */
function scheduledForWolt(?string $scheduledFor): ?string {
    if (!$scheduledFor) return null;
    $t = strtotime($scheduledFor);
    if ($t === false) return null;
    return $t - time() > 3600 ? gmdate('Y-m-d\TH:i:s\Z', $t) : null;
}
function woltPromise(array $cfg, array $drop, ?string $scheduledFor): array {
    if ($cfg['mode'] === 'mock') {
        return [
            'id' => 'mock-promise-' . bin2hex(random_bytes(6)),
            'feeEur' => $cfg['mockFeeEur'],
            'etaMinutes' => 35,
            'validUntil' => gmdate('Y-m-d\TH:i:s\Z', time() + 600),
            'dropoff' => ['lat' => 48.1122, 'lon' => 17.1444, 'formattedAddress' => $drop['street'] . ', ' . $drop['postCode'] . ' ' . $drop['city']],
        ];
    }
    $w = secrets()['wolt'] ?? [];
    if (empty($w['token']) || empty($w['venue_id'])) fail('Wolt Drive nie je nakonfigurovaný', 503);
    $req = ['street' => $drop['street'], 'city' => $drop['city'], 'post_code' => $drop['postCode'], 'min_preparation_time_minutes' => $cfg['minPrepMinutes']];
    if ($s = scheduledForWolt($scheduledFor)) $req['scheduled_dropoff_time'] = $s;

    $ch = curl_init(woltBase($cfg['mode']) . '/v1/venues/' . rawurlencode((string)$w['venue_id']) . '/shipment-promises');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => json_encode($req),
        CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $w['token'], 'Content-Type: application/json', 'Accept: application/json'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 10,
    ]);
    $res = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    curl_close($ch);
    if ($res === false) fail('Wolt Drive neodpovedá (' . $err . ')', 504);
    $data = json_decode((string)$res, true);
    if ($code < 200 || $code >= 300 || !is_array($data)) {
        $detail = is_array($data) ? ($data['detail'] ?? $data['title'] ?? $data['message'] ?? $data['error'] ?? '') : (string)$res;
        fail('Wolt Drive odmietol požiadavku (' . $code . '): ' . mb_substr(is_string($detail) ? $detail : json_encode($detail), 0, 300), $code >= 500 ? 502 : 422);
    }
    $eta = $data['dropoff']['eta_minutes'] ?? $data['time_estimate_minutes'] ?? null;
    return [
        'id' => (string)$data['id'],
        'feeEur' => isset($data['price']['amount']) ? round2($data['price']['amount'] / 100) : null,
        'etaMinutes' => $eta === null ? null : (int)$eta,
        'validUntil' => $data['valid_until'] ?? null,
        'dropoff' => [
            'lat' => $data['dropoff']['location']['coordinates']['lat'] ?? null,
            'lon' => $data['dropoff']['location']['coordinates']['lon'] ?? null,
            'formattedAddress' => (string)($data['dropoff']['location']['formatted_address'] ?? ''),
        ],
    ];
}
function rememberPromise(PDO $pdo, array $p): void {
    $pdo->prepare('INSERT INTO web_promises (id, fee_eur, eta_minutes, valid_until, dropoff) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING')
        ->execute([$p['id'], $p['feeEur'] ?? 0, $p['etaMinutes'], $p['validUntil'], json_encode($p['dropoff'])]);
}
function freshPromise(PDO $pdo, string $id): ?array {
    $st = $pdo->prepare("SELECT id, fee_eur, eta_minutes, valid_until, dropoff FROM web_promises WHERE id = ? AND (valid_until IS NULL OR valid_until > now() + interval '30 seconds')");
    $st->execute([$id]);
    $r = $st->fetch();
    if (!$r) return null;
    return ['id' => $r['id'], 'feeEur' => (float)$r['fee_eur'], 'etaMinutes' => $r['eta_minutes'] === null ? null : (int)$r['eta_minutes'], 'validUntil' => $r['valid_until'], 'dropoff' => json_decode((string)$r['dropoff'], true) ?: []];
}

// ── Endpointy ────────────────────────────────────────────────────────────────
function quote(PDO $pdo, array $cfg): never {
    if (!rateLimit('q:' . clientIp(), 40, 600)) fail('Priveľa pokusov, skúste o chvíľu', 429);
    if (!$cfg['deliveryEnabled']) fail('Doručenie momentálne nie je dostupné', 503);
    $b = body();
    $street = str($b['street'] ?? '', 3, 200, 'Zadajte ulicu s číslom');
    $city = str($b['city'] ?? '', 2, 120, 'Zadajte mesto');
    $psc = str($b['postCode'] ?? '', 5, 12, 'Zadajte PSČ');
    if (!preg_match('/^\d{3}\s?\d{2}$/', $psc)) fail('Zadajte PSČ (5 číslic)');
    $sched = null;
    if (!empty($b['scheduledFor'])) { $t = strtotime((string)$b['scheduledFor']); if ($t !== false) $sched = gmdate('Y-m-d\TH:i:s\Z', $t); }
    $p = woltPromise($cfg, ['street' => $street, 'city' => $city, 'postCode' => $psc], $sched);
    rememberPromise($pdo, $p);
    out(['promiseId' => $p['id'], 'feeEur' => $p['feeEur'], 'etaMinutes' => $p['etaMinutes'], 'validUntil' => $p['validUntil'], 'address' => $p['dropoff']['formattedAddress'] ?? '']);
}

function createOrder(PDO $pdo, array $cfg): never {
    $ip = clientIp();
    if (!rateLimit('o:' . $ip, 10, 3600)) fail('Priveľa objednávok z tejto adresy, skúste neskôr', 429);
    if (!$cfg['deliveryEnabled']) fail('Doručenie momentálne nie je dostupné', 503);
    $b = body();
    if (($b['consent'] ?? null) !== true) fail('Potvrďte súhlas so spracovaním údajov');

    $c = is_array($b['customer'] ?? null) ? $b['customer'] : [];
    $name = str($c['name'] ?? '', 2, 120, 'Zadajte meno');
    $phone = str($c['phone'] ?? '', 9, 40, 'Zadajte telefón');
    if (!preg_match('/^\+?[0-9 ()\-]{9,30}$/', $phone)) fail('Zadajte telefón, napr. +421 900 123 456');
    $email = trim((string)($c['email'] ?? ''));
    if ($email !== '' && (mb_strlen($email) > 160 || !filter_var($email, FILTER_VALIDATE_EMAIL))) fail('Neplatný e-mail');

    $d = is_array($b['dropoff'] ?? null) ? $b['dropoff'] : [];
    $street = str($d['street'] ?? '', 3, 200, 'Zadajte ulicu s číslom');
    $city = str($d['city'] ?? '', 2, 120, 'Zadajte mesto');
    $psc = str($d['postCode'] ?? '', 5, 12, 'Zadajte PSČ');
    if (!preg_match('/^\d{3}\s?\d{2}$/', $psc)) fail('Zadajte PSČ (5 číslic)');
    $comment = mb_substr(trim((string)($d['comment'] ?? '')), 0, 300);

    $pay = (string)($b['paymentMethod'] ?? 'transfer');
    if (!in_array($pay, $cfg['paymentMethods'], true)) {
        fail($pay === 'cash' ? 'Platba kuriérovi nie je dostupná, zvoľte platbu vopred' : 'Neplatný spôsob platby');
    }
    $note = mb_substr(trim((string)($b['note'] ?? '')), 0, 300);

    // Čas doručenia: buď „čo najskôr", alebo 45 min až 7 dní dopredu (ako na kase).
    $scheduledFor = null;
    if (!empty($b['scheduledFor'])) {
        $t = strtotime((string)$b['scheduledFor']);
        if ($t === false) fail('Neplatný čas doručenia');
        if ($t < time() + 45 * 60) fail('Čas doručenia musí byť aspoň 45 minút dopredu');
        if ($t > time() + 7 * 86400) fail('Doručenie sa dá naplánovať najviac 7 dní dopredu');
        $scheduledFor = gmdate('Y-m-d\TH:i:s\Z', $t);
    }

    $items = is_array($b['items'] ?? null) ? $b['items'] : [];
    if (!$items || count($items) > 50) fail('Košík je prázdny');
    $wanted = [];
    foreach ($items as $it) {
        $id = (int)($it['menuItemId'] ?? 0);
        $qty = (int)($it['qty'] ?? 0);
        if ($id <= 0 || $qty < 1 || $qty > 20) fail('Neplatná položka v košíku');
        $wanted[] = ['id' => $id, 'qty' => $qty, 'note' => mb_substr(trim((string)($it['note'] ?? '')), 0, 120)];
    }
    $ids = array_values(array_unique(array_column($wanted, 'id')));
    $in = implode(',', array_fill(0, count($ids), '?'));
    $st = $pdo->prepare("SELECT pos_item_id, item_name, item_price, vat_rate FROM guest_menu WHERE active = true AND pos_item_id IN ($in)");
    $st->execute($ids);
    $byId = [];
    foreach ($st->fetchAll() as $r) $byId[(int)$r['pos_item_id']] = $r;
    $missing = array_values(array_filter($ids, fn($id) => !isset($byId[$id])));
    if ($missing) fail('Niektoré položky už nie sú v ponuke', 400, ['missingIds' => $missing]);

    $lines = [];
    $subtotal = 0.0;
    foreach ($wanted as $w) {
        $m = $byId[$w['id']];
        $price = round2($m['item_price']);
        $lines[] = ['menuItemId' => $w['id'], 'name' => $m['item_name'], 'qty' => $w['qty'], 'unitPrice' => $price, 'vatRate' => round2($m['vat_rate'] ?? 0), 'note' => $w['note']];
        $subtotal += $price * $w['qty'];
    }
    $subtotal = round2($subtotal);
    if ($subtotal < $cfg['minOrderEur']) fail('Minimálna objednávka je ' . number_format($cfg['minOrderEur'], 2, ',', '') . ' €');

    $promise = !empty($b['promiseId']) ? freshPromise($pdo, (string)$b['promiseId']) : null;
    if (!$promise) {
        $promise = woltPromise($cfg, ['street' => $street, 'city' => $city, 'postCode' => $psc], $scheduledFor);
        rememberPromise($pdo, $promise);
    }
    $fee = round2($promise['feeEur'] ?? 0);
    $total = round2($subtotal + $fee);

    $ins = $pdo->prepare("
        INSERT INTO web_orders (public_code, status, customer_name, customer_phone, customer_email, dropoff_street, dropoff_city,
            dropoff_post_code, dropoff_comment, dropoff_lat, dropoff_lon, items, subtotal, delivery_fee, total, payment_method, note,
            scheduled_for, wolt_promise_id, wolt_promise_valid_until, client_ip)
        VALUES (?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id, public_code");
    $created = null;
    for ($i = 0; $i < 5 && !$created; $i++) {
        try {
            $ins->execute([publicCode(), $name, $phone, $email, $street, $city, $psc, $comment,
                $promise['dropoff']['lat'] ?? null, $promise['dropoff']['lon'] ?? null,
                json_encode($lines, JSON_UNESCAPED_UNICODE), $subtotal, $fee, $total, $pay, $note,
                $scheduledFor, $promise['id'], $promise['validUntil'] ?? null, $ip]);
            $created = $ins->fetch() ?: null;
        } catch (PDOException $e) {
            if ((string)$e->getCode() !== '23505') throw $e; // kolízia kódu → skúsime iný
        }
    }
    if (!$created) fail('Nepodarilo sa vytvoriť objednávku, skúste znova', 500);
    $pdo->prepare("INSERT INTO web_order_events (web_order_id, type, payload) VALUES (?, 'created', ?)")->execute([$created['id'], json_encode(['ip' => $ip])]);

    out([
        'code' => $created['public_code'],
        'status' => 'new',
        'subtotal' => $subtotal, 'deliveryFee' => $fee, 'total' => $total,
        'etaMinutes' => $promise['etaMinutes'] ?? null,
        'trackUrl' => '/objednat.html?kod=' . $created['public_code'],
    ], 201);
}

function toPublic(array $o): array {
    return [
        'code' => $o['public_code'],
        'status' => $o['status'],
        'createdAt' => iso($o['created_at']),
        'items' => json_decode((string)$o['items'], true) ?: [],
        'subtotal' => (float)$o['subtotal'],
        'deliveryFee' => (float)$o['delivery_fee'],
        'total' => (float)$o['total'],
        'paymentMethod' => $o['payment_method'],
        'scheduledFor' => iso($o['scheduled_for']),
        'readyAt' => iso($o['ready_at']),
        'wolt' => ['status' => $o['wolt_status'], 'trackingUrl' => $o['wolt_tracking_url']],
        'rejectedReason' => $o['status'] === 'rejected' ? $o['rejected_reason'] : null,
    ];
}
function status(PDO $pdo, string $code): never {
    if (!preg_match('/^SS-[A-Z2-9]{5}$/', $code)) fail('Objednávka sa nenašla', 404);
    $st = $pdo->prepare('SELECT * FROM web_orders WHERE public_code = ?');
    $st->execute([$code]);
    $o = $st->fetch();
    if (!$o) fail('Objednávka sa nenašla', 404);
    out(toPublic($o));
}

// ── Webhook Woltu: { token: <JWT HS256 podpísaný client_secret-om> } ─────────
function b64url(string $s): string|false {
    return base64_decode(strtr($s, '-_', '+/') . str_repeat('=', (4 - strlen($s) % 4) % 4), true);
}
function verifyJwtHs256(string $token, string $secret): array {
    $parts = explode('.', $token);
    if (count($parts) !== 3) fail('Neplatný podpis webhooku', 401);
    [$h, $p, $s] = $parts;
    $header = json_decode((string)b64url($h), true);
    if (($header['alg'] ?? '') !== 'HS256') fail('Neplatný podpis webhooku', 401);
    $sig = b64url($s);
    if ($sig === false || !hash_equals(hash_hmac('sha256', $h . '.' . $p, $secret, true), $sig)) fail('Neplatný podpis webhooku', 401);
    $payload = json_decode((string)b64url($p), true);
    if (!is_array($payload)) fail('Neplatný podpis webhooku', 401);
    if (isset($payload['exp']) && (int)$payload['exp'] < time() - 60) fail('Webhook expiroval', 401);
    return $payload;
}
/** Rovnaké mapovanie ako statusForWebhookType() na kase. */
function statusForWebhookType(string $t): ?string {
    return match ($t) {
        'order.delivered', 'order.dropoff_completed' => 'delivered',
        'order.rejected' => 'confirmed',
        default => null,
    };
}
function woltWebhook(PDO $pdo): never {
    $b = body();
    $token = (string)($b['token'] ?? '');
    if (strlen($token) < 20) fail('Chýba token');
    $secret = (string)(secrets()['wolt']['webhook_secret'] ?? '');
    if ($secret === '') fail('Webhook secret nie je nastavený', 503);
    $ev = verifyJwtHs256($token, $secret);
    $type = (string)($ev['type'] ?? '');
    $d = is_array($ev['details'] ?? null) ? $ev['details'] : [];
    $ref = $d['wolt_order_reference_id'] ?? null;
    $code = $d['merchant_order_reference_id'] ?? null;

    $st = $ref
        ? $pdo->prepare('SELECT * FROM web_orders WHERE wolt_order_reference_id = ? LIMIT 1')
        : $pdo->prepare('SELECT * FROM web_orders WHERE public_code = ? LIMIT 1');
    $st->execute([$ref ?: (string)$code]);
    $o = $st->fetch();
    // Neznámu objednávku potvrdíme 200 — Wolt by inak opakoval donekonečna.
    if (!$o) out(['ok' => true, 'ignored' => true]);

    $woltStatus = preg_replace('/^order\./', '', $type) ?: $o['wolt_status'];
    $next = statusForWebhookType($type);
    $status = ($next && !in_array($o['status'], ['rejected', 'cancelled'], true)) ? $next : $o['status'];
    $pdo->prepare('UPDATE web_orders SET wolt_status = ?, status = ?, wolt_tracking_url = COALESCE(?, wolt_tracking_url), updated_at = now() WHERE id = ?')
        ->execute([$woltStatus, $status, $d['tracking']['url'] ?? null, $o['id']]);
    // Kasa si udalosť prevezme a premietne do svojej kópie objednávky.
    $pdo->prepare('INSERT INTO web_order_events (web_order_id, type, payload) VALUES (?, ?, ?)')
        ->execute([$o['id'], 'wolt:' . ($type ?: 'unknown'), json_encode($d, JSON_UNESCAPED_UNICODE)]);
    out(['ok' => true]);
}

// ── Routovanie ───────────────────────────────────────────────────────────────
try {
    $pdo = pdo();
    if ($method === 'GET' && $path === '/menu') out(menu($pdo));
    if ($method === 'GET' && $path === '/online-orders/config') {
        $c = deliveryConfig($pdo);
        out(['deliveryEnabled' => $c['deliveryEnabled'], 'mode' => $c['mode'], 'paymentMethods' => $c['paymentMethods'], 'minOrderEur' => $c['minOrderEur'], 'pickup' => $c['pickup']]);
    }
    if ($method === 'POST' && $path === '/online-orders/quote') quote($pdo, deliveryConfig($pdo));
    if ($method === 'POST' && $path === '/online-orders') createOrder($pdo, deliveryConfig($pdo));
    if ($method === 'POST' && $path === '/online-orders/wolt/webhook') woltWebhook($pdo);
    if ($method === 'GET' && preg_match('#^/online-orders/([A-Za-z0-9-]{4,12})$#', $path, $m)) status($pdo, strtoupper($m[1]));
    fail('Nenašlo sa', 404);
} catch (PDOException $e) {
    error_log('objednavky-api: ' . $e->getMessage());
    fail('Databáza zlyhala', 500);
}
