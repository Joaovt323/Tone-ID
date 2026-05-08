// api/vocal-insight.js
// Insight para voz solo — usa Note Mapping + Vocal Cleanup
// Retorna array completo de eventos { time, hz, note } para timeline

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const API_KEY = process.env.MUSICAI_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'MUSICAI_KEY não configurada.' });

  const { inputUrl } = req.body;
  if (!inputUrl) return res.status(400).json({ error: 'Campo obrigatório: inputUrl' });

  const auth = { Authorization: API_KEY, 'Content-Type': 'application/json' };

  try {
    // ── 1. Busca workflows ────────────────────────────────────────────────────
    const wfData    = await (await fetch('https://api.music.ai/v1/workflow?size=100', { headers: { Authorization: API_KEY } })).json();
    const workflows = wfData.workflows || [];

    const noteWf    = workflows.find(w => /note\s*map/i.test(w.name));
    const cleanupWf = workflows.find(w => /cleanup|vocal.*sep/i.test(w.name));

    if (!noteWf) {
      return res.status(404).json({ error: 'Workflow "Note Mapping" não encontrado. Disponíveis: ' + workflows.map(w => `"${w.name}"`).join(', ') });
    }

    // ── 2. Cleanup opcional ───────────────────────────────────────────────────
    let vocalUrl = inputUrl;
    if (cleanupWf) {
      try {
        const cj = await (await fetch('https://api.music.ai/v1/job', {
          method: 'POST', headers: auth,
          body: JSON.stringify({ name: 'Tone-ID vocal cleanup', workflow: cleanupWf.slug, params: { inputUrl } }),
        })).json();
        if (cj.id) {
          for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 5000));
            const sd = await (await fetch(`https://api.music.ai/v1/job/${cj.id}`, { headers: { Authorization: API_KEY } })).json();
            if (sd.status === 'SUCCEEDED') { vocalUrl = sd.result?.vocals || sd.result?.voice || inputUrl; break; }
            if (sd.status === 'FAILED')    break;
          }
        }
      } catch (_) { /* continua com áudio original */ }
    }

    // ── 3. Job de Note Mapping ────────────────────────────────────────────────
    const njData = await (await fetch('https://api.music.ai/v1/job', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ name: 'Tone-ID note mapping', workflow: noteWf.slug, params: { inputUrl: vocalUrl } }),
    })).json();
    if (!njData.id) return res.status(500).json({ error: 'Falha ao criar job: ' + JSON.stringify(njData) });

    // ── 4. Polling ────────────────────────────────────────────────────────────
    let rawResult = null;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const sd = await (await fetch(`https://api.music.ai/v1/job/${njData.id}`, { headers: { Authorization: API_KEY } })).json();
      if (sd.status === 'SUCCEEDED') { rawResult = sd.result; break; }
      if (sd.status === 'FAILED')    return res.status(500).json({ error: 'Job falhou: ' + JSON.stringify(sd.error) });
    }
    if (!rawResult) return res.status(500).json({ error: 'Timeout após 5 minutos.' });

    // ── 5. Lê eventos de nota (CSV ou array) ──────────────────────────────────
    let noteEvents = [];
    const csvUrl = rawResult.csv || rawResult.output || rawResult.pitchMap || rawResult.notes || rawResult.pitch || null;
    if (csvUrl && typeof csvUrl === 'string' && csvUrl.startsWith('http')) {
      const text = await (await fetch(csvUrl)).text();
      noteEvents  = parseNoteCSV(text);
    } else if (Array.isArray(rawResult)) {
      noteEvents = rawResult;
    } else {
      for (const k of Object.keys(rawResult)) {
        if (Array.isArray(rawResult[k])) { noteEvents = rawResult[k]; break; }
      }
    }

    // ── 6. Análise ────────────────────────────────────────────────────────────
    const analysis = analyzeNotes(noteEvents);

    return res.status(200).json({
      workflowUsed: noteWf.name,
      cleanupUsed:  !!cleanupWf && vocalUrl !== inputUrl,
      noteEvents,   // array de { time, hz, note } — para o gráfico/timeline
      ...analysis,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── Parser CSV ────────────────────────────────────────────────────────────────
const CHROMATIC = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
function hzToNote(hz) {
  if (!hz || hz <= 0) return null;
  const midi = Math.round(12 * Math.log2(hz / 440) + 69);
  return CHROMATIC[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}
function noteToMidi(n) {
  const m = n?.match(/^([A-G][#b]?)(-?\d)$/);
  if (!m) return 60;
  return (parseInt(m[2]) + 1) * 12 + (CHROMATIC.indexOf(m[1]) || 0);
}

function parseNoteCSV(text) {
  const lines  = text.trim().split('\n');
  if (lines.length < 2) return [];
  const header = lines[0].toLowerCase().split(',').map(s => s.trim());
  const ti = header.findIndex(h => h.includes('time') || h === 't');
  const fi = header.findIndex(h => h.includes('freq') || h.includes('hz') || h.includes('pitch'));
  const ni = header.findIndex(h => h === 'note' || h.includes('note_name'));
  const ci = header.findIndex(h => h.includes('conf'));
  const events = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(s => s.trim());
    const time = ti >= 0 ? parseFloat(cols[ti]) : i * 0.01;
    const hz   = fi >= 0 ? parseFloat(cols[fi]) : 0;
    const note = ni >= 0 ? cols[ni] : hzToNote(hz);
    const conf = ci >= 0 ? parseFloat(cols[ci]) : 1;
    if (hz > 0 && conf > 0.3) events.push({ time: +time.toFixed(3), hz: +hz.toFixed(2), note });
  }
  return events;
}

// ── Análise das notas ─────────────────────────────────────────────────────────
function analyzeNotes(events) {
  const valid = (events || [])
    .filter(e => e.note)
    .map(e => ({ ...e, midi: noteToMidi(e.note) }))
    .filter(e => e.midi >= 36 && e.midi <= 96);

  if (!valid.length) {
    return {
      range: null, centerNote: null, lowestNote: null, highestNote: null, semitones: 0,
      tecnicas: [{ nome: 'Nenhuma nota detectada', descricao: 'Verifique se o arquivo contém voz clara e tente novamente.' }],
      midi: defaultMidi(),
    };
  }

  const midis   = valid.map(e => e.midi);
  const lo      = Math.min(...midis), hi = Math.max(...midis);
  const center  = Math.round(midis.reduce((a, b) => a + b, 0) / midis.length);
  const toNote  = m => CHROMATIC[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  const loNote  = toNote(lo), hiNote = toNote(hi), cNote = toNote(center);
  const semi    = hi - lo;
  const rootMatch = cNote.match(/^([A-G][#]?)/);
  const root    = rootMatch ? rootMatch[1] : 'C';
  const scale   = center < 60 ? 'minor' : 'major';
  const NOTE_IDX = Object.fromEntries(CHROMATIC.map((n, i) => [n, i]));
  function noteAt(r, s, o) { return CHROMATIC[((NOTE_IDX[r]??0)+s+12)%12]+o; }
  const isMinor = scale === 'minor';
  const third = isMinor ? 3 : 4, sixth = isMinor ? 8 : 9;

  return {
    lowestNote: loNote, highestNote: hiNote, centerNote: cNote,
    semitones: semi, range: `${loNote} — ${hiNote}`,
    tecnicas: [
      { nome: 'Harmonia em terça acima', descricao: `Sua voz ficou centrada em torno de ${cNote}. Cante uma terça ${isMinor?'menor':'maior'} acima para o backing mais natural.` },
      { nome: 'Harmonia em terça abaixo', descricao: `Tente cantar uma terça abaixo de ${cNote}. Com sua extensão de ${loNote} a ${hiNote} você tem espaço para harmonias graves.` },
      { nome: semi >= 12 ? 'Dobramento em oitava (extensão ampla)' : 'Stacked vocals na região central', descricao: semi >= 12 ? `Sua extensão de ${semi} semitons é ampla — experimente dobrar as partes graves uma oitava acima.` : `Grave 3 camadas próximas de ${cNote} com leve detuning (±10 cents) para um coral encorpado.` },
      { nome: 'Pad vocal sustentado', descricao: `Segure a nota ${cNote} com vibrato suave no final. Grave com intensidade baixa para não sobrepor a voz principal.` },
    ],
    midi: { root: [noteAt(root,0,4), noteAt(root,0,5)], harmony: [noteAt(root,third,4), noteAt(root,7,4), noteAt(root,third,5), noteAt(root,7,5)], color: [noteAt(root,sixth,4), noteAt(root,2,5), noteAt(root,11,4)] },
  };
}

function defaultMidi() {
  const CHROMATIC2 = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  return { root:['C4','C5'], harmony:['E4','G4','E5','G5'], color:['A4','D5','B4'] };
}