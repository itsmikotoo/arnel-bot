import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadContentFromMessage,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { SYSTEM_PROMPT } from "./persona.js";
import {
  getHistory,
  getLastExchange,
  getRelationshipContext,
  getRelevantExamples,
  recordFeedback,
  recordInteraction,
  replaceLastAssistant,
  saveMessage,
  saveTrainingExample,
} from "./db.js";

const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const AUTH_DIR = path.join(DATA_DIR, "baileys_auth");
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const CONNECTION_ONLY = process.env.CONNECTION_ONLY === "true";
const ALLOWED_NUMBER = (process.env.ALLOWED_NUMBER || "").replace(/\D/g, "");
const PROACTIVE_ENABLED = process.env.PROACTIVE_ENABLED === "true";
const PROACTIVE_TIMES = (process.env.PROACTIVE_TIMES || "08:00,12:30,19:30")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const PROACTIVE_DAILY_MAX = Number(process.env.PROACTIVE_DAILY_MAX || 5);
const PROACTIVE_MIN_GAP_MS = 90 * 60 * 1000;
const PROACTIVE_STATE_FILE = path.join(DATA_DIR, "proactive_state.json");
const MAX_HISTORY = 20;
const MESSAGE_DEBOUNCE_MS = Math.max(500, Number(process.env.MESSAGE_DEBOUNCE_MS || 3500));
const MAX_REPLY_BUBBLES = Math.max(1, Number(process.env.MAX_REPLY_BUBBLES || 6));
const REPLY_QUOTE_CHANCE = Math.min(1, Math.max(0, Number(process.env.REPLY_QUOTE_CHANCE || 0.28)));
const logger = pino({ level: process.env.LOG_LEVEL || "silent" });

fs.mkdirSync(DATA_DIR, { recursive: true });

if (!CONNECTION_ONLY && !process.env.GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY belum diisi di file .env");
  process.exit(1);
}

