import path from 'node:path';
import makeWASocket, { Browsers, DisconnectReason, downloadContentFromMessage, makeCacheableSignalKeyStore, useMultiFileAuthState } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';

export function unwrap(content) {
  let current = content || {};
  for (let i = 0; i < 4; i++) {
    current = current.ephemeralMessage?.message || current.viewOnceMessage?.message || current.viewOnceMessageV2?.message || current.documentWithCaptionMessage?.message || current;
  }
  return current;
}
export function incoming(message) {
  const c = unwrap(message.message);
  const kind = c.imageMessage ? 'image' : c.stickerMessage ? 'sticker' : 'text';
  const media = c.imageMessage || c.stickerMessage;
  const text = (c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption || '').trim();
  const context = c.extendedTextMessage?.contextInfo || media?.contextInfo || {};
  const hints = [];
  if (context.isForwarded || context.forwardingScore) hints.push('[diteruskan dari chat lain]');
  if (context.quotedMessage) {
    const quoted = unwrap(context.quotedMessage);
    hints.push(`[membalas pesan: ${(quoted.conversation || quoted.extendedTextMessage?.text || quoted.imageMessage?.caption || '[media]').slice(0, 240)}]`);
  }
  return { text: [text, ...hints].filter(Boolean).join('\n'), rawText: text, kind, media };
}
export async function mediaBuffer(media, kind, limit = 5 * 1024 * 1024) {
  const stream = await downloadContentFromMessage(media, kind);
  const chunks = []; let size = 0;
  for await (const chunk of stream) { size += chunk.length; if (size > limit) throw new Error('media lebih besar dari 5 MB'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
export class WhatsApp {
  constructor({ config, logger, onMessage, onOpen, onClose }) {
    Object.assign(this, { config, logger, onMessage, onOpen, onClose });
    this.socket = null; this.timer = null; this.stopped = false; this.connecting = false; this.failures = 0;
  }
  async start() {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    try {
      const { state, saveCreds } = await useMultiFileAuthState(path.join(this.config.dataDir, 'baileys_auth'));
      const sock = makeWASocket({ auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, this.logger) }, logger: this.logger, browser: Browsers.macOS('Desktop'), markOnlineOnConnect: false, syncFullHistory: false, getMessage: async () => undefined });
      this.socket = sock;
      sock.ev.on('creds.update', () => saveCreds().catch(e => this.logger.error({ error: e.message }, 'gagal simpan kredensial')));
      sock.ev.on('messages.upsert', ({ messages, type }) => { if (type !== 'notify' || this.config.connectionOnly || sock !== this.socket) return; for (const m of messages) this.onMessage(m).catch(e => this.logger.error({ error: e.message }, 'pesan gagal')); });
      sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (sock !== this.socket || this.stopped) return;
        if (qr) { this.logger.info('scan QR: WhatsApp > Perangkat tertaut > Tautkan perangkat'); qrcode.generate(qr, { small: true }); }
        if (connection === 'open') { this.failures = 0; this.logger.info({ connectionOnly: this.config.connectionOnly }, 'WhatsApp terhubung'); this.onOpen?.(); }
        if (connection === 'close') {
          this.onClose?.();
          const code = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
          this.logger.warn({ code, error: lastDisconnect?.error?.message }, 'WhatsApp terputus');
          if (code === DisconnectReason.loggedOut || code === 401) {
            this.logger.error('session logout; backup data, lalu hapus hanya data/baileys_auth untuk QR baru');
            this.stopped = true;
            sock.end?.(new Error('logged out'));
            process.exitCode = 10;
            return;
          }
          const delay = code === DisconnectReason.restartRequired ? 1000 : Math.min(60000, 3000 * 2 ** Math.min(this.failures++, 4));
          clearTimeout(this.timer);
          this.timer = setTimeout(() => this.start(), delay);
        }
      });
    } catch (error) {
      this.logger.error({ error: error.message }, 'start WhatsApp gagal');
      this.timer = setTimeout(() => this.start(), 5000);
    } finally { this.connecting = false; }
  }
  async target() {
    const [result] = await this.socket.onWhatsApp(`${this.config.allowedNumber}@s.whatsapp.net`);
    if (!result?.exists) throw new Error('ALLOWED_NUMBER tidak ditemukan');
    return result.jid;
  }
  stop() { this.stopped = true; clearTimeout(this.timer); this.socket?.end?.(new Error('shutdown')); }
}
export function allowed(message, number) {
  const jid = message.key?.remoteJid || '';
  if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') return false;
  if (!number) return false;
  return [jid, message.key.remoteJidAlt, message.key.participant, message.key.participantAlt].filter(Boolean).some(x => x.split('@')[0].split(':')[0].replace(/\D/g, '') === number);
}
