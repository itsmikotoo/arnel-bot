const jitter = (a, b) => (a + Math.random() * (b - a)) * 3600000;
export const localParts = date => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TZ || 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = type => parts.find(p => p.type === type).value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
};
const tokens = text => String(text || '').toLowerCase().replace(/udah|sudah/g, 'udah').match(/[\p{L}\p{N}]+/gu) || [];
export function similarProactive(a, b) {
  const x = tokens(a), y = tokens(b);
  if (!x.length || !y.length) return false;
  if (x.join(' ') === y.join(' ')) return true;
  const left = new Set(x), right = new Set(y);
  const overlap = [...left].filter(w => right.has(w)).length;
  return overlap / Math.max(left.size, right.size) >= .72 || (Math.min(left.size, right.size) >= 6 && overlap / Math.min(left.size, right.size) >= .9);
}
export class Scheduler {
  constructor({ config, store, logger, send, generate, target, lock }) {
    Object.assign(this, { config, store, logger, send, generate, target, lock });
    this.timer = null; this.running = false; this.stopped = false;
    const old = store.read('proactive_state', {});
    if (old.awaitingReply === undefined) {
      const history = Object.values(store.read('chat_history', {})).flat();
      const lastUser = Math.max(0, ...history.filter(m => m.role === 'user').map(m => m.createdAt || 0));
      store.update('proactive_state', {}, s => { s.awaitingReply = Boolean(s.lastProactiveAt && lastUser <= s.lastProactiveAt); });
    }
  }
  activity(now = Date.now()) {
    this.store.update('proactive_state', {}, s => {
      s.lastActivityAt = now; s.activityVersion = (s.activityVersion || 0) + 1; s.awaitingReply = false;
      s.nextIdleAt = now + jitter(2, 4); s.nextRandomAt = now + jitter(3, 6);
    });
  }
  start() {
    if (!this.config.proactive || this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => this.tick().catch(e => this.logger.error({ error: e.message }, 'proactive gagal')), 30000);
    this.tick().catch(e => this.logger.error({ error: e.message }, 'proactive gagal'));
  }
  stop() { this.stopped = true; clearInterval(this.timer); this.timer = null; }
  async tick(now = Date.now()) {
    if (this.running || this.stopped || !this.config.proactive) return;
    this.running = true;
    try {
      const { day, time } = localParts(new Date(now));
      const s = this.store.read('proactive_state', {});
      if (s.day !== day) this.store.update('proactive_state', {}, x => { x.day = day; x.sentToday = 0; x.fixed = []; });
      const state = this.store.read('proactive_state', {});
      if (!state.nextIdleAt || !state.nextRandomAt) this.store.update('proactive_state', {}, x => { x.lastActivityAt ||= now; x.nextIdleAt ||= now + jitter(2, 4); x.nextRandomAt ||= now + jitter(3, 6); });
      const cur = this.store.read('proactive_state', {});
      const key = `${day}:${time}`;
      const fixed = this.config.times.includes(time) && !cur.fixed?.includes(key);
      const idle = now >= cur.nextIdleAt, random = now >= cur.nextRandomAt;
      if (cur.awaitingReply || now < (cur.nextAttemptAt || 0) || !(fixed || idle || random) || cur.sentToday >= this.config.dailyMax || now - (cur.lastProactiveAt || 0) < this.config.gapMinutes * 60000 || now - cur.lastActivityAt < this.config.recentMinutes * 60000) return;
      const jid = await this.target();
      if (!jid) return;
      const version = cur.activityVersion || 0;
      const cancelled = () => {
        const live = this.store.read('proactive_state', {});
        return this.stopped || live.awaitingReply || (live.activityVersion || 0) !== version;
      };
      await this.lock(jid, async () => {
        if (cancelled()) return;
        // Back off even if generation fails, instead of retrying every scheduler tick.
        this.store.update('proactive_state', {}, x => { x.nextAttemptAt = now + 3600000; });
        const recent = (cur.recent || []).slice(-30);
        const legacy = (this.store.read('chat_history', {})[jid] || []).filter(m => m.role === 'assistant' && !m.media).slice(-20).map(m => m.content);
        const previous = [...recent.map(m => m.text), ...legacy];
        let message = '';
        for (let attempt = 0; attempt < 2; attempt++) {
          const generated = await this.generate(jid, fixed ? `jadwal ${time}` : idle ? 'obrolan sedang sepi' : 'waktu acak', { now, previous, retry: attempt > 0 });
          if (cancelled()) return;
          // Exactly one bubble per initiative. Dedup the text that will actually be sent.
          message = String(generated || '').replace(/\s*\|\|\s*|\n+/g, ' ').trim();
          if (message && !previous.some(old => similarProactive(message, old))) break;
          if (message) previous.push(message);
          message = '';
        }
        if (!message) { this.logger.info('proactive dilewati: masih terlalu mirip'); return; }
        if (cancelled()) return;
        // Reserve before sending so restart/ambiguous network failure cannot pile up messages.
        this.store.update('proactive_state', {}, x => {
          x.awaitingReply = true; x.lastProactiveAt = now; x.sentToday = (x.sentToday || 0) + 1;
          x.nextIdleAt = now + jitter(2, 4); x.nextRandomAt = now + jitter(3, 6);
          if (fixed) { x.fixed ||= []; x.fixed.push(key); }
        });
        const sent = await this.send(jid, message, null, 1);
        this.store.update('proactive_state', {}, x => {
          x.recent = [...(x.recent || []), { text: sent || message, sentAt: now }].slice(-30);
        });
      });
    } finally { this.running = false; }
  }
}