let reconnectTimer;
let proactiveTimer;
let starting = false;
let activeSocket;
let targetJid;
const pendingTextMessages = new Map();
const chatQueues = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readProactiveState() {
  try {
    return JSON.parse(fs.readFileSync(PROACTIVE_STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeProactiveState(state) {
  const tempFile = `${PROACTIVE_STATE_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(state, null, 2));
  fs.renameSync(tempFile, PROACTIVE_STATE_FILE);
}

function randomHours(min, max) {
  return min + Math.random() * (max - min);
}

function todayKey(date = new Date()) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function localTime(date = new Date()) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function touchActivity() {
  const state = readProactiveState();
  state.lastActivityAt = Date.now();
  state.nextIdleAt = Date.now() + randomHours(2, 4) * 60 * 60 * 1000;
  writeProactiveState(state);
}

function getText(message) {
  const content = message?.message;
  return (
    content?.conversation ||
    content?.extendedTextMessage?.text ||
    content?.imageMessage?.caption ||
    content?.videoMessage?.caption ||
    ""
  ).trim();
}

function getMessageContext(message) {
  const content = message?.message || {};
  const contextInfo =
    content.extendedTextMessage?.contextInfo ||
    content.imageMessage?.contextInfo ||
    content.videoMessage?.contextInfo ||
    content.stickerMessage?.contextInfo ||
    {};

  const hints = [];
  if (contextInfo.isForwarded || contextInfo.forwardingScore) {
    hints.push("[ini pesan yang diteruskan dari chat lain]");
  }
  if (contextInfo.stanzaId) {
    hints.push("[ini adalah balasan ke chat sebelumnya]");
  }
  return hints.join("\n");
}

function phoneFromJid(jid = "") {
  return jid.split("@")[0].split(":")[0].replace(/\D/g, "");
}

function isAllowed(message) {
  const jid = message.key.remoteJid || "";
  if (jid.endsWith("@g.us") || jid === "status@broadcast") return false;
  if (!ALLOWED_NUMBER) return true;

  const possibleJids = [
    message.key.remoteJid,
    message.key.remoteJidAlt,
    message.key.participant,
    message.key.participantAlt,
  ].filter(Boolean);

  return possibleJids.some((value) => phoneFromJid(value) === ALLOWED_NUMBER);
}

function cleanHistory(history) {
  const result = [];
  for (const item of history) {
    const role = item.role === "assistant" ? "model" : "user";
    const previous = result.at(-1);
    if (previous?.role === role) {
      previous.parts[0].text += `\n${item.content}`;
    } else {
      result.push({ role, parts: [{ text: item.content }] });
    }
  }
  while (result[0]?.role === "model") result.shift();
  return result;
}

function buildSystemInstruction(chatId, query = "") {
  const relationship = getRelationshipContext(chatId);
  const examples = getRelevantExamples(chatId, query, 6);
  const learnedExamples = examples.length
    ? [
        "Contoh jawaban yang sudah disukai atau dikoreksi pemilik:",
        ...examples.map((item) => `user: ${item.input}\narnel: ${item.output}`),
        "Ikuti pola dan nuansanya jika situasinya relevan jangan menyalin secara buta.",
      ].join("\n")
    : "Belum ada contoh hasil latihan yang relevan.";

  return [
    SYSTEM_PROMPT,
    "",
    "Konteks perkembangan hubungan:",
    relationship,
    "",
    learnedExamples,
  ].join("\n");
}

async function requestGemini(chatId, userParts, trainingQuery = "") {
  const history = cleanHistory(getHistory(chatId, MAX_HISTORY));
  const systemInstruction = buildSystemInstruction(chatId, trainingQuery);
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemInstruction }] },
        contents: [...history, { role: "user", parts: userParts }],
        generationConfig: {
          temperature: 1.1,
          maxOutputTokens: 800,
          thinkingConfig: { thinkingLevel: "MINIMAL" },
        },
      }),
    },
  );

  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error?.message || `Gemini HTTP ${response.status}`);
  }

  const reply = body?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim();
  if (!reply) {
    const finishReason = body?.candidates?.[0]?.finishReason || "UNKNOWN";
    const blockReason = body?.promptFeedback?.blockReason;
    throw new Error(
      `Gemini tidak mengembalikan teks (finish=${finishReason}${blockReason ? ` block=${blockReason}` : ""})`,
    );
  }
  return reply;
}

async function askGemini(chatId, text) {
  return requestGemini(chatId, [{ text }], text);
}

async function downloadImage(imageMessage) {
  const stream = await downloadContentFromMessage(imageMessage, "image");
  const chunks = [];
  let size = 0;

  for await (const chunk of stream) {
    size += chunk.length;
    if (size > 5 * 1024 * 1024) throw new Error("Foto lebih besar dari batas 5 MB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function understandImage(chatId, imageMessage) {
  const image = await downloadImage(imageMessage);
  const caption = imageMessage.caption?.trim();
  const instruction = [
    "Lihat foto ini dan tanggapi sebagai Arnel.",
    caption ? `Caption pengirim: ${caption}` : "Foto dikirim tanpa caption.",
    "Balas persis dua baris dengan format:",
    "REACTION: satu emoji WhatsApp yang sesuai",
    "REPLY: chat pendek natural maksimal 8 kata tanpa emoji dan tanpa hinaan",
  ].join("\n");

  const raw = await requestGemini(chatId, [
    { text: instruction },
    {
      inline_data: {
        mime_type: imageMessage.mimetype || "image/jpeg",
        data: image.toString("base64"),
      },
    },
  ]);

  const reaction = raw.match(/REACTION:\s*(\S+)/i)?.[1] || "👀";
  const reply = raw.match(/REPLY:\s*(.+)/i)?.[1]?.trim() || raw.replace(/REACTION:.*$/gim, "").trim();
  return { reaction, reply };
}

function getStickerReply(stickerMessage) {
  const staticReplies = [
    "stiker apaan itu",
    "wkwk apasih",
    "ih ngirim ginian",
    "aneh bgt stiker lu",
    "paham paham",
  ];
  const animatedReplies = [
    "stiker gerak apaan itu",
    "wkwk rame amat",
    "ih apasih itu",
  ];
  const replies = stickerMessage.isAnimated ? animatedReplies : staticReplies;
  const seed = Number(stickerMessage.fileLength || 0) + Number(stickerMessage.height || 0);
  return replies[seed % replies.length];
}

async function createProactiveMessage(chatId, reason) {
  return askGemini(
    chatId,
    `Mulai percakapan duluan sekarang. Alasannya ${reason}. Buat pembuka Arnel yang natural dan sesuai mood. Biasanya satu bubble pendek, tetapi boleh 2 atau 3 bubble kalau memang ada hal kecil yang ingin diceritakan. Jangan menjelaskan bahwa ini pesan terjadwal.`,
  );
}

async function resolveTargetJid(sock) {
  if (targetJid) return targetJid;
  if (!ALLOWED_NUMBER) throw new Error("ALLOWED_NUMBER wajib diisi untuk chat duluan");
  const [result] = await sock.onWhatsApp(`${ALLOWED_NUMBER}@s.whatsapp.net`);
  if (!result?.exists) throw new Error("ALLOWED_NUMBER tidak ditemukan di WhatsApp");
  targetJid = result.jid;
  return targetJid;
}

async function runProactiveCheck(sock) {
  if (!PROACTIVE_ENABLED || CONNECTION_ONLY || !sock?.user) return;

  const now = new Date();
  const nowMs = now.getTime();
  const day = todayKey(now);
  const state = readProactiveState();

  if (state.day !== day) {
    state.day = day;
    state.sentToday = 0;
    state.sentFixedKeys = [];
  }
  state.lastActivityAt ||= nowMs;
  state.nextIdleAt ||= nowMs + randomHours(2, 4) * 60 * 60 * 1000;
  state.nextRandomAt ||= nowMs + randomHours(3, 6) * 60 * 60 * 1000;
  state.sentFixedKeys ||= [];

  const currentTime = localTime(now);
  const fixedKey = `${day}-${currentTime}`;
  const fixedDue = PROACTIVE_TIMES.includes(currentTime) && !state.sentFixedKeys.includes(fixedKey);
  const idleDue = nowMs >= state.nextIdleAt;
  const randomDue = nowMs >= state.nextRandomAt;
  const enoughGap = nowMs - (state.lastProactiveAt || 0) >= PROACTIVE_MIN_GAP_MS;
  const belowLimit = (state.sentToday || 0) < PROACTIVE_DAILY_MAX;

  if (!(fixedDue || idleDue || randomDue) || !enoughGap || !belowLimit) {
    writeProactiveState(state);
    return;
  }

  const reason = fixedDue ? `jadwal ${currentTime}` : idleDue ? "sudah lama tidak ada chat" : "waktu acak";
  const jid = await resolveTargetJid(sock);
  const message = await createProactiveMessage(jid, reason);
  const parts = message.split("||").map((part) => part.trim()).filter(Boolean).slice(0, 2);

  for (const part of parts) {
    await sock.sendMessage(jid, { text: part });
    await sleep(500);
  }

  saveMessage(jid, "assistant", message);
  state.lastProactiveAt = nowMs;
  state.lastActivityAt = nowMs;
  state.sentToday = (state.sentToday || 0) + 1;
  state.nextIdleAt = nowMs + randomHours(2, 4) * 60 * 60 * 1000;
  state.nextRandomAt = nowMs + randomHours(3, 6) * 60 * 60 * 1000;
  if (fixedDue) state.sentFixedKeys.push(fixedKey);
  writeProactiveState(state);
  console.log(`[inisiatif] ${jid}: ${message}`);
}

function startProactiveScheduler(sock) {
  clearInterval(proactiveTimer);
  if (!PROACTIVE_ENABLED || CONNECTION_ONLY) return;

  const state = readProactiveState();
  state.lastActivityAt ||= Date.now();
  state.nextIdleAt ||= Date.now() + randomHours(2, 4) * 60 * 60 * 1000;
  state.nextRandomAt ||= Date.now() + randomHours(3, 6) * 60 * 60 * 1000;
  writeProactiveState(state);

  proactiveTimer = setInterval(() => {
    runProactiveCheck(sock).catch((error) => console.error("Gagal chat duluan:", error.message));
  }, 60 * 1000);
  console.log(`Chat duluan aktif. Jadwal: ${PROACTIVE_TIMES.join(", ")}; maksimal ${PROACTIVE_DAILY_MAX}/hari.`);
}

async function enqueueChat(chatId, task) {
  const previous = chatQueues.get(chatId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  chatQueues.set(chatId, current);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (chatQueues.get(chatId) === current) chatQueues.delete(chatId);
  }
}

function splitReply(reply) {
  return reply
    .split("||")
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, MAX_REPLY_BUBBLES);
}

function shouldReplyWithQuote(message, text, parts) {
  if (!message?.key || !parts.length) return false;
  const looksWorthQuoting = parts.length > 1 || text.length > 35;
  return looksWorthQuoting && Math.random() < REPLY_QUOTE_CHANCE;
}

async function generateAndSendReply(message, chatId, text, imageMessage, stickerMessage) {
  recordInteraction(chatId);
  let reply;
  let userContent = text;

  if (imageMessage) {
    const result = await understandImage(chatId, imageMessage);
    reply = result.reply;
    userContent = `[foto] ${text || "tanpa caption"}`;
    await activeSocket.sendMessage(chatId, {
      react: { text: result.reaction, key: message.key },
    });
  } else if (stickerMessage) {
    reply = getStickerReply(stickerMessage);
    userContent = "[stiker]";
  } else {
    reply = await askGemini(chatId, text);
  }

  saveMessage(chatId, "user", userContent);
  saveMessage(chatId, "assistant", reply);

  const parts = splitReply(reply);
  const quoteFirstReply = shouldReplyWithQuote(message, text, parts);
  for (const [index, part] of parts.entries()) {
    await activeSocket.sendPresenceUpdate("composing", chatId);
    await sleep(Math.min(900 + part.length * 25, 3500));
    await activeSocket.sendMessage(
      chatId,
      { text: part },
      index === 0 && quoteFirstReply ? { quoted: message } : undefined,
    );
    if (parts.length > 1) await sleep(350 + Math.random() * 450);
  }
  await activeSocket.sendPresenceUpdate("paused", chatId);
}

function queueTextMessage(message, chatId, text) {
  const pending = pendingTextMessages.get(chatId) || {
    texts: [],
    message,
    timer: undefined,
  };

  pending.texts.push(text);
  pending.message = message;
  clearTimeout(pending.timer);
  pending.timer = setTimeout(() => {
    pendingTextMessages.delete(chatId);
    const combinedText = pending.texts.join("\n");
    console.log(
      pending.texts.length > 1
        ? `[gabung] ${chatId}: ${pending.texts.length} pesan`
        : `[proses] ${chatId}: ${combinedText}`,
    );
    enqueueChat(chatId, () =>
      generateAndSendReply(pending.message, chatId, combinedText, undefined, undefined),
    ).catch((error) => console.error("Gagal memproses pesan:", error.message));
  }, MESSAGE_DEBOUNCE_MS);

  pendingTextMessages.set(chatId, pending);
}

function scheduleReconnect(delay = 3000) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => startWhatsApp(), delay);
}

async function startWhatsApp() {
  if (starting) return;
  starting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    activeSocket = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      browser: Browsers.macOS("Desktop"),
      logger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined,
    });

    activeSocket.ev.on("creds.update", saveCreds);

    activeSocket.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        console.log("\nScan QR ini: WhatsApp > Perangkat tertaut > Tautkan perangkat\n");
        qrcode.generate(qr, { small: true });
      }

      if (connection === "open") {
        console.log("WhatsApp tersambung. Arnel online.");
        console.log(CONNECTION_ONLY ? "Mode tes koneksi aktif, pesan tidak akan dibalas." : "Bot siap membalas pesan.");
        startProactiveScheduler(activeSocket);
      }

      if (connection === "close") {
        const error = lastDisconnect?.error;
        const code = error?.output?.statusCode || error?.statusCode;
        const message = error?.message || "alasan tidak diketahui";
        console.log(`Koneksi tertutup. kode=${code ?? "?"} pesan=${message}`);

        if (code === DisconnectReason.loggedOut || code === 401) {
          console.log(`Session ditolak. Tutup bot, hapus folder ${AUTH_DIR}, lalu jalankan ulang untuk QR baru.`);
          return;
        }

        const delay = code === DisconnectReason.restartRequired ? 1000 : 3000;
        console.log(`Mencoba menyambung ulang dalam ${delay / 1000} detik...`);
        scheduleReconnect(delay);
      }
    });

    activeSocket.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify" || CONNECTION_ONLY) return;

      for (const message of messages) {
        try {
          if (!message.message || message.key.fromMe || !isAllowed(message)) continue;
          const chatId = message.key.remoteJid;
          const imageMessage = message.message.imageMessage;
          const stickerMessage = message.message.stickerMessage;
          const messageText = getText(message);
          const contextHint = getMessageContext(message);
          const text = [messageText, contextHint].filter(Boolean).join("\n");
          if (!chatId || (!text && !imageMessage && !stickerMessage)) continue;

          console.log(
            `[masuk] ${chatId}: ${imageMessage ? "[foto]" : stickerMessage ? "[stiker]" : text}`,
          );
          touchActivity();

          const trainerAllowed = Boolean(ALLOWED_NUMBER) && isAllowed(message);
          const normalizedText = messageText.trim();

          if (!imageMessage && !stickerMessage && trainerAllowed && normalizedText.toLowerCase() === "!good") {
            const exchange = getLastExchange(chatId);
            if (!exchange) {
              await activeSocket.sendMessage(chatId, { text: "belom ada jawaban yang bisa dinilai" });
              continue;
            }
            saveTrainingExample(chatId, exchange.input, exchange.output, "good");
            recordFeedback(chatId, "good");
            await activeSocket.sendMessage(chatId, { text: "okeh gw inget yang ini" });
            console.log(`[trainer] good: ${exchange.input} -> ${exchange.output}`);
            continue;
          }

          if (!imageMessage && !stickerMessage && trainerAllowed && normalizedText.toLowerCase().startsWith("!teach")) {
            const desiredReply = normalizedText.replace(/^!teach\s*:?[\s]*/i, "").trim();
            if (!desiredReply) {
              await activeSocket.sendMessage(chatId, { text: "tulis !teach terus jawaban yang lu mau" });
              continue;
            }
            const exchange = getLastExchange(chatId);
            if (!exchange) {
              await activeSocket.sendMessage(chatId, { text: "belom ada jawaban yang bisa dikoreksi" });
              continue;
            }
            saveTrainingExample(chatId, exchange.input, desiredReply, "teach");
            replaceLastAssistant(chatId, desiredReply);
            recordFeedback(chatId, "teach");
            await activeSocket.sendMessage(chatId, { text: "nah gitu ya || gw inget" });
            console.log(`[trainer] teach: ${exchange.input} -> ${desiredReply}`);
            continue;
          }

          if (imageMessage || stickerMessage) {
            await enqueueChat(chatId, () =>
              generateAndSendReply(message, chatId, text, imageMessage, stickerMessage),
            );
          } else {
            queueTextMessage(message, chatId, text);
          }
        } catch (error) {
          console.error("Gagal memproses pesan:", error.message);
        }
      }
    });
  } catch (error) {
    console.error("Gagal memulai WhatsApp:", error.message);
    scheduleReconnect(5000);
  } finally {
    starting = false;
  }
}

process.on("SIGINT", () => {
  clearTimeout(reconnectTimer);
  clearInterval(proactiveTimer);
  for (const pending of pendingTextMessages.values()) clearTimeout(pending.timer);
  activeSocket?.end?.(new Error("Bot dihentikan"));
  process.exit(0);
});

startWhatsApp();
