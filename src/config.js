import 'dotenv/config';
import path from 'node:path';

const num = (key, fallback, min, max) => {
  const raw = process.env[key];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key} harus antara ${min} dan ${max}`);
  return value;
};
const bool = (key, fallback = false) => {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  if (!['true', 'false'].includes(raw.toLowerCase())) throw new Error(`${key} harus true atau false`);
  return raw.toLowerCase() === 'true';
};
export function loadConfig() {
  const cfg = {
    dataDir: path.resolve(process.env.DATA_DIR || './data'),
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
    allowedNumber: (process.env.ALLOWED_NUMBER || '').replace(/\D/g, ''),
    connectionOnly: bool('CONNECTION_ONLY'),
    proactive: bool('PROACTIVE_ENABLED'),
    times: (process.env.PROACTIVE_TIMES || '08:00,12:30,19:30').split(',').map(s => s.trim()),
    dailyMax: num('PROACTIVE_DAILY_MAX', 5, 0, 30),
    recentMinutes: num('PROACTIVE_RECENT_ACTIVITY_MINUTES', 60, 0, 1440),
    gapMinutes: num('PROACTIVE_MIN_GAP_MINUTES', 90, 1, 1440),
    debounceMs: num('MESSAGE_DEBOUNCE_MS', 3500, 250, 30000),
    bubbles: num('MAX_REPLY_BUBBLES', 6, 1, 10),
    quoteChance: num('REPLY_QUOTE_CHANCE', .25, 0, 1),
    temperature: num('GEMINI_TEMPERATURE', 1.05, 0, 2),
    lightReadingChance: num('LIGHT_READING_CHANCE', .035, 0, .1),
    outputTokens: num('GEMINI_MAX_OUTPUT_TOKENS', 700, 100, 4000),
    timeoutMs: num('GEMINI_TIMEOUT_MS', 30000, 1000, 120000),
    imageSearchKey: process.env.PEXELS_API_KEY || '',
    imageDailyMax: num('IMAGE_SEARCH_DAILY_MAX', 4, 0, 30),
    imageGapMinutes: num('IMAGE_SEARCH_MIN_GAP_MINUTES', 120, 1, 1440),
    imageTimeoutMs: num('IMAGE_SEARCH_TIMEOUT_MS', 12000, 1000, 60000),
    logLevel: process.env.LOG_LEVEL || 'info',
  };
  if (!cfg.connectionOnly && (!cfg.apiKey || !cfg.allowedNumber)) throw new Error('GEMINI_API_KEY dan ALLOWED_NUMBER wajib diisi');
  if (cfg.times.some(s => !/^([01]\d|2[0-3]):[0-5]\d$/.test(s))) throw new Error('PROACTIVE_TIMES harus HH:MM');
  return cfg;
}
