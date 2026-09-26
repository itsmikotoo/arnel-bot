import pino from 'pino';
export const createLogger = level => pino({ level, redact: ['apiKey', 'authorization', 'key', 'qr', 'config.apiKey'], base: null });
