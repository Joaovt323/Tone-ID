// api/vocal-insight.js
// Insight de voz solo usando Note Mapping do Music AI
// Lê "pitch tracker with timestamps" (série temporal) como prioridade
// Parser corrigido para formato piano roll (cols = MIDI 0-127) com \r line endings

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
      return res.status(404).json({
        error: 'Workflow "Note Mapping" não encontrado.',
        available: workflows.map(w => w.name),
      });
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
            if (sd.status === 'FAILED') break;
          }
        }
      } catch (_) { /* continua com áudio original */ }
    }

    // ── 3. Job de Note Mapping ────────────────────────────────────────────────
    const njData = await (await fetch('https://api.music.ai/v1/job', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ name: 'Tone-ID note mapping', workflow: noteWf.slug, params: { inputUrl: vocalUrl } }),
    })).json();
    if (!njData.id) return res.status(500).json({ error: 'Falha ao criar job.', detail: njData });

    // ── 4. Polling ────────────────────────────────────────────────────────────
    let rawResult = null;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const sd = await (await fetch(`https://api.music.ai/v1/job/${njData.id}`, { headers: { Authorization: API_KEY } })).json();
      if (sd.status === 'SUCCEEDED') { rawResult = sd.result; break; }
      if (sd.status === 'FAILED') return res.status(500).json({ error: 'Job falhou.', detail: sd.error });
    }
    if (!rawResult) return res.status(500).json({ error: 'Timeout após 5 minutos.' });

    // ── 5. URLs do resultado ──────────────────────────────────────────────────
    // Prioridade: "pitch tracker with timestamps" (série temporal) > "pitch map" (distribuição)
    const trackerUrl = rawResult['pitch tracker with timestamps'] || null;
    const mapUrl     = rawResult['pitch map'] || null;

    if (!trackerUrl && !mapUrl) {
      return res.status(500).json({
        error: 'Nenhuma URL de pitch encontrada no resultado.',
        resultKeys: Object.keys(rawResult),
      });
    }

    // ── 6. Baixa e parseia ────────────────────────────────────────────────────
    let noteEvents = [];

    // Tenta o tracker temporal primeiro
    if (trackerUrl) {
      try {
        const text = await (await fetch(trackerUrl)).text();
        noteEvents  = parsePianoRollCSV(text);
      } catch (e) {
        console.error('Falha ao ler tracker:', e.message);
      }
    }

    // Fallback: pitch map (distribuição geral, sem tempo real)
    if (!noteEvents.length && mapUrl) {
      try {
        const text = await (await fetch(mapUrl)).text();
        noteEvents  = parsePianoRollCSV(text);
      } catch (e) {
        console.error('Falha ao ler pitch map:', e.message);
      }
    }

    const analysis = analyzeNotes(noteEvents);

    return res.status(200).json({
      workflowUsed:  noteWf.name,
      cleanupUsed:   !!cleanupWf && vocalUrl !== inputUrl,
      parsedEvents:  noteEvents.length,
      noteEvents:    noteEvents.slice(0, 3000),
      ...analysis,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PARSER DE PIANO ROLL CSV
// ═══════════════════════════════════════════════════════════════════════════════
//
// Formato retornado pelo Music AI Note Mapping:
//   Header:  0,1,2,...,127         (índices MIDI como colunas)
//   Linhas:  <prob0>,<prob1>,...   (probabilidade de ativação por nota MIDI)
//
//   Variante com timestamp:
//   Header:  time,0,1,2,...,127
//   Linhas:  <t>,<prob0>,...
//
// Line endings podem ser \r\n, \r ou \n — todos normalizados.

const CHROMATIC = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const FRAME_DT  = 0.01;   // segundos por frame (100fps — padrão Music AI)
const MIN_CONF  = 0.15;   // ativação mínima para considerar nota ativa
const MIDI_MIN  = 36;     // C2 — limite inferior da voz humana
const MIDI_MAX  = 96;     // C7 — limite superior (soprano agudo)

function midiToHz(midi)   { return 440 * Math.pow(2, (midi - 69) / 12); }
function midiToName(midi) {
  if (midi < 0 || midi > 127) return null;
  return CHROMATIC[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

function parsePianoRollCSV(text) {
  // Normaliza todos os tipos de quebra de linha
  const lines = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
    .split('\n')
    .filter(l => l.trim());

  if (lines.length < 2) return [];

  const header = lines[0].split(',').map(s => s.trim());

  // Detecta se a primeira coluna é timestamp (não-numérico ou texto "time")
  const firstIsTime = isNaN(parseInt(header[0])) || header[0].toLowerCase().includes('time');
  const midiStart   = firstIsTime ? 1 : 0;

  // Extrai os índices MIDI das colunas
  const midiCols = header.slice(midiStart).map(h => parseInt(h));
  if (midiCols.some(isNaN) || midiCols.length === 0) {
    // Não é formato piano roll — tenta parser convencional
    return parseConventionalCSV(lines);
  }

  const events = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(s => parseFloat(s.trim()));
    const time = firstIsTime ? cols[0] : (i - 1) * FRAME_DT;

    if (isNaN(time)) continue;

    // Encontra a nota MIDI com maior ativação neste frame (dentro do range vocal)
    let bestMidi = -1, bestConf = MIN_CONF - 0.001;
    for (let j = 0; j < midiCols.length; j++) {
      const midi = midiCols[j];
      const conf = cols[j + midiStart] || 0;
      if (midi >= MIDI_MIN && midi <= MIDI_MAX && conf > bestConf) {
        bestMidi = midi;
        bestConf = conf;
      }
    }

    if (bestMidi >= 0) {
      events.push({
        time: +time.toFixed(3),
        hz:   +midiToHz(bestMidi).toFixed(2),
        note: midiToName(bestMidi),
        midi: bestMidi,
      });
    }
  }
  return events;
}

// Parser de fallback para formato convencional (time, frequency, confidence)
function parseConventionalCSV(lines) {
  const header = lines[0].toLowerCase().split(',').map(s => s.trim());
  const ti = header.findIndex(h => h.includes('time') || h === 't');
  const fi = header.findIndex(h => h.includes('freq') || h === 'hz' || h === 'f0' || h.includes('pitch'));
  const ci = header.findIndex(h => h.includes('conf') || h.includes('prob'));

  const events = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(s => s.trim());
    const time = ti >= 0 ? parseFloat(cols[ti]) : (i - 1) * FRAME_DT;
    const hz   = fi >= 0 ? parseFloat(cols[fi]) : 0;
    const conf = ci >= 0 ? parseFloat(cols[ci]) : 1;
    if (hz > 40 && hz < 4200 && conf >= MIN_CONF) {
      const midi = Math.round(12 * Math.log2(hz / 440) + 69);
      events.push({ time: +time.toFixed(3), hz: +hz.toFixed(2), note: midiToName(midi), midi });
    }
  }
  return events;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ANÁLISE DAS NOTAS
// ═══════════════════════════════════════════════════════════════════════════════
const NOTE_IDX = Object.fromEntries(CHROMATIC.map((n, i) => [n, i]));

function noteAt(root, semitones, octave) {
  const base = NOTE_IDX[root] ?? 0;
  const total = base + semitones;
  return CHROMATIC[((total % 12) + 12) % 12] + (octave + Math.floor(total / 12));
}
function midiOf(root, semitones, octave) {
  const base = NOTE_IDX[root] ?? 0;
  const total = base + semitones;
  return (octave + Math.floor(total / 12) + 1) * 12 + ((total % 12) + 12) % 12;
}
function bestNote(root, semitones) {
  const candidates = [];
  for (let oct = 2; oct <= 6; oct++) {
    const midi = midiOf(root, semitones, oct);
    if (midi >= 48 && midi <= 84) candidates.push({ name: noteAt(root, semitones, oct), midi });
  }
  if (!candidates.length) return noteAt(root, semitones, 4);
  candidates.sort((a, b) => Math.abs(a.midi - 64) - Math.abs(b.midi - 64));
  return candidates[0].name;
}

function analyzeNotes(events) {
  const valid = (events || []).filter(e => e.midi >= 24 && e.midi <= 108);

  if (!valid.length) {
    return {
      range: null, centerNote: null, lowestNote: null, highestNote: null, semitones: 0,
      tecnicas: [{ nome: 'Nenhuma nota detectada', descricao: 'Verifique se o arquivo contém voz clara e tente novamente.' }],
      midi: { root: ['C4','C5'], harmony: ['E4','G4','E5','G5'], color: ['A4','D5','B4'] },
    };
  }

  const midis   = valid.map(e => e.midi);
  const lo      = Math.min(...midis), hi = Math.max(...midis);
  const center  = Math.round(midis.reduce((a, b) => a + b, 0) / midis.length);
  const toName  = m => CHROMATIC[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  const loNote  = toName(lo), hiNote = toName(hi), cNote = toName(center);
  const semi    = hi - lo;

  const rootMatch = cNote.match(/^([A-G][#]?)/);
  const root      = rootMatch ? rootMatch[1] : 'C';
  const isMinor   = center < 60;
  const third     = isMinor ? 3 : 4;
  const sixth     = isMinor ? 8 : 9;

  return {
    lowestNote: loNote, highestNote: hiNote, centerNote: cNote,
    semitones:  semi,   range: `${loNote} — ${hiNote}`,
    tecnicas: [
      { nome: 'Harmonia em terça acima',  descricao: `Sua voz ficou centrada em torno de ${cNote}. Cante uma terça ${isMinor?'menor':'maior'} acima para o backing mais natural.` },
      { nome: 'Harmonia em terça abaixo', descricao: `Tente uma terça abaixo de ${cNote}. Com extensão de ${loNote} a ${hiNote} há espaço para harmonias graves encorpadas.` },
      { nome: semi >= 12 ? 'Dobramento em oitava' : 'Stacked vocals', descricao: semi >= 12 ? `Extensão de ${semi} semitons — experimente dobrar partes graves uma oitava acima para adicionar brilho.` : `Grave 3 camadas próximas de ${cNote} com leve detuning (±10 cents) para um coral encorpado.` },
      { nome: 'Pad vocal sustentado', descricao: `Segure ${bestNote(root, 0)} com vibrato suave. Grave com intensidade baixa para criar um colchão sem sobrepor a voz principal.` },
    ],
    midi: {
      root:    [bestNote(root, 0),     noteAt(root, 0,     isMinor ? 3 : 4)].filter((v, i, a) => a.indexOf(v) === i),
      harmony: [bestNote(root, third), bestNote(root, 7)],
      color:   [bestNote(root, sixth), bestNote(root, 2)],
    },
  };
}