import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { SYSTEM_PROMPT } from "./persona.js";
import { getHistory, saveMessage } from "./db.js";

const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const AUTH_DIR = path.join(DATA_DIR, "baileys_auth");
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const CONNECTION_ONLY = process.env.CONNECTION_ONLY === "true";
const ALLOWED_NUMBER = (process.env.ALLOWED_NUMBER || "").replace(/\D/g, "");
const MAX_HISTORY = 20;
const logger = pino({ level: process.env.LOG_LEVEL || "silent" });

fs.mkdirSync(DATA_DIR, { recursive: true });

if (!CONNECTION_ONLY && !process.env.GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY belum diisi di file .env");
  process.exit(1);
}

let reconnectTimer;
let starting = false;
let activeSocket;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function askGemini(chatId, text) {
  const history = cleanHistory(getHistory(chatId, MAX_HISTORY));
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [...history, { role: "user", parts: [{ text }] }],
        generationConfig: { temperature: 1.1, maxOutputTokens: 300 },
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
  if (!reply) throw new Error("Gemini tidak mengembalikan teks");
  return reply;
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
          const text = getText(message);
          if (!chatId || !text) continue;

          console.log(`[masuk] ${chatId}: ${text}`);
          const oldHistory = getHistory(chatId, MAX_HISTORY);
          const reply = await askGemini(chatId, text);
          saveMessage(chatId, "user", text);
          saveMessage(chatId, "assistant", reply);

          const parts = reply.split("||").map((part) => part.trim()).filter(Boolean);
          for (const part of parts) {
            await activeSocket.sendPresenceUpdate("composing", chatId);
            await sleep(Math.min(900 + part.length * 25, 3500));
            await activeSocket.sendMessage(chatId, { text: part });
          }
          await activeSocket.sendPresenceUpdate("paused", chatId);
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
  activeSocket?.end?.(new Error("Bot dihentikan"));
  process.exit(0);
});

startWhatsApp();
