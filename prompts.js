import { SYSTEM_PROMPT } from "./persona.js";
import { formatStyleExamples, turnGuidance } from "./style.js";
import {
  getHistory, getRelationshipContext, getBehaviorRules, getRelevantArnelStories,
  getRelevantStyleExamples, getRelevantMemories, getRelevantExamples,
} from "./db.js";

export function buildSystemInstruction(chatId, query = "", { proactive = false } = {}) {
  const relationship = getRelationshipContext(chatId);
  const rules = getBehaviorRules(chatId);
  const arnelStories = proactive ? [] : getRelevantArnelStories(chatId, query, 6);
  const recentHistory = getHistory(chatId, 8);
  const recentReplies = recentHistory.filter((item) => item.role === "assistant").map((item) => item.content);
  const styleExamples = getRelevantStyleExamples(query, 8, recentReplies);
  const memories = getRelevantMemories(chatId, query, 6);
  const examples = getRelevantExamples(chatId, query, 6);
  const memoryContext = memories.length
    ? [
        "Hal yang Arnel ingat tentang lawan bicara:",
        ...memories.map((item) => `- ${item.content}`),
        "Gunakan hanya bila relevan dan natural. Jangan bilang bahwa ini disimpan sebagai memori.",
      ].join("\n")
    : "Belum ada memori khusus.";

  const learnedExamples = examples.length
    ? [
        "Contoh jawaban yang sudah disukai atau dikoreksi pemilik:",
        ...examples.map((item) => `user: ${item.input}\narnel: ${item.output}`),
        "Ikuti pola dan nuansanya jika situasinya relevan jangan menyalin secara buta.",
      ].join("\n")
    : "Belum ada contoh hasil latihan yang relevan.";

  const humanStyleExamples = formatStyleExamples(styleExamples);

  const behaviorRules = rules.length
    ? [
        "Aturan gaya permanen dari pemilik:",
        ...rules.map((rule) => `- ${rule}`),
        "Patuhi aturan ini selama tetap aman dan natural.",
      ].join("\n")
    : "Belum ada aturan gaya khusus.";

  const storyContinuity = arnelStories.length
    ? [
        "Hal yang pernah Arnel ceritakan sebelumnya:",
        ...arnelStories.map((item) => `- ${item.content}`),
        "Jaga kesinambungannya. Jika relevan boleh menyinggungnya. Jangan menebak kelanjutan atau detail yang belum ada; kalau tidak tahu, tidak perlu pura pura ingat.",
      ].join("\n")
    : proactive ? "Untuk inisiatif, gunakan riwayat bertimestamp dalam permintaan. Jangan menghidupkan kembali catatan cerita lama sebagai rencana yang masih berlangsung." : "Belum ada cerita Arnel yang perlu dilanjutkan.";

  const stylePriority = styleExamples.length
    ? "Prioritas akhir: contoh gaya chat manusia di atas lebih penting daripada kecenderungan jawaban asisten yang rapi. Jawab seperti chat spontan, jangan membuat rentetan pertanyaan atau kalimat basa basi."
    : "";

  return [
    SYSTEM_PROMPT,
    "",
    "Konteks perkembangan hubungan:",
    relationship,
    "",
    memoryContext,
    "",
    learnedExamples,
    "",
    humanStyleExamples,
    "",
    behaviorRules,
    "",
    storyContinuity,
    "",
    stylePriority,
    turnGuidance(query, recentHistory),
    "Ketentuan sapaan Arnel: selalu aku–kamu untuk ucapan sendiri, termasuk chat duluan dan tanggapan foto. Ini mengungguli kata ganti dalam contoh impor, hasil !teach, aturan lama dan riwayat. Ambil ritme serta cara meresponsnya saja; jangan ikut memakai gw/gue/gua atau lu/lo/elu/elo. Tidak perlu memaksakan kata ganti jika kalimat sudah jelas. Kutipan pesan orang lain tidak perlu diubah.",
  ].join("\n");
}

