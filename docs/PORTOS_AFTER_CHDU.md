# Portos після установки та CHDU

## Що вже зроблено

- Portos (NineDigit) встановлено на Windows каси.
- CHDU підключено — у Portos має бути видно сховище / серійний номер.

## 1. Брандмауэр (один раз, від адміністратора)

Щоб контейнер POS міг викликати API Portos на `host.docker.internal:3010`:

```powershell
cd C:\POS
powershell -ExecutionPolicy Bypass -File .\scripts\open-bar-pc-firewall.ps1
```

Там є правило **Portos API HTTP 3010**.

## 2. Перевірка з каси

На хості:

```powershell
Test-NetConnection -ComputerName 127.0.0.1 -Port 3010
```

`TcpTestSucceeded: True` — сервіс слухає порт.

Через Docker:

```powershell
cd C:\POS
powershell -ExecutionPolicy Bypass -File .\scripts\run-portos-readiness-docker.ps1
```

У JSON дивись: `serviceReachable: true`, стан принтера / сертифіката / `cashRegisterCode`.

## 3. `server\.env` на касі

- **`PORTOS_CASH_REGISTER_CODE`** — має **точно збігатися** з кодом каси в Portos (реєстрація eKāsa), не з тестового прикладу, якщо вже бойова каса.
- **`PORTOS_PRINTER_NAME=pos`** — паперовий чек через CHDU (не ім’я принтера Windows).
- **`PORTOS_ENABLED=true`** — увімкнути фіскальні платежі (після зеленого статусу).
- **`PORTOS_BASE_URL`** у контейнері задає `docker-compose.yml` як `http://host.docker.internal:3010` — рядок у `.env` з `localhost` для контейнера не використовується.

Після змін `.env`:

```powershell
cd C:\POS
docker compose up -d
```

## 3b. Тестовий фіскальний чек (тільки тестова каса eKāsa)

Після зеленого `portos-readiness` можна один раз перевірити повний **`cash_register`** (1 €, DPH 19 %, готівка):

```bash
cd server && npm run portos:fiscal-test
```

У Docker на касі (якщо скрипт ще не в образі — скопіюй `server/scripts/portos-fiscal-test-receipt.mjs` у контейнер або перезбери образ):

```powershell
docker compose exec -T app sh -c "cd /app/server && node scripts/portos-fiscal-test-receipt.mjs"
```

Очікувано: `resultMode` = `online_success`, `receiptNumber`, `okp` у виводі.

## 4. В адмінці POS

Увійти як **manazer** або **admin** → інтеграції / статус Portos (`GET /api/integrations/portos/status`) — має бути без помилок, `serviceReachable` тощо.

## 5. Перед першим бойовим чеком

- Тестовий платіж або пілот за `server/PORTOS_RUNBOOK.md`.
- Ставки ПДВ в меню мають відповідати дійсним (інакче Portos відхилить документ).
