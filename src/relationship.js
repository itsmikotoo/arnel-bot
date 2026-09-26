const moods = ['hangat', 'iseng', 'tenang', 'manja'];
export class Relationship {
  constructor(store) { this.store = store; }
  get(jid) { return this.store.read('relationship_state', {})[jid] || { closeness: 20, interactions: 0, mood: 'hangat', messageLengths: [] }; }
  interaction(jid, text) {
    this.store.update('relationship_state', {}, db => {
      const s = db[jid] ||= { closeness: 20, interactions: 0, mood: 'hangat', messageLengths: [], moodSeed: Math.floor(Math.random() * 1000) };
      s.mood ||= 'hangat';
      s.moodSeed ??= Math.floor(Math.random() * 1000);
      s.interactions++;
      s.messageLengths ||= [];
      s.messageLengths.push(text.length);
      s.messageLengths = s.messageLengths.slice(-30);
      if (s.interactions % 12 === 0) s.closeness = Math.min(100, s.closeness + 1);
      if (s.interactions >= (s.moodShiftAt || 14)) {
        s.mood = moods[(moods.indexOf(s.mood) + 1 + s.moodSeed % 2) % moods.length];
        s.moodShiftAt = s.interactions + 12 + s.moodSeed % 9;
      }
    });
  }
  feedback(jid, type) {
    this.store.update('relationship_state', {}, db => {
      const s = db[jid] ||= { closeness: 20, interactions: 0, mood: 'hangat', messageLengths: [] };
      s[`${type}Count`] = (s[`${type}Count`] || 0) + 1;
      s.closeness = Math.min(100, s.closeness + (type === 'good' ? 2 : 1));
    });
  }
  context(jid) {
    const s = this.get(jid);
    const avg = s.messageLengths?.length ? s.messageLengths.reduce((a, b) => a + b, 0) / s.messageLengths.length : 40;
    return `kedekatan ${s.closeness}/100; mood ${s.mood}; kebiasaan chat lawan bicara ${avg < 25 ? 'singkat' : avg > 85 ? 'detail' : 'campuran'}. Sesuaikan pelan-pelan, jangan mendadak posesif.`;
  }
}
