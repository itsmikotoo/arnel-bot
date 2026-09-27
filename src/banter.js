// Conservative surface cues, not a semantic judgment about whether Arnel "won".
export function rhetoricalCounter(text) {
  return String(text || '').split(/\|\||[.!?\n]/).some(clause =>
    /\b(?:kurang|maunya|emang|emangnya|memang)\b.{0,85}\b(?:apa|berapa(?:an)?|siapa|gimana|mana)\b.{0,65}\b(?:coba|emang|sih|sampai|sampe|puas)\b/i.test(clause)
    || /\b(?:siapa|apa)\b.{0,30}\b(?:yang bilang|kamu kira|kata kamu)\b/i.test(clause));
}
export const analogy = text => /\b(?:kayak|kek|seperti|ibarat|serasa)\s+\S|\bkaya\s+(?!(?:raya|akan)\b)\S/iu.test(String(text || ''));
export const gotchaPhrase = text => /\b(?:nah+|tuh+)\b[\s,.!…-]*\bkan+\b/iu.test(String(text || ''));
export const hasGotchaHistory = history => history.some(m => m.role === 'assistant' && !m.media && gotchaPhrase(m.content));
export function ungroundedSocialRoast(reply, history, userText) {
  const references = String(reply || '').toLowerCase().match(/\b(?:jaksel|senopati|anak skena|anak tongkrongan|orang kaya|orang miskin|kaum elit|social climber)\b/gi) || [];
  if (!references.length || !/\b(?:kamu|gayamu|gayanya|ngirim|sok|dasar|dih|kayak|kek)\b/i.test(reply)) return false;
  // An earlier invention by Arnel is not evidence about the user.
  const context = [userText, ...history.filter(m => m.role === 'user').slice(-10).map(m => m.content)].join(' ').toLowerCase();
  return references.some(reference => !context.includes(reference));
}
export function banterIssue(reply, history, userText, now = Date.now(), phraseHistory = history) {
  // Persistent rolling history, without the short session cutoff used for banter.
  if (gotchaPhrase(reply) && hasGotchaHistory(phraseHistory)) return 'frasa gotcha berulang lintas sesi; hilangkan framing menangkap pengakuan user, ubah fungsi reaksi tanpa mengganti dengan sinonim gotcha';
  if (ungroundedSocialRoast(reply, history, userText)) return 'roasting memakai stereotip sosial tanpa konteks user; tanggapi aksi atau media yang nyata secara ringan';
  const recent = history.filter(m => m.role === 'assistant' && !m.media && (!m.createdAt || now - m.createdAt < 30 * 60000)).slice(-3);
  if (recent.length && rhetoricalCounter(reply) && rhetoricalCounter(recent.at(-1).content)) {
    return 'counter retoris berulang; ubah fungsi respons, boleh menerima godaan tanpa membalas tantangan';
  }
  const asksComparison = /\b(?:bentuk|mirip|perbandingan|bandingkan|bandingin|bedanya|seperti apa|kayak apa|contoh)\b/i.test(userText);
  if (!asksComparison && analogy(reply) && recent.filter(m => analogy(m.content)).length >= 2) {
    return 'perumpamaan berulang; gunakan reaksi langsung tanpa analogi atau punchline yang dipaksakan';
  }
  return '';
}
