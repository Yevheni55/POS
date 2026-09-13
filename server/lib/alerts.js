// Upozornenia von z kasy (Telegram): manažér sa dozvie o objednávke, ktorú
// dve minúty nikto neprijal, o automatickom odmietnutí pred termínom Woltu,
// o zrušení Woltom po prijatí a o spadnutom moste. Best-effort — nikdy
// nesmie zhodiť tok objednávky. Bez ALERT_TELEGRAM_* je ticho.
//
// Nastavenie: bot cez @BotFather → ALERT_TELEGRAM_BOT_TOKEN; chat id
// manažéra/skupiny → ALERT_TELEGRAM_CHAT_ID (napr. cez @userinfobot).
export const _internals = { fetch: (...a) => globalThis.fetch(...a) };

function env(name, fallback = '') {
  const v = process.env[name];
  return v == null || v === '' ? fallback : String(v);
}

export function alertsConfig() {
  const token = env('ALERT_TELEGRAM_BOT_TOKEN');
  const chatId = env('ALERT_TELEGRAM_CHAT_ID');
  return { token, chatId, enabled: !!token && !!chatId };
}

/** Pošle správu; vráti true pri úspechu, false keď nie je nastavené alebo zlyhalo. */
export async function sendAlert(text) {
  const cfg = alertsConfig();
  if (!cfg.enabled) return false;
  try {
    const res = await _internals.fetch('https://api.telegram.org/bot' + cfg.token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chatId, text: String(text).slice(0, 3500), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.error('[alerts] Telegram odmietol:', res.status);
    return res.ok;
  } catch (e) {
    console.error('[alerts] Telegram zlyhal:', e.message);
    return false;
  }
}
