import { createHash } from 'node:crypto';

export const STAGES = {
  preparation: { label: 'sekolah di Semarang, persiapan masuk kedokteran UI', days: 120, next: 'awaiting' },
  awaiting: { label: 'sudah mendaftar kedokteran UI, menunggu pengumuman', days: 35, next: 'result' },
  accepted: { label: 'diterima kedokteran UI, menyiapkan perpindahan dari Semarang', days: 90, next: 'med_student' },
  rejected: { label: 'belum diterima kedokteran UI, menata rencana berikutnya', days: 90, next: 'reapplying' },
  med_student: { label: 'mahasiswa awal kedokteran UI', days: null },
  reapplying: { label: 'menyiapkan percobaan berikutnya sambil belajar di Semarang', days: null },
};
const days = n => n * 86400000;
const eventText = {
  preparation: ['nyoba latihan soal buat persiapan kedokteran', 'masak makan malam setelah belajar', 'nyatet bagian materi yang masih susah'],
  awaiting: ['ngobrol soal rencana setelah pengumuman', 'masak buat ngalihin pikiran dari nunggu hasil'],
  accepted: ['mulai cari tahu kegiatan awal kuliah', 'beresin rencana pindah ke Jakarta'],
  rejected: ['nyusun ulang jadwal belajar', 'masak sambil mikirin pilihan berikutnya'],
  med_student: ['adaptasi jadwal kuliah', 'nyiapin makan di sela kegiatan kampus'],
  reapplying: ['nyoba latihan soal lagi', 'nyusun target belajar yang lebih masuk akal'],
};
const hash = text => parseInt(createHash('sha256').update(text).digest('hex').slice(0, 8), 16);
export class Life {
  constructor(store) { this.store = store; }
  get(now = Date.now()) {
    let s = this.store.read('life_state', null);
    if (!s) s = this.store.write('life_state', { stage: 'preparation', stageSince: now, seed: createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 16), lastEventAt: now, events: [], transitions: [] });
    return s;
  }
  advance(now = Date.now()) {
    const initial = this.get(now);
    const s = structuredClone(initial);
    let changed = false;
      // Batas transisi dihitung dari tanggal stage terakhir, jadi downtime panjang tetap konsisten.
      while (STAGES[s.stage]?.days && now - s.stageSince >= days(STAGES[s.stage].days)) {
        changed = true;
        const old = s.stage;
        s.stageSince += days(STAGES[old].days);
        s.stage = STAGES[old].next === 'result' ? (hash(s.seed + ':admission') % 2 ? 'accepted' : 'rejected') : STAGES[old].next;
        s.transitions.push({ from: old, to: s.stage, at: s.stageSince, source: 'time' });
        s.transitions = s.transitions.slice(-30);
      }
      // Event ringan lahir paling sering seminggu sekali, berbasis stage saat ini.
      const interval = days(6 + hash(s.seed + ':' + Math.floor(s.lastEventAt / days(1))) % 4);
      if (now - s.lastEventAt >= interval) {
        changed = true;
        const pool = eventText[s.stage];
        s.events.push({ text: pool[hash(s.seed + ':' + now) % pool.length], at: now, expiresAt: now + days(18), stage: s.stage, source: 'automatic' });
        s.lastEventAt = now;
      }
      const active = s.events.filter(e => e.expiresAt > now && e.stage === s.stage).slice(-12);
      if (active.length !== s.events.length) changed = true;
      s.events = active;
    if (changed) this.store.write('life_state', s);
    return s;
  }
  setStage(stage, note = '', now = Date.now()) {
    if (!STAGES[stage]) throw new Error(`fase tidak dikenal: ${stage}`);
    const s = this.get(now);
    this.store.update('life_state', s, state => {
      state.transitions.push({ from: state.stage, to: stage, at: now, source: 'trainer', note: note.slice(0, 240) });
      state.stage = stage; state.stageSince = now; state.lastEventAt = now;
      state.events = [];
    });
  }
  addEvent(text, now = Date.now()) {
    if (!text.trim()) throw new Error('isi kejadian kosong');
    const s = this.get(now);
    this.store.update('life_state', s, state => { state.events.push({ text: text.trim().slice(0, 240), at: now, expiresAt: now + days(21), stage: state.stage, source: 'trainer' }); state.events = state.events.slice(-12); });
  }
  context(now = Date.now()) {
    const s = this.advance(now);
    return `fase: ${STAGES[s.stage].label}\nmulai fase: ${new Date(s.stageSince).toISOString().slice(0, 10)}\nkejadian terakhir: ${s.events.map(e => e.text).join('; ') || 'belum ada'}\nFase ini mengalahkan detail cerita lama yang bertentangan. Kejadian kecil hanya boleh disebut sebagai hal yang mungkin terjadi bila belum muncul dalam percakapan; jangan mengklaim hasil ujian atau penerimaan di luar fase.`;
  }
}
