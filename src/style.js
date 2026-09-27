import { relevant } from './memory.js';
import { arnelPronouns } from './voice.js';
// Corpus evidence, not a hardcoded dictionary of regional slang.
export function languageProfile(samples) {
  const texts = samples.map(x => arnelPronouns(x.output || x.content || '').trim()).filter(Boolean);
  if (!texts.length) return null;
  const counts = new Map();
  let lower = 0, bare = 0, totalWords = 0;
  for (const text of texts) {
    const words = text.toLowerCase().match(/\p{L}+/gu) || [];
    totalWords += words.length;
    if (text === text.toLowerCase()) lower++;
    if (!/[.!?…]$/.test(text)) bare++;
    for (const word of new Set(words)) {
      if (word.length >= 2 && word.length <= 24) counts.set(word, (counts.get(word) || 0) + 1);
    }
  }
  const frequent = [...counts].filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1]).slice(0, 32);
  // Spread evidence across old/new samples, independently of the current topic.
  const size = Math.min(6, texts.length);
  const evidence = Array.from({ length: size }, (_, i) => texts[Math.floor(i * (texts.length - 1) / Math.max(1, size - 1))].slice(0, 180));
  return { count: texts.length, lowercasePercent: Math.round(lower / texts.length * 100), bareEndingPercent: Math.round(bare / texts.length * 100), meanWords: Math.round(totalWords / texts.length), frequent, evidence };
}
export class Style {
  constructor(store) { this.store = store; }
  count() { return (this.store.read('style_examples', { samples: [] }).samples || []).length; }
  languageContext() {
    const data = this.store.read('style_examples', { samples: [] });
    if (this.profileSource !== data) {
      this.profileSource = data;
      this.profile = languageProfile(data.samples || []);
    }
    if (!this.profile) return '';
    return 'Bukti kebiasaan penulisan dari pesan pengirim target saja (bukan pesan lawan bicaranya):\n' + JSON.stringify(this.profile)
      + '\nfrequent menghitung jumlah pesan yang memuat bentuk tersebut, bukan daftar kata wajib. Tentukan dari bukti mana yang singkatan, partikel, atau ejaan personal; kata topik/nama bukan kebiasaan bahasa. evidence hanya contoh penulisan, jangan salin isi atau jadikan frasa tetap. Statistik adalah kecenderungan, bukan kuota. Sampel sedikit berarti bukti lemah; jangan mengarang dialek.';
  }
  examples(query, limit = 8) {
    const samples = this.store.read('style_examples', { samples: [] }).samples || [];
    const recent = samples.slice(-Math.ceil(limit / 2));
    const matched = relevant(samples.filter(x => !recent.includes(x)), query, Math.floor(limit / 2));
    return [...matched, ...recent].slice(-limit);
  }
}
