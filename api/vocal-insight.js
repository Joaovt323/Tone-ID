// api/vocal-insight.js
// Usa o "pitch map" do Note Mapping — formato confirmado:
//   Header:  0,1,2,...,127  (MIDI note como coluna)
//   Linhas:  activações por nota, uma linha por frame de tempo
//   Separador de linha: \r (normalizado antes de parsear)

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const API_KEY = process.env.MUSICAI_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'MUSICAI_KEY não configurada.' });

  const { inputUrl } = req.body;
  if (!inputUrl) return res.status(400).json({ error: 'Campo obrigatório: inputUrl' });

  const auth = { Authorization: API_KEY, 'Content-Type': 'application/json' };

  try {
    // ── 1. Slug do workflow ───────────────────────────────────────────────────
    const wfRes     = await fetch('https://api.music.ai/v1/workflow?size=100', { headers: { Authorization: API_KEY } });
    const wfData    = await wfRes.json();
    const workflows = wfData.workflows || [];
    const noteWf    = workflows.find(w => /note\s*map/i.test(w.name));

    if (!noteWf) {
      return res.status(404).json({
        error: 'Workflow "Note Mapping" não encontrado.',
        available: workflows.map(w => w.name),
      });
    }

    // ── 2. Cria job ───────────────────────────────────────────────────────────
    const jobRes  = await fetch('https://api.music.ai/v1/job', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ name: 'Tone-ID note mapping', workflow: noteWf.slug, params: { inputUrl } }),
    });
    const jobData = await jobRes.json();
    if (!jobData.id) return res.status(500).json({ error: 'Falha ao criar job.', detail: jobData });

    // ── 3. Polling ────────────────────────────────────────────────────────────
    let rawResult = null;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const sd = await (await fetch(`https://api.music.ai/v1/job/${jobData.id}`, { headers: { Authorization: API_KEY } })).json();
      if (sd.status === 'SUCCEEDED') { rawResult = sd.result; break; }
      if (sd.status === 'FAILED') return res.status(500).json({ error: 'Job falhou.', detail: sd.error });
    }
    if (!rawResult) return res.status(500).json({ error: 'Timeout após 5 minutos.' });

    // ── 4. Baixa o CSV ────────────────────────────────────────────────────────
    // Tenta os dois arquivos disponíveis, na ordem de preferência
    const urls = [
      rawResult['pitch tracker with timestamps'],
      rawResult['pitch map'],
    ].filter(Boolean);

    if (!urls.length) {
      return res.status(500).json({ error: 'Nenhuma URL de pitch encontrada.', keys: Object.keys(rawResult) });
    }

    let csvText = null;
    for (const url of urls) {
      try {
        const r = await fetch(url);
        if (r.ok) { csvText = await r.text(); break; }
      } catch (_) {}
    }

    if (!csvText) return res.status(500).json({ error: 'Falha ao baixar CSV.' });

    // ── 5. Parseia ────────────────────────────────────────────────────────────
    const noteEvents = parsePianoRoll(csvText);
    const analysis   = analyzeNotes(noteEvents);

    return res.status(200).json({
      workflowUsed: noteWf.name,
      parsedEvents: noteEvents.length,
      noteEvents:   noteEvents.slice(0, 4000),
      ...analysis,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── Parser piano roll ─────────────────────────────────────────────────────────
// Formato confirmado do Music AI:
//   Header:  0,1,2,...,127       (índices MIDI como nomes de coluna)
//   Dados:   <act_0>,<act_1>,...  (probabilidade 0-1 por nota, por frame)
//   Variante com tempo: time,0,1,...,127
//
// Frame rate padrão: 100 fps (0.01s por frame)

const CHROMATIC  = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const FRAME_RATE = 0.01;
const MIN_ACT    = 0.05;  // limiar mínimo de ativação (baixo para não perder nada)
const MIDI_LO    = 36;    // C2
const MIDI_HI    = 96;    // C7

function midiToHz(m)   { return +(440 * Math.pow(2, (m - 69) / 12)).toFixed(2); }
function midiToName(m) { return m>=0&&m<=127 ? CHROMATIC[((m%12)+12)%12]+(Math.floor(m/12)-1) : null; }

function parsePianoRoll(raw) {
  // Normaliza TODOS os tipos de quebra de linha antes de qualquer split
  const lines = raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g,   '\n')
    .trim()
    .split('\n')
    .filter(l => l.trim());

  if (lines.length < 2) return [];

  const headerCols = lines[0].split(',').map(s => s.trim());

  // Detecta se há coluna de tempo na primeira posição
  const hasTime    = isNaN(parseInt(headerCols[0]));
  const dataOffset = hasTime ? 1 : 0;
  const midiCols   = headerCols.slice(dataOffset).map(h => parseInt(h));

  // Se o header não é piano roll (MIDI 0-127), tenta formato convencional
  if (midiCols.length === 0 || midiCols.some(isNaN)) {
    return parseFallback(lines);
  }

  const events = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',').map(s => parseFloat(s) || 0);
    const time  = hasTime ? vals[0] : (i - 1) * FRAME_RATE;

    // Nota com maior ativação dentro do range vocal
    let bestMidi = -1, bestAct = MIN_ACT;
    for (let j = 0; j < midiCols.length; j++) {
      const midi = midiCols[j];
      const act  = vals[j + dataOffset] || 0;
      if (midi >= MIDI_LO && midi <= MIDI_HI && act > bestAct) {
        bestMidi = midi;
        bestAct  = act;
      }
    }

    if (bestMidi >= 0) {
      events.push({ time: +time.toFixed(3), hz: midiToHz(bestMidi), note: midiToName(bestMidi), midi: bestMidi });
    }
  }
  return events;
}

