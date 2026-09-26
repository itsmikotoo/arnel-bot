export const words = text => [...new Set(String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 2))];
const relevant = (items, query, limit, field = 'content') => {
  const q = words(query);
  return items.map((item, index) => ({ item, score: words(item[field]).filter(w => q.includes(w)).length * 3 + (item.source === 'teach' ? 1 : 0) + index * .0001 }))
    .sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.item);
};
export { relevant };
export class Memory {
  constructor(store) { this.store = store; }
  history(jid, limit = 20) { return (this.store.read('chat_history', {})[jid] || []).slice(-limit); }
  addMessage(jid, role, content, media = null) {
    this.store.update('chat_history', {}, db => { db[jid] ||= []; db[jid].push({ role, content, createdAt: Date.now(), ...(media ? { media } : {}) }); db[jid] = db[jid].slice(-200); });
  }
  exchange(jid) {
    const list = this.history(jid, 200);
    for (let i = list.length - 1; i >= 0; i--) if (list[i].role === 'assistant' && !list[i].media) {
      for (let j = i - 1; j >= 0; j--) if (list[j].role === 'user') return { input: list[j].content, output: list[i].content };
    }
    return null;
  }
  correct(jid, content) {
    this.store.update('chat_history', {}, db => {
      const list = db[jid] || [];
      for (let i = list.length - 1; i >= 0; i--) if (list[i].role === 'assistant' && !list[i].media) { list[i].content = content; list[i].correctedAt = Date.now(); break; }
    });
  }
  addTraining(jid, input, output, source) {
    this.store.update('training_examples', [], db => {
      const found = db.find(x => x.chatId === jid && x.input.toLowerCase() === input.toLowerCase() && x.output.toLowerCase() === output.toLowerCase());
      if (found) { found.uses = (found.uses || 1) + 1; found.source = source === 'teach' ? source : found.source; }
      else db.push({ chatId: jid, input, output, source, createdAt: Date.now(), uses: 1 });
      db.splice(0, Math.max(0, db.length - 500));
    });
  }
  training(jid, query) { return relevant(this.store.read('training_examples', []).filter(x => x.chatId === jid), query, 6, 'input'); }
  addNote(file, jid, content, cap = 60) {
    const clean = content.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!clean) return;
    this.store.update(file, {}, db => {
      db[jid] ||= [];
      const match = db[jid].find(x => x.content.toLowerCase() === clean.toLowerCase());
      if (match) match.updatedAt = Date.now();
      else db[jid].push({ content: clean, createdAt: Date.now() });
      db[jid] = db[jid].slice(-cap);
    });
  }
  notes(file, jid, query = '', limit = 6) { return relevant(this.store.read(file, {})[jid] || [], query, limit); }
}
