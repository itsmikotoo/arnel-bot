import { relevant } from './memory.js';
import fs from 'node:fs';
const DAY = 86400000;
export class Story {
  constructor(store) {
    this.store = store;
    // Checkout branch v3 pada direktori v2 mempertahankan data/. Impor catatan lama sekali saja.
    if (fs.existsSync(store.file('arnel_story_notes')) && !fs.existsSync(store.file('story_threads'))) {
      const now = Date.now();
      const old = store.read('arnel_story_notes', {});
      const threads = {};
      for (const [jid, items] of Object.entries(old)) {
        threads[jid] = items.slice(-40).map(x => ({ text: x.content, stage: 'preparation', createdAt: x.createdAt || now, lastMentionAt: x.updatedAt || x.createdAt || now, expiresAt: now + 30 * DAY }));
      }
      store.write('story_threads', threads);
    }
  }
  track(jid, reply, stage, now = Date.now()) {
    const text = reply.replace(/\|\|/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length < 20 || !/\b(gw|aku)\b/i.test(text) || !/\b(lagi|abis|tadi|baru|mau|pengen|besok|nanti|udah|belom)\b/i.test(text)) return;
    this.store.update('story_threads', {}, db => {
      db[jid] ||= [];
      const existing = db[jid].find(e => e.text.toLowerCase() === text.toLowerCase());
      if (existing) existing.lastMentionAt = now;
      else db[jid].push({ text: text.slice(0, 400), stage, createdAt: now, lastMentionAt: now, expiresAt: now + 30 * DAY });
      db[jid] = db[jid].filter(e => e.expiresAt > now).slice(-40);
    });
  }
  active(jid, query, stage, now = Date.now()) {
    const threads = (this.store.read('story_threads', {})[jid] || []).filter(e => e.expiresAt > now && (!e.stage || e.stage === stage));
    return relevant(threads.map(e => ({ ...e, content: e.text })), query, 5);
  }
}