// Fallback para formato time,frequency,confidence
function parseFallback(lines) {
  const h  = lines[0].toLowerCase().split(',').map(s => s.trim());
  const ti = h.findIndex(c => c.includes('time') || c === 't');
  const fi = h.findIndex(c => ['freq','hz','f0','pitch','frequency','midi'].some(k => c.includes(k)));
  const ci = h.findIndex(c => c.includes('conf') || c.includes('prob'));
  const events = [];
  for (let i = 1; i < lines.length; i++) {
    const c    = lines[i].split(',');
    const time = ti >= 0 ? parseFloat(c[ti]) : (i - 1) * FRAME_RATE;
    let   hz   = fi >= 0 ? parseFloat(c[fi]) : 0;
    // Se a coluna for 'midi', converte para Hz
    if (h[fi] === 'midi' || h[fi] === 'midi_pitch') hz = hz > 0 ? midiToHz(Math.round(hz)) : 0;
    const conf = ci >= 0 ? parseFloat(c[ci]) : 1;
    if (hz > 40 && hz < 4200 && conf >= MIN_ACT) {
      const midi = Math.round(12 * Math.log2(hz / 440) + 69);
      events.push({ time: +time.toFixed(3), hz, note: midiToName(midi), midi });
    }
  }
  return events;
}

// ── Análise ───────────────────────────────────────────────────────────────────
const NOTE_IDX = Object.fromEntries(CHROMATIC.map((n, i) => [n, i]));

function noteAt(root, sem, oct) {
  const t = (NOTE_IDX[root] ?? 0) + sem;
  return CHROMATIC[((t % 12) + 12) % 12] + (oct + Math.floor(t / 12));
}
function midiOf(root, sem, oct) {
  const t = (NOTE_IDX[root] ?? 0) + sem;
  return (oct + Math.floor(t / 12) + 1) * 12 + ((t % 12) + 12) % 12;
}
function bestNote(root, sem) {
  let best = null, bestDist = Infinity;
  for (let o = 2; o <= 6; o++) {
    const m = midiOf(root, sem, o);
    if (m >= 48 && m <= 84) {
      const d = Math.abs(m - 64);
      if (d < bestDist) { bestDist = d; best = noteAt(root, sem, o); }
    }
  }
  return best || noteAt(root, sem, 4);
}

function analyzeNotes(events) {
  const valid = (events || []).filter(e => e.midi >= 24 && e.midi <= 108);

  if (!valid.length) {
    return {
      range: null, centerNote: null, lowestNote: null, highestNote: null, semitones: 0,
      tecnicas: [{ nome: 'Nenhuma nota detectada', descricao: 'Tente enviar um arquivo com voz clara gravada sem muito ruído de fundo.' }],
      midi: { root:['C4','C5'], harmony:['E4','G4','E5'], color:['A4','D5'] },
    };
  }

  const midis   = valid.map(e => e.midi);
  const lo      = Math.min(...midis), hi = Math.max(...midis);
  const center  = Math.round(midis.reduce((a, b) => a + b, 0) / midis.length);
  const toName  = m => CHROMATIC[((m%12)+12)%12] + (Math.floor(m/12)-1);
  const loNote  = toName(lo), hiNote = toName(hi), cNote = toName(center);
  const semi    = hi - lo;
  const rm      = cNote.match(/^([A-G][#]?)/);
  const root    = rm ? rm[1] : 'C';
  const isMinor = center < 60;
  const third   = isMinor ? 3 : 4;
  const sixth   = isMinor ? 8 : 9;

  return {
    lowestNote: loNote, highestNote: hiNote, centerNote: cNote,
    semitones: semi, range: `${loNote} — ${hiNote}`,
    tecnicas: [
      { nome: 'Harmonia em terça acima',  descricao: `Sua voz ficou centrada em torno de ${cNote}. Cante uma terça ${isMinor?'menor':'maior'} acima para o backing mais natural.` },
      { nome: 'Harmonia em terça abaixo', descricao: `Tente uma terça abaixo de ${cNote}. Com extensão de ${loNote} a ${hiNote} há espaço para harmonias graves.` },
      { nome: semi >= 12 ? 'Dobramento em oitava' : 'Stacked vocals na região central',
        descricao: semi >= 12
          ? `Extensão de ${semi} semitons — experimente dobrar as partes graves uma oitava acima para adicionar brilho.`
          : `Grave 3 camadas próximas de ${cNote} com leve detuning (±10 cents) para um coral encorpado.` },
      { nome: 'Pad vocal sustentado', descricao: `Segure ${bestNote(root,0)} com vibrato suave no final. Grave com intensidade baixa para não sobrepor a voz principal.` },
    ],
    midi: {
      root:    [bestNote(root,0),     noteAt(root,0,   parseInt(bestNote(root,0).slice(-1))+1)].filter((v,i,a)=>a.indexOf(v)===i),
      harmony: [bestNote(root,third), bestNote(root,7)],
      color:   [bestNote(root,sixth), bestNote(root,2)],
    },
  };
}