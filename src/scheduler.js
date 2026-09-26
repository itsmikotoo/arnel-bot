const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = (a, b) => (a + Math.random() * (b - a)) * 3600000;
const localParts = date => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TZ || 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = type => parts.find(p => p.type === type).value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
};
export class Scheduler {
  constructor({ config, store, logger, send, generate, target, lock }) {
    Object.assign(this, { config, store, logger, send, generate, target, lock });
    this.timer = null; this.running = false;
  }
  activity() {
    this.store.update('proactive_state', {}, s => { s.lastActivityAt = Date.now(); s.nextIdleAt = Date.now() + jitter(2, 4); });
  }
  start() {
    if (!this.config.proactive || this.timer) return;
    this.timer = setInterval(() => this.tick().catch(e => this.logger.error({ error: e.message }, 'proactive gagal')), 30000);
    this.tick().catch(e => this.logger.error({ error: e.message }, 'proactive gagal'));
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  async tick(now = Date.now()) {
    if (this.running || !this.config.proactive) return;
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
      if (!(fixed || idle || random) || cur.sentToday >= this.config.dailyMax || now - (cur.lastProactiveAt || 0) < this.config.gapMinutes * 60000 || now - cur.lastActivityAt < this.config.recentMinutes * 60000) return;
      const jid = await this.target();
      await this.lock(jid, async () => {
        const message = await this.generate(jid, fixed ? `jadwal ${time}` : idle ? 'obrolan sedang sepi' : 'waktu acak');
        await this.send(jid, message, null, 2);
        this.store.update('proactive_state', {}, x => {
          x.lastProactiveAt = now; x.lastActivityAt = now; x.sentToday = (x.sentToday || 0) + 1;
          x.nextIdleAt = now + jitter(2, 4); x.nextRandomAt = now + jitter(3, 6);
          if (fixed) { x.fixed ||= []; x.fixed.push(key); }
        });
      });
    } finally { this.running = false; }
  }
}
