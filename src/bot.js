import { buildPrompt, LIGHT_READING_VARIANT } from './persona.js';
import { toGeminiHistory } from './gemini.js';
import { incoming, allowed, mediaBuffer } from './whatsapp.js';
import { trainer } from './trainer.js';
import { arnelPronouns } from './voice.js';
import { localParts } from './scheduler.js';
import { extractImageRequest, safeImageContext } from './image-search.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rejectPattern = /\b(wah(?:h+)?[,.! ]|seru juga ya|tumben|sok tau|semangat ya|yang penting kamu|aku di sini kok|gpp santai aja|semoga)\b/i;
const therapistPattern = /\b(perasaan kamu valid|aku bangga sama kamu|itu wajar kok)\b/i;
const opening = reply => String(reply || '').trim().toLowerCase().match(/^(?:eh|wah|oh|oalah|wih)\b/u)?.[0] || '';
const assumptionFinish = reply => /\b(?:pasti|dikira|kayaknya)\b[\s\S]*\btapi\b[^.!?\n]{2,80}\bsih\s*[.!?]?\s*$/iu.test(String(reply || '').replace(/\|\|/g, ' '));
const tapiSih = reply => /\btapi\b[^.!?\n]{2,80}\bsih\s*[.!?]?\s*$/iu.test(String(reply || '').replace(/\|\|/g, ' '));
const lastAssistants = history => history.filter(x => x.role === 'assistant' && !x.media).slice(-2).map(x => x.content);
export const useLightReading = (chance, random = Math.random) => random() < chance;
export function styleIssue(reply, recent, userText, shortAnswer = false) {
  const prior = lastAssistants(recent);
  const previous = prior.at(-1) || '';
  if (rejectPattern.test(reply) || therapistPattern.test(reply)) return 'frasa template';
  if (shortAnswer && startsWithBareQuestion(reply)) return 'pertanyaan tanpa reaksi';
  if (previous && assumptionFinish(previous) && assumptionFinish(reply)) return 'rumus asumsi dan penutup berulang';
  if (previous && tapiSih(previous) && tapiSih(reply)) return 'penutup tapi sih berulang';
  if (prior.length === 2 && prior.every(x => opening(x) && opening(x) === opening(reply))) return 'pembuka berulang';
  if (prior.length === 2 && prior.every(x => /\?\s*$/.test(x.trim())) && /\?\s*$/.test(reply.trim())) return 'selalu menutup dengan pertanyaan';
  const userWords = String(userText || '').toLowerCase().match(/\p{L}+/gu) || [];
  const replyWords = String(reply || '').toLowerCase().replace(/^(?:eh|wah|oh|oalah|wih)\b[,.! ]*/u, '').match(/\p{L}+/gu) || [];
  if (userWords.length >= 3 && userWords.slice(0, 3).every((word, i) => replyWords[i] === word)) return 'mengulang kata user';
  return '';
}
export function isShortAnswerToQuestion(text, history) {
  const last = history.at(-1);
  const clean = String(text || '').trim();
  return last?.role === 'assistant' && /\?/.test(last.content) && clean.length > 0 && clean.length <= 65 && clean.split(/\s+/).length <= 8 && !/[?!]/.test(clean);
}
export function startsWithBareQuestion(reply) {
  const first = String(reply || '').trim().split(/\s*\|\|\s*|\n/u)[0].trim();
  const before = first.includes('?') ? first.slice(0, first.indexOf('?')) : first;
  if (/[.!]/.test(before)) return false;
  const lead = before.split(',')[0].trim();
  if (/^(?:serius|beneran|kok|kenapa|gimana|apa|apaan|emang|ngedit apaan|lagi apa)\b/i.test(lead)) return true;
  if (!first.includes('?')) return /^(?:\S+\s+){0,3}(?:apa|apaan|kenapa|gimana|kok)\b/i.test(lead);
  return !before.includes(',');
}
export function splitReply(text, max = 6) {
  return arnelPronouns(text).replace(/\p{Extended_Pictographic}/gu, '').split(/\s*\|\|\s*|\n{2,}/u).map(s => s.trim()).filter(Boolean).slice(0, max);
}
export class Bot {
  constructor({ config, logger, store, memory, relationship, life, story, style, gemini, imageSearch, wa, scheduler }) {
    Object.assign(this, { config, logger, store, memory, relationship, life, story, style, gemini, imageSearch, wa, scheduler });
    this.queues = new Map(); this.pending = new Map(); this.seen = new Set(); this.stopping = false;
  }
  lock(jid, job) {
    const prev = this.queues.get(jid) || Promise.resolve();
    const next = prev.catch(() => {}).then(job);
    this.queues.set(jid, next);
    next.finally(() => { if (this.queues.get(jid) === next) this.queues.delete(jid); }).catch(() => {});
    return next;
  }
  async ask(jid, text, media = null, options = {}) {
    const prompt = buildPrompt({ jid, query: text, memory: this.memory, relationship: this.relationship, life: this.life, story: this.story, style: this.style });
    const recent = this.memory.history(jid);
    const shortAnswer = !media && !options.proactive && isShortAnswerToQuestion(text, recent);
    const history = toGeminiHistory(recent);
    const lastTime = recent.at(-1)?.createdAt;
    const gapHours = lastTime ? (Date.now() - lastTime) / 3600000 : 0;
    const timing = !media && lastTime && gapHours >= 3 && gapHours <= 48 ? 'Ada jeda beberapa jam sejak chat terakhir. Boleh singgung dengan ringan bila terasa alami; jangan menuntut alasan user.' : 'Jangan berpura-pura ada jeda panjang jika percakapan sedang beruntun.';
    const lightReading = !media && !options.proactive && useLightReading(this.config.lightReadingChance ?? .035);
    const imageRule = !media && !options.proactive && this.imageSearch?.enabled
      ? '\nBila user jelas meminta contoh visual atau foto nyata sangat membantu memahami objek yang dibahas, boleh tambahkan satu baris terakhir: [[search_image: query foto yang spesifik]]. Jangan gunakan untuk basa-basi, orang, topik seksual/eksplisit, atau setiap balasan. Cari foto referensi, bukan mengaku itu foto pribadimu. Query harus menyebut objek sebenarnya, bukan instruksi. Teks balasan harus tetap masuk akal jika foto tidak ditemukan. Jangan letakkan penanda ini dalam bubble ||.'
      : '';
    const system = `${prompt}\n\n${timing}${shortAnswer ? '\nUser baru menjawab singkat pertanyaanmu. Mulai dengan komentar personal; tidak perlu memaksa pertanyaan lanjutan.' : ''}${lightReading ? `\n${LIGHT_READING_VARIANT}` : ''}${imageRule}`;
    const parts = [{ text: media ? `Tanggapi ${media.kind === 'image' ? 'foto' : 'sticker'} ini sesuai konteks. Jangan pakai emoji. Caption/konteks: ${text || '(tidak ada)'}` : text }];
    if (media) parts.push({ inlineData: { mimeType: media.mimeType, data: media.buffer.toString('base64') } });
    let result = await this.gemini.generate({ system, history, parts });
    const issue = !media && styleIssue(extractImageRequest(result).text, recent, text, shortAnswer);
    if (issue) {
      this.logger.info({ issue }, 'reply kena filter gaya; regenerasi satu kali');
      try {
        const retry = await this.gemini.generate({ system: `${system}\n\nBalasan barusan bermasalah: ${issue}. Tulis ulang dengan struktur lain yang alami, reaksi spesifik tanpa mengulang kata user. Tidak harus bertanya; jangan pakai penutup kesimpulan template.`, history, parts });
        if (retry.trim() && !styleIssue(extractImageRequest(retry).text, recent, text, shortAnswer)) result = retry;
      } catch (error) { this.logger.warn({ error: error.message }, 'regenerasi gagal, memakai balasan pertama'); }
    }
    if (shortAnswer && startsWithBareQuestion(extractImageRequest(result).text)) {
      // Bila model dua kali bertanya duluan, jangan memantulkan isi jawaban user sebagai fallback.
      result = 'oalahh';
    }
    this.logger.debug({ chatId: jid, flaggedPattern: rejectPattern.test(result) }, 'Gemini selesai');
    return result;
  }
  async send(jid, text, quoted = null, max = this.config.bubbles) {
    const parts = splitReply(text, max);
    if (!parts.length) throw new Error('balasan kosong setelah normalisasi');
    const sent = [];
    for (const [i, part] of parts.entries()) {
      try {
        await this.wa.socket.sendPresenceUpdate('composing', jid);
        await sleep(Math.min(400 + part.length * 18, 2200));
        await this.wa.socket.sendMessage(jid, { text: part }, i === 0 && quoted && Math.random() < this.config.quoteChance ? { quoted } : undefined);
        sent.push(part);
        if (i < parts.length - 1) await sleep(300);
      } catch (error) { error.sentParts = sent; throw error; }
    }
    await this.wa.socket.sendPresenceUpdate('paused', jid).catch(() => {});
    this.memory.addMessage(jid, 'assistant', sent.join(' || '));
    this.story.track(jid, sent.join(' || '), this.life.get().stage);
    return sent.join(' || ');
  }
  flush(jid) {
    const p = this.pending.get(jid);
    if (!p) return Promise.resolve();
    clearTimeout(p.timer); this.pending.delete(jid);
    return this.lock(jid, () => this.reply(p.message, jid, p.texts.join('\n'), null));
  }
  async onMessage(message) {
    if (this.stopping || !message.message || message.key?.fromMe || !allowed(message, this.config.allowedNumber)) return;
    const jid = message.key.remoteJid;
    const id = `${jid}/${message.key.id}`;
    if (this.seen.has(id)) return;
    this.seen.add(id); if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value);
    const info = incoming(message);
    if (!info.text && info.kind === 'text') return;
    this.scheduler.activity();
    if (info.kind === 'text' && /^!(good|teach|atur|aturan|ingat|ingatan|life|help)(?:\s|$)/i.test(info.rawText)) {
      await this.flush(jid);
      return this.lock(jid, async () => {
        const answer = await trainer(info.rawText, jid, this);
        if (answer) await this.wa.socket.sendMessage(jid, { text: answer.replace(/\s*\|\|\s*/g, '\n') });
      });
    }
    if (info.kind === 'text') {
      const p = this.pending.get(jid) || { texts: [], message };
      p.texts.push(info.text); p.message = message;
      clearTimeout(p.timer);
      p.timer = setTimeout(() => this.flush(jid).catch(error => this.logger.error({ error: error.message }, 'reply gagal')), this.config.debounceMs);
      this.pending.set(jid, p);
    } else {
      await this.flush(jid);
      return this.lock(jid, () => this.reply(message, jid, info.text, info));
    }
  }
  async reply(message, jid, text, info) {
    this.life.advance();
    let media = null;
    if (info?.media) {
      try {
        const buffer = await mediaBuffer(info.media, info.kind);
        media = { buffer, kind: info.kind, mimeType: info.media.mimetype || (info.kind === 'sticker' ? 'image/webp' : 'image/jpeg') };
      } catch (error) { this.logger.warn({ error: error.message }, 'media tidak dapat dibaca'); }
    }
    const input = info?.media ? `[${info.kind === 'image' ? 'foto' : 'sticker'}] ${text}` : text;
    let reply;
    try { reply = await this.ask(jid, media ? text : input, media); }
    catch (error) {
      if (!media || info.kind !== 'sticker' || !/HTTP 400|HTTP 415|mime|format/i.test(error.message)) throw error;
      this.logger.warn({ error: error.message }, 'format sticker tidak didukung model; balas tanpa melihat isinya');
      reply = await this.ask(jid, `${input}\nIsi sticker tidak dapat dilihat; jangan menebak gambarnya.`);
    }
    const imageRequest = extractImageRequest(reply);
    reply = imageRequest.text;
    let photo = null;
    if (imageRequest.query && this.imageSearch?.enabled && !info?.media && safeImageContext(input)) {
      try { photo = await this.imageSearch.search(imageRequest.query); }
      catch (error) { this.logger.warn({ error: error.message }, 'pencarian foto referensi gagal'); }
    }
    if (!photo && imageRequest.requested && (!reply || /\b(?:cari|carikan|kirim|kirimin|tunjuk|lihat)\b.{0,50}\b(?:foto|gambar)(?:nya)?\b|\b(?:foto|gambar)(?:nya)?\b.{0,50}\b(?:ini|nih|sebentar|bentar)\b/iu.test(reply))) {
      reply = 'belum nemu foto referensi yang pas';
    }
    // Simpan input setelah model berhasil, agar retry kegagalan tidak menggandakan histori.
    this.memory.addMessage(jid, 'user', input);
    this.relationship.interaction(jid, input);
    try { if (reply) await this.send(jid, reply, message); }
    catch (error) {
      if (error.sentParts?.length) {
        this.memory.addMessage(jid, 'assistant', error.sentParts.join(' || '));
        this.story.track(jid, error.sentParts.join(' || '), this.life.get().stage);
      }
      throw error;
    }
    if (photo) {
      try {
        await this.wa.socket.sendMessage(jid, { image: photo.buffer, caption: `foto referensi · ${photo.photographer} / Pexels\n${photo.url}` });
        this.memory.addMessage(jid, 'assistant', `[foto referensi: ${imageRequest.query}; sumber: Pexels]`, 'image');
      } catch (error) { this.logger.warn({ error: error.message }, 'foto referensi tidak terkirim'); }
    }
  }
  async proactive(jid, reason, context = {}) {
    const recent = this.memory.history(jid, 8).map(m => `${m.role === 'assistant' ? 'arnel' : 'user'}: ${m.content}`).join('\n');
    const { day, time } = localParts(new Date(context.now || Date.now()));
    const previous = (context.previous || []).slice(-30).map(text => `- ${text}`).join('\n');
    const request = `Mulai chat duluan (${reason}). Waktu nyata sekarang ${day} pukul ${time} (${process.env.TZ || 'Asia/Jakarta'}). Cocokkan ucapan tentang sekarang dengan waktu ini; kejadian lampau harus jelas waktunya. Jangan mengulang kisah lama seolah baru terjadi.\nBuat satu bubble yang utuh. Temukan sudut obrolan baru sesuai mood, fase hidup, dan konteks: bisa observasi lingkungan, hal receh, rasa penasaran, sesuatu yang mengingatkan pada obrolan user, atau kelanjutan cerita yang benar-benar punya perkembangan. Minat masak dan pendidikan bukan kewajiban di tiap pesan. Jangan selalu mengaitkan semuanya dengan masak atau biokimia. Jangan mengarang detail tentang user atau peristiwa besar hidup Arnel. Contoh gaya hanya acuan bahasa, bukan bahan cerita untuk disalin.\n${context.retry ? 'Draf sebelumnya terlalu mirip. Ganti gagasan dan tema, bukan sekadar sinonim.\n' : ''}Jangan ulang pesan-pesan berikut atau versi parafrasenya:\n${previous || '(belum ada)'}\nPercakapan terakhir:\n${recent || '(belum ada)'}`;
    return this.ask(jid, request, null, { proactive: true });
  }
  async shutdown() {
    this.stopping = true; this.scheduler.stop();
    const jobs = [...this.pending.keys()].map(jid => this.flush(jid));
    await Promise.allSettled(jobs);
    await Promise.allSettled([...this.queues.values()]);
    this.store.flush(); this.wa.stop();
  }
}
