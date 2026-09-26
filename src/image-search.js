const blocked = /\b(?:porn|porno|bokep|nude|naked|nudity|sex|seks|sexual|seksual|erotic|erotis|nsfw|fetish|genital|telanjang|bugil|sange|mesum)\b/iu;
const people = /\b(?:person|people|woman|man|girl|boy|cewek|cowok|orang)\b/iu;
const dayInJakarta = now => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = type => parts.find(p => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
};
export function safeQuery(value) {
  const query = String(value || '').replace(/[\r\n\[\]<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return query && query.length <= 100 && !blocked.test(query) && !people.test(query) ? query : '';
}
export const safeImageContext = text => !blocked.test(String(text || ''));
export function extractImageRequest(value) {
  const text = String(value || '');
  const marker = /\[\[\s*search_image\s*:\s*([^\]\r\n]{1,120})\]\]/giu;
  const matches = [...text.matchAll(marker)];
  const clean = text.replace(marker, '').replace(/\[\[\s*search_image\s*:[^\r\n]*$/iu, '').replace(/\s*\|\|\s*$/u, '').trim();
  return { text: clean, query: matches.length ? safeQuery(matches.at(-1)[1]) : '', requested: /\[\[\s*search_image\s*:/iu.test(text) };
}
const relevantWords = text => new Set(String(text).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
export function selectPhoto(photos, query) {
  const words = relevantWords(query);
  const candidates = (photos || []).slice(0, 5).filter(photo => {
    try {
      const image = new URL(photo.src?.medium || '');
      const page = new URL(photo.url || '');
      return image.protocol === 'https:' && image.hostname === 'images.pexels.com' && page.protocol === 'https:' && page.hostname === 'www.pexels.com' && !blocked.test(photo.alt || '') && !blocked.test(photo.photographer || '');
    } catch { return false; }
  });
  const ranked = candidates.map(photo => ({ photo, score: [...words].filter(word => relevantWords(photo.alt || '').has(word)).length }));
  ranked.sort((a, b) => b.score - a.score);
  return ranked[0]?.score > 0 ? ranked[0].photo : null;
}
export class ImageSearch {
  constructor(config, store, logger, fetchFn = fetch, clock = () => Date.now()) {
    Object.assign(this, { config, store, logger, fetch: fetchFn, clock });
  }
  get enabled() { return Boolean(this.config.imageSearchKey && this.config.imageDailyMax); }
  reserve(retry = false) {
    const now = this.clock(), day = dayInJakarta(now);
    const state = this.store.read('image_search_limits', { day, count: 0, lastAt: 0 });
    if (state.day === day && state.count >= this.config.imageDailyMax) return false;
    if (!retry && now - state.lastAt < this.config.imageGapMinutes * 60000) return false;
    this.store.write('image_search_limits', { day, count: state.day === day ? state.count + 1 : 1, lastAt: now });
    return true;
  }
  async download(url) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.hostname !== 'images.pexels.com') throw new Error('host gambar ditolak');
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await this.downloadOnce(url); }
      catch (error) {
        if (attempt || !(['TimeoutError', 'TypeError'].includes(error.name) || /HTTP gambar (?:408|429|5\d\d)/.test(error.message))) throw error;
        await new Promise(resolve => setTimeout(resolve, 400));
      }
    }
  }
  async downloadOnce(url) {
    const response = await this.fetch(url, { redirect: 'error', signal: AbortSignal.timeout(this.config.imageTimeoutMs) });
    if (!response.ok) throw new Error(`HTTP gambar ${response.status}`);
    if (!/^image\/(?:jpeg|png)$/i.test(response.headers.get('content-type')?.split(';')[0] || '')) throw new Error('format gambar ditolak');
    const max = 5 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > max) throw new Error('gambar terlalu besar');
    const chunks = [], reader = response.body.getReader();
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) throw new Error('gambar terlalu besar');
        chunks.push(value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    if (!size) throw new Error('gambar kosong');
    return Buffer.concat(chunks, size);
  }
  async search(rawQuery) {
    const query = safeQuery(rawQuery);
    if (!this.enabled || !query || !this.reserve()) return null;
    const url = `https://api.pexels.com/v1/search?${new URLSearchParams({ query, per_page: '5' })}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.fetch(url, { headers: { Authorization: this.config.imageSearchKey }, redirect: 'error', signal: AbortSignal.timeout(this.config.imageTimeoutMs) });
        if ([408, 500, 502, 503, 504].includes(response.status) && attempt === 0 && this.reserve(true)) { await new Promise(resolve => setTimeout(resolve, 400)); continue; }
        if (!response.ok) throw new Error(`Pexels HTTP ${response.status}`);
        const photo = selectPhoto((await response.json()).photos, query);
        if (!photo) return null;
        return { buffer: await this.download(photo.src.medium), photographer: String(photo.photographer || 'Pexels').slice(0, 80), url: photo.url };
      } catch (error) {
        if (attempt === 0 && ['TimeoutError', 'TypeError'].includes(error.name) && this.reserve(true)) { await new Promise(resolve => setTimeout(resolve, 400)); continue; }
        this.logger.warn({ error: error.message }, 'pencarian foto gagal');
        return null;
      }
    }
    return null;
  }
}
