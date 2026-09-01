import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const DB_FILE = path.join(DATA_DIR, "chat_history.json");
const TRAINING_FILE = path.join(DATA_DIR, "training_examples.json");
const RELATIONSHIP_FILE = path.join(DATA_DIR, "relationship_state.json");
const MEMORY_FILE = path.join(DATA_DIR, "memories.json");
const RULES_FILE = path.join(DATA_DIR, "behavior_rules.json");
const ARNEL_STORIES_FILE = path.join(DATA_DIR, "arnel_story_notes.json");
const STYLE_EXAMPLES_FILE = path.join(DATA_DIR, "style_examples.json");
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  const tempFile = `${file}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
  fs.renameSync(tempFile, file);
}

function loadAll() {
  return loadJson(DB_FILE, {});
}

function saveAll(data) {
  saveJson(DB_FILE, data);
}

export function saveMessage(chatId, role, content) {
  const data = loadAll();
  data[chatId] ||= [];
  data[chatId].push({ role, content, createdAt: Date.now() });
  data[chatId] = data[chatId].slice(-200);
  saveAll(data);
}

export function getHistory(chatId, limit = 20) {
  return (loadAll()[chatId] || []).slice(-limit);
}

export function getLastExchange(chatId) {
  const history = loadAll()[chatId] || [];
  for (let assistantIndex = history.length - 1; assistantIndex >= 0; assistantIndex -= 1) {
    if (history[assistantIndex].role !== "assistant") continue;
    for (let userIndex = assistantIndex - 1; userIndex >= 0; userIndex -= 1) {
      if (history[userIndex].role === "user") {
        return {
          input: history[userIndex].content,
          output: history[assistantIndex].content,
        };
      }
    }
  }
  return null;
}

export function replaceLastAssistant(chatId, content) {
  const data = loadAll();
  const history = data[chatId] || [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].role === "assistant") {
      history[index] = { ...history[index], content, correctedAt: Date.now() };
      saveAll(data);
      return true;
    }
  }
  return false;
}

function words(value = "") {
  return [...new Set(
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2),
  )];
}

export function saveTrainingExample(chatId, input, output, source = "teach") {
  const examples = loadJson(TRAINING_FILE, []);
  const normalizedInput = input.trim().toLowerCase();
  const normalizedOutput = output.trim().toLowerCase();
  const existing = examples.find(
    (item) =>
      item.chatId === chatId &&
      item.input.trim().toLowerCase() === normalizedInput &&
      item.output.trim().toLowerCase() === normalizedOutput,
  );

  if (existing) {
    existing.uses = (existing.uses || 1) + 1;
    existing.updatedAt = Date.now();
    existing.source = source === "teach" ? "teach" : existing.source;
  } else {
    examples.push({
      chatId,
      input: input.trim(),
      output: output.trim(),
      source,
      uses: 1,
      createdAt: Date.now(),
    });
  }

  saveJson(TRAINING_FILE, examples.slice(-500));
}

export function getRelevantExamples(chatId, query, limit = 6) {
  const queryWords = words(query);
  const examples = loadJson(TRAINING_FILE, []).filter((item) => item.chatId === chatId);

  return examples
    .map((item) => {
      const inputWords = words(item.input);
      const overlap = inputWords.filter((word) => queryWords.includes(word)).length;
      const exactBonus =
        query.trim() && (
          item.input.toLowerCase().includes(query.toLowerCase()) ||
          query.toLowerCase().includes(item.input.toLowerCase())
        )
          ? 4
          : 0;
      const teachBonus = item.source === "teach" ? 1 : 0;
      return { ...item, score: overlap * 2 + exactBonus + teachBonus };
    })
    .sort((a, b) => b.score - a.score || (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, limit);
}

export function getRelevantStyleExamples(query = "", limit = 8) {
  const samples = loadJson(STYLE_EXAMPLES_FILE, {}).samples || [];
  const queryWords = words(query);

  return samples
    .map((item, index) => {
      const overlap = words(item.content).filter((word) => queryWords.includes(word)).length;
      return { ...item, score: overlap * 3 + index * 0.001 };
    })
    .sort((a, b) => b.score - a.score || (b.importedAt || 0) - (a.importedAt || 0))
    .slice(0, limit);
}

function relationshipStage(closeness) {
  if (closeness >= 75) return "sangat dekat";
  if (closeness >= 50) return "dekat";
  if (closeness >= 30) return "sudah akrab";
  return "masih membangun kedekatan";
}

const MOODS = ["hangat", "iseng", "manja", "tenang"];

function moodFor(interactions) {
  return MOODS[Math.floor(interactions / 14) % MOODS.length];
}

function nextMood(state) {
  const current = state.mood || "hangat";
  const start = (state.interactions + (state.moodSeed || 0)) % MOODS.length;
  for (let offset = 0; offset < MOODS.length; offset += 1) {
    const candidate = MOODS[(start + offset) % MOODS.length];
    if (candidate !== current) return candidate;
  }
  return current;
}

function chatHabit(state) {
  const samples = state.messageLengths || [];
  if (!samples.length) return "belum cukup kebaca";
  const average = samples.reduce((total, value) => total + value, 0) / samples.length;
  if (average <= 22) return "cenderung singkat dan cepat";
  if (average >= 85) return "sering cerita cukup detail";
  return "campuran santai kadang singkat kadang cerita";
}

export function recordInteraction(chatId, text = "") {
  const states = loadJson(RELATIONSHIP_FILE, {});
  const state = states[chatId] || {
    closeness: 20,
    interactions: 0,
    goodCount: 0,
    taughtCount: 0,
    mood: "hangat",
    moodSeed: Math.floor(Math.random() * 1000),
    moodShiftAt: 14,
    messageLengths: [],
  };

  state.interactions += 1;
  if (state.interactions % 12 === 0) state.closeness = Math.min(100, state.closeness + 1);

  const cleanText = text.replace(/^\[[^\]]+\]\s*/, "").trim();
  if (cleanText) {
    state.messageLengths ||= [];
    state.messageLengths.push(cleanText.length);
    state.messageLengths = state.messageLengths.slice(-30);
  }

  state.mood ||= "hangat";
  state.moodSeed ||= Math.floor(Math.random() * 1000);
  state.moodShiftAt ||= 14;
  if (state.interactions >= state.moodShiftAt) {
    state.mood = nextMood(state);
    state.moodShiftAt = state.interactions + 12 + (state.moodSeed % 9);
  }

  state.updatedAt = Date.now();
  states[chatId] = state;
  saveJson(RELATIONSHIP_FILE, states);
  return state;
}

export function recordFeedback(chatId, type) {
  const states = loadJson(RELATIONSHIP_FILE, {});
  const state = states[chatId] || {
    closeness: 20,
    interactions: 0,
    goodCount: 0,
    taughtCount: 0,
  };

  if (type === "good") {
    state.goodCount += 1;
    state.closeness = Math.min(100, state.closeness + 2);
  } else {
    state.taughtCount += 1;
    state.closeness = Math.min(100, state.closeness + 1);
  }

  state.mood = moodFor(state.interactions);
  state.updatedAt = Date.now();
  states[chatId] = state;
  saveJson(RELATIONSHIP_FILE, states);
  return state;
}

export function getRelationshipContext(chatId) {
  const state = loadJson(RELATIONSHIP_FILE, {})[chatId] || {
    closeness: 20,
    interactions: 0,
    goodCount: 0,
    taughtCount: 0,
    mood: "hangat",
  };

  return [
    `tingkat hubungan: ${relationshipStage(state.closeness)} (${state.closeness}/100)`,
    `mood arnel saat ini: ${state.mood || moodFor(state.interactions)}`,
    `gaya chat lawan bicara belakangan: ${chatHabit(state)}`,
    `jumlah interaksi tersimpan: ${state.interactions}`,
    "mood berubah pelan setelah banyak interaksi jadi jangan berganti karakter mendadak",
    "sesuaikan keakraban secara bertahap jangan mendadak posesif atau terlalu romantis",
  ].join("\n");
}


export function saveMemory(chatId, content) {
  const data = loadJson(MEMORY_FILE, {});
  data[chatId] ||= [];
  const cleanContent = content.trim().replace(/\s+/g, " ");
  const normalized = cleanContent.toLowerCase();
  const existing = data[chatId].find((item) => item.content.toLowerCase() === normalized);

  if (existing) {
    existing.updatedAt = Date.now();
    existing.uses = (existing.uses || 1) + 1;
  } else {
    data[chatId].push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      content: cleanContent,
      uses: 1,
      createdAt: Date.now(),
    });
    data[chatId] = data[chatId].slice(-60);
  }

  saveJson(MEMORY_FILE, data);
}

export function getRelevantMemories(chatId, query = "", limit = 6) {
  const memories = loadJson(MEMORY_FILE, {})[chatId] || [];
  const queryWords = words(query);

  return memories
    .map((item) => {
      const overlap = words(item.content).filter((word) => queryWords.includes(word)).length;
      return { ...item, score: overlap * 3 + Math.min(item.uses || 0, 3) * 0.2 };
    })
    .sort((a, b) => b.score - a.score || (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
    .slice(0, limit);
}

export function saveBehaviorRule(chatId, content) {
  const data = loadJson(RULES_FILE, {});
  data[chatId] ||= [];
  const rule = content.trim().replace(/\s+/g, " ");
  const normalized = rule.toLowerCase();
  const existing = data[chatId].find((item) => item.content.toLowerCase() === normalized);

  if (existing) {
    existing.updatedAt = Date.now();
  } else {
    data[chatId].push({ content: rule, createdAt: Date.now() });
    data[chatId] = data[chatId].slice(-40);
  }

  saveJson(RULES_FILE, data);
}

export function getBehaviorRules(chatId, limit = 12) {
  return (loadJson(RULES_FILE, {})[chatId] || [])
    .slice(-limit)
    .map((item) => item.content);
}

export function saveArnelStory(chatId, content) {
  const cleanContent = content.replace(/\|\|/g, " ").replace(/\s+/g, " ").trim();
  const soundsPersonal = /\b(gw|aku)\b/i.test(cleanContent);
  const hasStorySignal = /\b(lagi|abis|tadi|baru|mau|pengen|besok|nanti|udah|belom)\b/i.test(cleanContent);
  if (cleanContent.length < 20 || !soundsPersonal || !hasStorySignal) return;

  const data = loadJson(ARNEL_STORIES_FILE, {});
  data[chatId] ||= [];
  const normalized = cleanContent.toLowerCase();
  const existing = data[chatId].find((item) => item.content.toLowerCase() === normalized);

  if (existing) {
    existing.updatedAt = Date.now();
    existing.uses = (existing.uses || 1) + 1;
  } else {
    data[chatId].push({
      content: cleanContent,
      createdAt: Date.now(),
      uses: 1,
    });
    data[chatId] = data[chatId].slice(-80);
  }

  saveJson(ARNEL_STORIES_FILE, data);
}

export function getRelevantArnelStories(chatId, query = "", limit = 6) {
  const queryWords = words(query);
  const stories = loadJson(ARNEL_STORIES_FILE, {})[chatId] || [];

  return stories
    .map((item) => {
      const overlap = words(item.content).filter((word) => queryWords.includes(word)).length;
      return { ...item, score: overlap * 3 + Math.min(item.uses || 0, 3) * 0.1 };
    })
    .sort((a, b) => b.score - a.score || (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, limit);
}
