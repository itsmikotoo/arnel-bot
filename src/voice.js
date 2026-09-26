// Migrasi contoh v2 boleh menyimpan variasi pronoun. Pertahankan ritmenya,
// tetapi pastikan suara Arnel yang keluar selalu aku/kamu.
export function arnelPronouns(text) {
  return String(text).replace(/\b(gw|gue|gua|gwe|lu|lo|elu|elo|loe)\b/gi, word => {
    const replacement = /^(gw|gue|gua|gwe)$/i.test(word) ? 'aku' : 'kamu';
    return /^[A-Z]/.test(word) ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
  });
}
