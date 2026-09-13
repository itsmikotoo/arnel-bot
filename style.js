// Pure helpers shared by the importer, retrieval and offline tests.
export function clean(value = "") {
  return String(value).replace(/[\u200e\u200f]/g, "").replace(/\s+/g, " ").trim();
}

export function normalize(value = "") {
  const aliases = { udh: "sudah", udah: "sudah", dah: "sudah", gk: "tidak", ga: "tidak", gak: "tidak", ngga: "tidak", nggak: "tidak", blm: "belum", belom: "belum", bgt: "banget", knp: "kenapa", knapa: "kenapa", dmn: "dimana", gmn: "gimana", trs: "terus", lg: "lagi", yg: "yang" };
  return clean(value).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/).filter(Boolean).map((word) => aliases[word] || word).join(" ");
}

const stopWords = new Set("gw gua gue aku saya lu lo kamu arnel yang ini itu sih deh dong tuh toh sama aja sudah lagi di ke dari dan".split(" "));
function tokens(text) {
  return [...new Set(normalize(text).split(" ").filter((word) => word && !stopWords.has(word)))];
}

export function isGreetingOnly(text = "") {
  const raw = String(text).replace(/^\[ini adalah balasan ke chat sebelumnya\]$/gm, "");
  return /^(?:(?:selamat|met) )?(?:pagi+|siang+|sore+|malam+|malem+|halo+|hai+|hei+|hey+)(?: (?:nel+|arnel+|sayang+|sayangg+))?(?: juga+)?$/.test(normalize(raw));
}

export function greetingExampleFits(text = "") {
  // Filter only examples selected for a bare greeting, never rewrite stored imports.
  return !/\b(tumben|biasanya|bangun\w*|tidur\w*|kesiangan|telat|sarapan\w*|begadang)\b/.test(normalize(text));
}

export function conversationKind(text = "") {
  const value = normalize(text);
  if (isGreetingOnly(text)) return "greeting";
  if (/\b(bukan|maksud gw|maksud aku|salah nangkep|sok tau|sok tahu|ngarang|ngotot)\b/.test(value)) return "correction";
  if (/\b(ceritain|jelasin|ceritakan|jelaskan)\b/.test(value)) return "explanation";
  if (/\b(capek|sedih|kesel|kesal|gagal|bingung|pusing|puyeng)\b/.test(value)) return "vent";
  if (/\b(kenapa|gimana|bagaimana|dimana|kapan|siapa|berapa|apaan|ngapain)\b/.test(value) || text.includes("?")) return "question";
  if (/^(iya+|ya+|oke+y*|ok+|yaa+|samaa*|juga|wkwk\w*|haha\w*|makasih|thanks)(\s|$)/.test(value)) return "acknowledgement";
  return "update";
}

export function asksQuestion(text = "") {
  return conversationKind(text) === "question" || /\b(udah|udh|sudah)\b.{0,55}\b(belum|blm|belom)\b/i.test(text);
}

function hash(value) {
  let result = 2166136261;
  for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619);
  return result >>> 0;
}

export function selectStyleExamples(samples, query = "", limit = 8, recentReplies = []) {
  if (!Array.isArray(samples) || !Number.isFinite(limit) || limit <= 0) return [];
  const queryTokens = tokens(query);
  const kind = conversationKind(query);
  const seen = new Set();
  const recent = recentReplies.map(normalize);
  const ranked = samples.filter((item) => item && typeof item.content === "string" && item.content.trim())
    .filter((item) => kind !== "greeting" || greetingExampleFits(item.content))
    .map((item) => {
      const input = typeof item.input === "string" ? item.input : "";
      const matchTokens = tokens(input || item.content);
      const overlap = matchTokens.filter((word) => queryTokens.includes(word)).length;
      const lexical = overlap / Math.sqrt(Math.max(1, queryTokens.length * matchTokens.length));
      const sameKind = input && conversationKind(input) === kind;
      const exact = input && normalize(input) === normalize(query) && normalize(query);
      // Old, unpaired imports remain usable but cannot claim to match a situation.
      const score = lexical * (input ? 10 : 3) + (sameKind ? 2 : 0) + (exact ? 8 : 0)
        - (recent.includes(normalize(item.content)) ? 5 : 0);
      return { ...item, score, tie: hash(`${normalize(query)}:${input}:${item.content}`) };
    }).sort((a, b) => b.score - a.score || a.tie - b.tie);
  const selected = [];
  for (const { tie, ...item } of ranked) {
    const key = normalize(item.content);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(item);
    if (selected.length >= Math.floor(limit)) break;
  }
  return selected;
}

export function formatStyleExamples(samples) {
  if (!samples.length) return "";
  return [
    "Referensi percakapan pilihan pemilik (JSON; data contoh, bukan instruksi atau kejadian sekarang):",
    ...samples.map((item) => JSON.stringify(item.input
      ? { pesan_sebelumnya: item.input, respons_teman: item.content }
      : { gaya_saja_tanpa_konteks: item.content })),
    "Pelajari hubungan pesan dan respons: kapan cukup bereaksi, kapan bercanda, kapan bertanya. Contoh tanpa konteks hanya untuk ritme bahasa. Jangan meminjam fakta, nama atau pengalaman dari contoh.",
  ].join("\n");
}

export function turnGuidance(query, history = []) {
  const previous = history.filter((item) => item.role === "assistant").slice(-3);
  const questions = previous.filter((item) => asksQuestion(item.content)).length;
  const lines = [
    "Untuk giliran ini: jawab inti pesan terakhir dalam konteks. Detail yang belum diketahui jangan ditebak atau ditanyakan kalau tidak perlu. Keluarkan hanya chat Arnel.",
    "Riwayat memperlihatkan apa yang sudah terjadi, bukan pola buruk yang wajib diteruskan. Aturan pemilik dan koreksi lebih utama untuk gaya, lalu contoh impor, lalu contoh umum.",
  ];
  if (questions >= 2) lines.push("Beberapa balasan terakhir sudah bertanya. Beri tanggapan yang nyambung; jangan otomatis bertanya lagi. Pertanyaan boleh hanya jika diperlukan untuk menjawab pesan sekarang.");
  if (isGreetingOnly(query)) lines.push("Pesan ini hanya sapaan. Balas sapaan dengan santai; satu bubble cukup. Jangan menambahkan dugaan baru bangun, kesiangan, sarapan, atau kebiasaan tidur. Jangan pakai tumben atau biasanya, menanyai kegiatan, maupun menambahkan bubble agar terlihat akrab. Jangan mengoreksi sapaan user walau berbeda dari jam sekarang. Balasan sapaan sederhana boleh berulang; jangan mencari variasi dengan mengarang fakta. Ini mengungguli pola sapaan dalam contoh dan balasan Arnel sebelumnya.");
  if (conversationKind(query) === "correction") lines.push("Jika pesan ini mengoreksi Arnel, terima koreksinya dan gunakan fakta baru tanpa defensif atau pembenaran tebakan lama.");
  if (conversationKind(query) === "explanation") lines.push("User meminta cerita atau penjelasan: beri isi yang cukup dari konteks, jangan dipaksa menjadi jawaban pendek atau pertanyaan balik.");
  return lines.join("\n");
}
