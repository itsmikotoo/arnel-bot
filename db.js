import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const SQLITE_FILE = path.join(DATA_DIR, "arnel.sqlite3");
const LEGACY_FILES = {
  history: path.join(DATA_DIR, "chat_history.json"),
  training: path.join(DATA_DIR, "training_examples.json"),
  relationship: path.join(DATA_DIR, "relationship_state.json"),
  memory: path.join(DATA_DIR, "memories.json"),
};

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(SQLITE_FILE);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    corrected_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_messages_chat_id_id ON messages(chat_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);

  CREATE TABLE IF NOT EXISTS training_examples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    input TEXT NOT NULL,
    output TEXT NOT NULL,
    input_norm TEXT NOT NULL,
    output_norm TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'teach',
    uses INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER,
    UNIQUE(chat_id, input_norm, output_norm)
  );
  CREATE INDEX IF NOT EXISTS idx_training_chat ON training_examples(chat_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS relationships (
    chat_id TEXT PRIMARY KEY,
    closeness INTEGER NOT NULL DEFAULT 20,
    interactions INTEGER NOT NULL DEFAULT 0,
    good_count INTEGER NOT NULL DEFAULT 0,
    taught_count INTEGER NOT NULL DEFAULT 0,
    mood TEXT NOT NULL DEFAULT 'hangat',
    mood_seed INTEGER NOT NULL DEFAULT 0,
    mood_shift_at INTEGER NOT NULL DEFAULT 14,
    message_lengths_json TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    content TEXT NOT NULL,
    content_norm TEXT NOT NULL,
    uses INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER,
    UNIQUE(chat_id, content_norm)
  );
  CREATE INDEX IF NOT EXISTS idx_memories_chat ON memories(chat_id, COALESCE(updated_at, created_at) DESC);
`);

function readLegacyJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function migrateLegacyJsonOnce() {
  const migrated = db.prepare("SELECT value FROM meta WHERE key = ?").get("legacy_json_migrated_v1");
  if (migrated) return;

  const history = readLegacyJson(LEGACY_FILES.history, {});
  const training = readLegacyJson(LEGACY_FILES.training, []);
  const relationships = readLegacyJson(LEGACY_FILES.relationship, {});
  const memories = readLegacyJson(LEGACY_FILES.memory, {});

  const insertMessage = db.prepare(`
    INSERT INTO messages(chat_id, role, content, created_at, corrected_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertTraining = db.prepare(`
    INSERT OR IGNORE INTO training_examples
      (chat_id, input, output, input_norm, output_norm, source, uses, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertRelationship = db.prepare(`
    INSERT OR REPLACE INTO relationships
      (chat_id, closeness, interactions, good_count, taught_count, mood, mood_seed, mood_shift_at, message_lengths_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMemory = db.prepare(`
    INSERT OR IGNORE INTO memories
      (id, chat_id, content, content_norm, uses, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    for (const [chatId, rows] of Object.entries(history || {})) {
      if (!Array.isArray(rows)) continue;
      for (const item of rows) {
        if (!item || !["user", "assistant"].includes(item.role)) continue;
        insertMessage.run(
          chatId,
          item.role,
          String(item.content || ""),
          Number(item.createdAt || Date.now()),
          item.correctedAt ? Number(item.correctedAt) : null,
        );
      }
    }

    if (Array.isArray(training)) {
      for (const item of training) {
        if (!item?.chatId || !item?.input || !item?.output) continue;
        const input = String(item.input).trim();
        const output = String(item.output).trim();
        insertTraining.run(
          item.chatId,
          input,
          output,
          input.toLowerCase(),
          output.toLowerCase(),
          item.source || "teach",
          Number(item.uses || 1),
          Number(item.createdAt || Date.now()),
          item.updatedAt ? Number(item.updatedAt) : null,
        );
      }
    }

    for (const [chatId, item] of Object.entries(relationships || {})) {
      if (!item) continue;
      insertRelationship.run(
        chatId,
        Number(item.closeness ?? 20),
        Number(item.interactions ?? 0),
        Number(item.goodCount ?? 0),
        Number(item.taughtCount ?? 0),
        item.mood || "hangat",
        Number(item.moodSeed ?? Math.floor(Math.random() * 1000)),
        Number(item.moodShiftAt ?? 14),
        JSON.stringify(Array.isArray(item.messageLengths) ? item.messageLengths.slice(-30) : []),
        item.updatedAt ? Number(item.updatedAt) : null,
      );
    }

    for (const [chatId, rows] of Object.entries(memories || {})) {
      if (!Array.isArray(rows)) continue;
      for (const item of rows) {
        const content = String(item?.content || "").trim().replace(/\s+/g, " ");
        if (!content) continue;
        insertMemory.run(
          item.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          chatId,
          content,
          content.toLowerCase(),
          Number(item.uses || 1),
          Number(item.createdAt || Date.now()),
          item.updatedAt ? Number(item.updatedAt) : null,
        );
      }
    }

    db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run("legacy_json_migrated_v1", String(Date.now()));
  })();
}

migrateLegacyJsonOnce();

function words(value = "") {
  return [...new Set(
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2),
  )];
}

function rowToRelationship(row, chatId) {
  if (!row) {
    return {
      chatId,
      closeness: 20,
      interactions: 0,
      goodCount: 0,
      taughtCount: 0,
      mood: "hangat",
      moodSeed: Math.floor(Math.random() * 1000),
      moodShiftAt: 14,
      messageLengths: [],
    };
  }
  let lengths = [];
  try { lengths = JSON.parse(row.message_lengths_json || "[]"); } catch { lengths = []; }
  return {
    chatId: row.chat_id,
    closeness: row.closeness,
    interactions: row.interactions,
    goodCount: row.good_count,
    taughtCount: row.taught_count,
    mood: row.mood,
    moodSeed: row.mood_seed,
    moodShiftAt: row.mood_shift_at,
    messageLengths: Array.isArray(lengths) ? lengths : [],
    updatedAt: row.updated_at,
  };
}

function persistRelationship(state) {
  db.prepare(`
    INSERT INTO relationships
      (chat_id, closeness, interactions, good_count, taught_count, mood, mood_seed, mood_shift_at, message_lengths_json, updated_at)
    VALUES (@chatId, @closeness, @interactions, @goodCount, @taughtCount, @mood, @moodSeed, @moodShiftAt, @messageLengthsJson, @updatedAt)
    ON CONFLICT(chat_id) DO UPDATE SET
      closeness=excluded.closeness,
      interactions=excluded.interactions,
      good_count=excluded.good_count,
      taught_count=excluded.taught_count,
      mood=excluded.mood,
      mood_seed=excluded.mood_seed,
      mood_shift_at=excluded.mood_shift_at,
      message_lengths_json=excluded.message_lengths_json,
      updated_at=excluded.updated_at
  `).run({
    ...state,
    messageLengthsJson: JSON.stringify((state.messageLengths || []).slice(-30)),
    updatedAt: state.updatedAt || Date.now(),
  });
}

export function saveMessage(chatId, role, content) {
  db.prepare("INSERT INTO messages(chat_id, role, content, created_at) VALUES (?, ?, ?, ?)")
    .run(chatId, role, content, Date.now());
}

export function getHistory(chatId, limit = 20) {
  return db.prepare(`
    SELECT role, content, created_at AS createdAt, corrected_at AS correctedAt
    FROM messages
    WHERE chat_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(chatId, Math.max(1, Number(limit) || 20)).reverse();
}

export function getLastExchange(chatId) {
  const assistant = db.prepare(`
    SELECT id, content FROM messages
    WHERE chat_id = ? AND role = 'assistant'
    ORDER BY id DESC LIMIT 1
  `).get(chatId);
  if (!assistant) return null;

  const user = db.prepare(`
    SELECT content FROM messages
    WHERE chat_id = ? AND role = 'user' AND id < ?
    ORDER BY id DESC LIMIT 1
  `).get(chatId, assistant.id);
  if (!user) return null;
  return { input: user.content, output: assistant.content };
}

export function replaceLastAssistant(chatId, content) {
  const row = db.prepare(`
    SELECT id FROM messages WHERE chat_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1
  `).get(chatId);
  if (!row) return false;
  db.prepare("UPDATE messages SET content = ?, corrected_at = ? WHERE id = ?")
    .run(content, Date.now(), row.id);
  return true;
}

export function saveTrainingExample(chatId, input, output, source = "teach") {
  const cleanInput = input.trim();
  const cleanOutput = output.trim();
  const inputNorm = cleanInput.toLowerCase();
  const outputNorm = cleanOutput.toLowerCase();
  const existing = db.prepare(`
    SELECT id, source, uses FROM training_examples
    WHERE chat_id = ? AND input_norm = ? AND output_norm = ?
  `).get(chatId, inputNorm, outputNorm);

  if (existing) {
    db.prepare(`
      UPDATE training_examples
      SET uses = ?, updated_at = ?, source = ?
      WHERE id = ?
    `).run(
      existing.uses + 1,
      Date.now(),
      source === "teach" ? "teach" : existing.source,
      existing.id,
    );
    return existing.id;
  }

  return db.prepare(`
    INSERT INTO training_examples
      (chat_id, input, output, input_norm, output_norm, source, uses, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  `).run(chatId, cleanInput, cleanOutput, inputNorm, outputNorm, source, Date.now()).lastInsertRowid;
}

export function getRelevantExamples(chatId, query, limit = 6) {
  const queryWords = words(query);
  const examples = db.prepare(`
    SELECT id, chat_id AS chatId, input, output, source, uses,
           created_at AS createdAt, updated_at AS updatedAt
    FROM training_examples
    WHERE chat_id = ?
    ORDER BY COALESCE(updated_at, created_at) DESC
    LIMIT 500
  `).all(chatId);

  return examples
    .map((item) => {
      const inputWords = words(item.input);
      const overlap = inputWords.filter((word) => queryWords.includes(word)).length;
      const exactBonus = query.trim() && (
        item.input.toLowerCase().includes(query.toLowerCase()) ||
        query.toLowerCase().includes(item.input.toLowerCase())
      ) ? 4 : 0;
      const teachBonus = item.source === "teach" ? 1 : 0;
      return { ...item, score: overlap * 2 + exactBonus + teachBonus };
    })
    .sort((a, b) => b.score - a.score || (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
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
  const row = db.prepare("SELECT * FROM relationships WHERE chat_id = ?").get(chatId);
  const state = rowToRelationship(row, chatId);

  state.interactions += 1;
  if (state.interactions % 12 === 0) state.closeness = Math.min(100, state.closeness + 1);

  const cleanText = text.replace(/^\[[^\]]+\]\s*/, "").trim();
  if (cleanText) {
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
  persistRelationship(state);
  return state;
}

export function recordFeedback(chatId, type) {
  const row = db.prepare("SELECT * FROM relationships WHERE chat_id = ?").get(chatId);
  const state = rowToRelationship(row, chatId);

  if (type === "good") {
    state.goodCount += 1;
    state.closeness = Math.min(100, state.closeness + 2);
  } else {
    state.taughtCount += 1;
    state.closeness = Math.min(100, state.closeness + 1);
  }

  state.mood = moodFor(state.interactions);
  state.updatedAt = Date.now();
  persistRelationship(state);
  return state;
}

export function getRelationshipContext(chatId) {
  const state = rowToRelationship(
    db.prepare("SELECT * FROM relationships WHERE chat_id = ?").get(chatId),
    chatId,
  );

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
  const cleanContent = content.trim().replace(/\s+/g, " ");
  if (!cleanContent) return null;
  const normalized = cleanContent.toLowerCase();
  const existing = db.prepare(`
    SELECT id, uses FROM memories WHERE chat_id = ? AND content_norm = ?
  `).get(chatId, normalized);

  if (existing) {
    db.prepare("UPDATE memories SET uses = ?, updated_at = ? WHERE id = ?")
      .run(existing.uses + 1, Date.now(), existing.id);
    return existing.id;
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  db.prepare(`
    INSERT INTO memories(id, chat_id, content, content_norm, uses, created_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(id, chatId, cleanContent, normalized, Date.now());
  return id;
}

export function getRelevantMemories(chatId, query = "", limit = 6) {
  const queryWords = words(query);
  const memories = db.prepare(`
    SELECT id, chat_id AS chatId, content, uses,
           created_at AS createdAt, updated_at AS updatedAt
    FROM memories WHERE chat_id = ?
    ORDER BY COALESCE(updated_at, created_at) DESC
    LIMIT 200
  `).all(chatId);

  return memories
    .map((item) => {
      const overlap = words(item.content).filter((word) => queryWords.includes(word)).length;
      return { ...item, score: overlap * 3 + Math.min(item.uses || 0, 3) * 0.2 };
    })
    .sort((a, b) => b.score - a.score || (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
    .slice(0, limit);
}

// Dashboard helpers. These keep the dashboard from loading the full database.
export function getPrimaryChatId() {
  return db.prepare("SELECT chat_id AS chatId FROM messages ORDER BY id DESC LIMIT 1").get()?.chatId || null;
}

export function getDashboardStats(since) {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS totalMessages,
      SUM(CASE WHEN role = 'user' AND created_at >= ? THEN 1 ELSE 0 END) AS incomingToday,
      SUM(CASE WHEN role = 'assistant' AND created_at >= ? THEN 1 ELSE 0 END) AS outgoingToday
    FROM messages
  `).get(since, since);
  return {
    totalMessages: Number(row.totalMessages || 0),
    incomingToday: Number(row.incomingToday || 0),
    outgoingToday: Number(row.outgoingToday || 0),
  };
}

export function getDashboardRelationship(chatId = getPrimaryChatId()) {
  if (!chatId) return null;
  const state = rowToRelationship(
    db.prepare("SELECT * FROM relationships WHERE chat_id = ?").get(chatId),
    chatId,
  );
  return {
    chatId,
    closeness: state.closeness,
    interactions: state.interactions,
    goodCount: state.goodCount,
    taughtCount: state.taughtCount,
    mood: state.mood,
  };
}

export function getDashboardMemories(limit = 20) {
  return db.prepare(`
    SELECT id, chat_id AS chatId, content, uses,
           COALESCE(updated_at, created_at) AS updatedAt
    FROM memories
    ORDER BY COALESCE(updated_at, created_at) DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(100, Number(limit) || 20)));
}

export function deleteMemory(chatId, id) {
  return db.prepare("DELETE FROM memories WHERE chat_id = ? AND id = ?").run(chatId, id).changes > 0;
}

export function getDashboardTraining(limit = 20) {
  return db.prepare(`
    SELECT id, chat_id AS chatId, input, output, source, uses,
           COALESCE(updated_at, created_at) AS createdAt
    FROM training_examples
    ORDER BY COALESCE(updated_at, created_at) DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(100, Number(limit) || 20)));
}

export function getDashboardExchanges(limit = 30) {
  return db.prepare(`
    SELECT a.id,
           a.chat_id AS chatId,
           (
             SELECT u.content FROM messages u
             WHERE u.chat_id = a.chat_id AND u.role = 'user' AND u.id < a.id
             ORDER BY u.id DESC LIMIT 1
           ) AS input,
           a.content AS output,
           a.created_at AS createdAt
    FROM messages a
    WHERE a.role = 'assistant'
      AND EXISTS (
        SELECT 1 FROM messages u
        WHERE u.chat_id = a.chat_id AND u.role = 'user' AND u.id < a.id
      )
    ORDER BY a.id DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(100, Number(limit) || 30)));
}

export function getDashboardHistory({ limit = 40, beforeId = null, search = "" } = {}) {
  const safeLimit = Math.max(10, Math.min(100, Number(limit) || 40));
  const q = String(search || "").trim();
  let rows;

  if (q) {
    const pattern = `%${q}%`;
    rows = db.prepare(`
      SELECT id, chat_id AS chatId, role, content, created_at AS createdAt
      FROM messages
      WHERE (? IS NULL OR id < ?)
        AND content LIKE ? COLLATE NOCASE
      ORDER BY id DESC
      LIMIT ?
    `).all(beforeId || null, beforeId || null, pattern, safeLimit + 1);
  } else {
    rows = db.prepare(`
      SELECT id, chat_id AS chatId, role, content, created_at AS createdAt
      FROM messages
      WHERE (? IS NULL OR id < ?)
      ORDER BY id DESC
      LIMIT ?
    `).all(beforeId || null, beforeId || null, safeLimit + 1);
  }

  const hasMore = rows.length > safeLimit;
  const page = rows.slice(0, safeLimit);
  const nextBeforeId = hasMore ? page.at(-1)?.id || null : null;
  return {
    rows: page.reverse(),
    hasMore,
    nextBeforeId,
  };
}

export function getDatabaseInfo() {
  const size = fs.existsSync(SQLITE_FILE) ? fs.statSync(SQLITE_FILE).size : 0;
  return { path: SQLITE_FILE, sizeBytes: size, engine: "SQLite (WAL)" };
}


// Arnel's optional style, rules and self-story use sidecar files; dashboard core data stays in SQLite.
const RULES_FILE = path.join(DATA_DIR, "behavior_rules.json");
const ARNEL_STORIES_FILE = path.join(DATA_DIR, "arnel_story_notes.json");
const STYLE_EXAMPLES_FILE = path.join(DATA_DIR, "style_examples.json");

function loadSidecarJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function saveSidecarJson(file, data) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
  fs.renameSync(temporary, file);
}

export function getRelevantStyleExamples(query = "", limit = 8) {
  const samples = loadSidecarJson(STYLE_EXAMPLES_FILE, {}).samples || [];
  const queryWords = words(query);
  return samples
    .map((item, index) => ({
      ...item,
      score: words(item.content).filter((word) => queryWords.includes(word)).length * 3 + index * 0.001,
    }))
    .sort((a, b) => b.score - a.score || (b.importedAt || 0) - (a.importedAt || 0))
    .slice(0, limit);
}

export function saveBehaviorRule(chatId, content) {
  const data = loadSidecarJson(RULES_FILE, {});
  data[chatId] ||= [];
  const rule = String(content || "").trim().replace(/\s+/g, " ");
  if (!rule) return;
  const existing = data[chatId].find((item) => item.content.toLowerCase() === rule.toLowerCase());
  if (existing) existing.updatedAt = Date.now();
  else {
    data[chatId].push({ content: rule, createdAt: Date.now() });
    data[chatId] = data[chatId].slice(-40);
  }
  saveSidecarJson(RULES_FILE, data);
}

export function getBehaviorRules(chatId, limit = 12) {
  return (loadSidecarJson(RULES_FILE, {})[chatId] || []).slice(-limit).map((item) => item.content);
}

export function saveArnelStory(chatId, content) {
  const cleanContent = String(content || "").replace(/\|\|/g, " ").replace(/\s+/g, " ").trim();
  const soundsPersonal = /\b(gw|aku)\b/i.test(cleanContent);
  const hasStorySignal = /\b(lagi|abis|tadi|baru|mau|pengen|besok|nanti|udah|belom)\b/i.test(cleanContent);
  if (cleanContent.length < 20 || !soundsPersonal || !hasStorySignal) return;
  const data = loadSidecarJson(ARNEL_STORIES_FILE, {});
  data[chatId] ||= [];
  const existing = data[chatId].find((item) => item.content.toLowerCase() === cleanContent.toLowerCase());
  if (existing) {
    existing.updatedAt = Date.now();
    existing.uses = (existing.uses || 1) + 1;
  } else {
    data[chatId].push({ content: cleanContent, createdAt: Date.now(), uses: 1 });
    data[chatId] = data[chatId].slice(-80);
  }
  saveSidecarJson(ARNEL_STORIES_FILE, data);
}

export function getRelevantArnelStories(chatId, query = "", limit = 6) {
  const queryWords = words(query);
  return (loadSidecarJson(ARNEL_STORIES_FILE, {})[chatId] || [])
    .map((item) => ({
      ...item,
      score: words(item.content).filter((word) => queryWords.includes(word)).length * 3 + Math.min(item.uses || 0, 3) * 0.1,
    }))
    .sort((a, b) => b.score - a.score || (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
    .slice(0, limit);
}
