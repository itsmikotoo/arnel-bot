import { STAGES } from './life.js';
export async function trainer(text, jid, { memory, relationship, life }) {
  const [command, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(' ').replace(/^:\s*/, '').trim();
  switch (command.toLowerCase()) {
    case '!help': return 'trainer: !good, !teach <jawaban>, !atur <aturan>, !aturan, !ingat <catatan>, !ingatan, !life status, !life stage <fase> [catatan], !life event <kejadian>';
    case '!good': {
      const e = memory.exchange(jid);
      if (!e) return 'belom ada jawaban yang bisa dinilai';
      memory.addTraining(jid, e.input, e.output, 'good'); relationship.feedback(jid, 'good'); return 'okeh gw inget yang ini';
    }
    case '!teach': {
      if (!arg) return 'tulis !teach terus jawaban yang lu mau';
      const e = memory.exchange(jid);
      if (!e) return 'belom ada jawaban yang bisa dikoreksi';
      memory.addTraining(jid, e.input, arg.slice(0, 1500), 'teach'); memory.correct(jid, arg.slice(0, 1500)); relationship.feedback(jid, 'teach'); return 'nah gitu ya || gw inget';
    }
    case '!atur': if (!arg) return 'tulis !atur terus aturan yang lu mau'; memory.addNote('behavior_rules', jid, arg, 40); return 'okeh aturan ini gw pegang';
    case '!aturan': return memory.notes('behavior_rules', jid, '', 40).map((x, i) => `${i + 1}. ${x.content}`).join('\n') || 'belom ada aturan khusus';
    case '!ingat': if (!arg) return 'tulis !ingat terus hal yang mau gw inget'; memory.addNote('memories', jid, arg); return 'okeh gw simpen';
    case '!ingatan': return memory.notes('memories', jid, '', 10).map((x, i) => `${i + 1}. ${x.content}`).join('\n') || 'belom ada yang gw simpen';
    case '!life': {
      const [action, stage, ...note] = rest;
      if (!action || action === 'status') {
        const state = life.advance();
        return `fase: ${stageLabel(state.stage)}\nsejak: ${new Date(state.stageSince).toISOString().slice(0, 10)}\nkejadian: ${state.events.map(e => e.text).join('; ') || 'belom ada'}\nfase tersedia: ${Object.keys(STAGES).join(', ')}`;
      }
      if (action === 'stage') {
        if (!STAGES[stage]) return `pilih fase: ${Object.keys(STAGES).join(', ')}`;
        life.setStage(stage, note.join(' ')); return `fase Arnel sekarang ${stageLabel(stage)}`;
      }
      if (action === 'event') { if (!arg.slice(6).trim()) return 'tulis !life event <kejadian>'; life.addEvent(arg.slice(6)); return 'kejadian disimpan'; }
      return 'pakai !life status, !life stage <fase>, atau !life event <kejadian>';
    }
    default: return null;
  }
}
function stageLabel(stage) { return STAGES[stage]?.label || stage; }
