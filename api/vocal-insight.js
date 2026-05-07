// api/vocal-insight.js
// Insight para voz solo usando "Note Mapping" + "Vocal Separation & Cleanup"
// Retorna: notas detectadas por segundo, extensão vocal, nota central, sugestões de harmonia

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const API_KEY = process.env.MUSICAI_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'MUSICAI_KEY não configurada.' });

  const { inputUrl } = req.body;
  if (!inputUrl) return res.status(400).json({ error: 'Campo obrigatório: inputUrl' });

  const authHeader = { Authorization: API_KEY, 'Content-Type': 'application/json' };

  try {
    // ── 1. Busca workflows disponíveis ────────────────────────────────────────
    const wfRes     = await fetch('https://api.music.ai/v1/workflow?size=100', { headers: { Authorization: API_KEY } });
    const wfData    = await wfRes.json();
    const workflows = wfData.workflows || [];

    const noteWf = workflows.find((w) => {
      const name = w.name.toLowerCase();
      return name.includes('note map') || name.includes('note mapping');
    });

    const cleanupWf = workflows.find((w) => {
      const name = w.name.toLowerCase();
      return name.includes('cleanup') || name.includes('separation') && name.includes('vocal');
    });

    if (!noteWf) {
      const available = workflows.map((w) => `"${w.name}" → ${w.slug}`).join(' | ');
      return res.status(404).json({ error: `Workflow "Note Mapping" não encontrado. Disponíveis: ${available}` });
    }

    // ── 2. Job de cleanup (opcional — melhora precisão) ───────────────────────
    let vocalUrl = inputUrl;
    if (cleanupWf) {
      const cleanRes  = await fetch('https://api.music.ai/v1/job', {
        method: 'POST', headers: authHeader,
        body: JSON.stringify({ name: 'Tone-ID vocal cleanup', workflow: cleanupWf.slug, params: { inputUrl } }),
      });
      const cleanData = await cleanRes.json();
      if (cleanRes.ok && cleanData.id) {
        for (let i = 0; i < 36; i++) {
          await new Promise((r) => setTimeout(r, 5000));
          const s  = await fetch(`https://api.music.ai/v1/job/${cleanData.id}`, { headers: { Authorization: API_KEY } });
          const sd = await s.json();
          if (sd.status === 'SUCCEEDED') {
            vocalUrl = sd.result?.vocals || sd.result?.voice || sd.result?.output || inputUrl;
            break;
          }
          if (sd.status === 'FAILED') break; // continua com o áudio original
        }
      }
    }

    // ── 3. Job de Note Mapping ────────────────────────────────────────────────
    const noteRes  = await fetch('https://api.music.ai/v1/job', {
      method: 'POST', headers: authHeader,
      body: JSON.stringify({ name: 'Tone-ID note mapping', workflow: noteWf.slug, params: { inputUrl: vocalUrl } }),
    });
    const noteData = await noteRes.json();
    if (!noteRes.ok) return res.status(noteRes.status).json({ error: JSON.stringify(noteData) });

    // ── 4. Polling do Note Mapping ────────────────────────────────────────────
    let rawResult = null;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const s  = await fetch(`https://api.music.ai/v1/job/${noteData.id}`, { headers: { Authorization: API_KEY } });
      const sd = await s.json();
      if (sd.status === 'SUCCEEDED') { rawResult = sd.result; break; }
      if (sd.status === 'FAILED') return res.status(500).json({ error: `Job falhou: ${JSON.stringify(sd.error)}` });
    }
    if (!rawResult) return res.status(500).json({ error: 'Timeout: job demorou mais de 5 minutos.' });

    // ── 5. Lê o CSV/JSON de notas ─────────────────────────────────────────────
    // O Note Mapping retorna um CSV ou JSON com colunas: time, frequency/pitch, note, confidence
    let noteEvents = [];

    const csvUrl = rawResult.csv || rawResult.output || rawResult.pitchMap ||
                   rawResult.notes || rawResult.pitch || null;

    if (csvUrl && typeof csvUrl === 'string' && csvUrl.startsWith('http')) {
      const csvRes  = await fetch(csvUrl);
      const csvText = await csvRes.text();
      noteEvents = parseNoteCSV(csvText);
    } else if (Array.isArray(rawResult)) {
      noteEvents = rawResult;
    } else {
      // tenta encontrar array em qualquer chave
      for (const k of Object.keys(rawResult)) {
        if (Array.isArray(rawResult[k])) { noteEvents = rawResult[k]; break; }
      }
    }

    // ── 6. Analisa as notas ───────────────────────────────────────────────────
    const analysis = analyzeNotes(noteEvents);

    return res.status(200).json({
      workflowUsed: noteWf.name,
      cleanupUsed:  !!cleanupWf,
      noteEvents,   // array de { time, hz, note } para o gráfico de linha
      ...analysis,  // range, centerNote, tecnicas, midi
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── Parser de CSV do Note Mapping ─────────────────────────────────────────────
// Formato esperado: time,frequency,note,confidence (ou variações)
function parseNoteCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const header = lines[0].toLowerCase().split(',').map(s => s.trim());
  const timeIdx  = header.findIndex(h => h.includes('time') || h === 't');
  const freqIdx  = header.findIndex(h => h.includes('freq') || h.includes('hz') || h.includes('pitch'));
  const noteIdx  = header.findIndex(h => h === 'note' || h.includes('note_name'));
  const confIdx  = header.findIndex(h => h.includes('conf'));

  const events = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(s => s.trim());
    const time = timeIdx >= 0  ? parseFloat(cols[timeIdx])  : i * 0.01;
    const hz   = freqIdx >= 0  ? parseFloat(cols[freqIdx])  : 0;
    const note = noteIdx >= 0  ? cols[noteIdx]               : hzToNote(hz);
    const conf = confIdx >= 0  ? parseFloat(cols[confIdx])  : 1;
    if (hz > 0 && conf > 0.3) events.push({ time: +time.toFixed(3), hz: +hz.toFixed(2), note });
  }
  return events;
}

// ── Hz → nome da nota ─────────────────────────────────────────────────────────
const CHROMATIC = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
function hzToNote(hz) {
  if (!hz || hz <= 0) return null;
  const midi   = Math.round(12 * Math.log2(hz / 440) + 69);
  const name   = CHROMATIC[midi % 12];
  const octave = Math.floor(midi / 12) - 1;
  return name + octave;
}
function noteToMidi(noteName) {
  const m = noteName.match(/^([A-G][#b]?)(-?\d)$/);
  if (!m) return 60;
  const idx = CHROMATIC.indexOf(m[1]);
  return (parseInt(m[2]) + 1) * 12 + idx;
}

// ── Análise das notas ─────────────────────────────────────────────────────────
function analyzeNotes(events) {
  if (!events || events.length === 0) {
    return {
      range: null, centerNote: null, lowestNote: null, highestNote: null,
      tecnicas: [{ nome: 'Nenhuma nota detectada', descricao: 'O Note Mapping não detectou notas no áudio. Verifique se o arquivo contém voz clara e tente novamente.' }],
      midi: buildMidi('C', 'major'),
    };
  }

  // Filtra notas válidas e ordena por MIDI
  const validNotes = events
    .filter(e => e.note)
    .map(e => ({ ...e, midi: noteToMidi(e.note) }))
    .filter(e => e.midi >= 36 && e.midi <= 96); // C2 a C7

  if (validNotes.length === 0) {
    return {
      range: null, centerNote: null, lowestNote: null, highestNote: null,
      tecnicas: [{ nome: 'Notas fora do alcance vocal', descricao: 'As notas detectadas estão fora do alcance vocal esperado. Verifique a qualidade do áudio.' }],
      midi: buildMidi('C', 'major'),
    };
  }

  const midiValues  = validNotes.map(e => e.midi);
  const lowestMidi  = Math.min(...midiValues);
  const highestMidi = Math.max(...midiValues);
  const centerMidi  = Math.round(midiValues.reduce((a, b) => a + b, 0) / midiValues.length);

  const lowestNote  = hzToNote(440 * Math.pow(2, (lowestMidi - 69) / 12));
  const highestNote = hzToNote(440 * Math.pow(2, (highestMidi - 69) / 12));
  const centerNote  = hzToNote(440 * Math.pow(2, (centerMidi  - 69) / 12));
  const semitones   = highestMidi - lowestMidi;

  // Extrai a raiz da nota central para sugestões de MIDI
  const rootMatch = (centerNote || 'C4').match(/^([A-G][#]?)/);
  const root = rootMatch ? rootMatch[1] : 'C';

  // Determina modo estimado pela posição (heurística simples)
  const scale = centerMidi < 60 ? 'minor' : 'major';

  return {
    lowestNote,
    highestNote,
    centerNote,
    semitones,
    range: `${lowestNote} — ${highestNote}`,
    tecnicas: buildVocalTecnicas(centerNote, lowestNote, highestNote, semitones),
    midi: buildMidi(root, scale),
  };
}

function buildVocalTecnicas(center, low, high, semitones) {
  const rootMatch = (center || 'C4').match(/^([A-G][#]?)/);
  const root      = rootMatch ? rootMatch[1] : '?';

  return [
    {
      nome: 'Harmonia em terça acima',
      descricao: `Sua voz ficou centrada em torno de ${center}. Cante uma terça maior acima desta nota para criar o backing vocal mais natural para a sua extensão.`,
    },
    {
      nome: 'Harmonia em terça abaixo',
      descricao: `Tente cantar uma terça abaixo de ${center}. Com sua extensão de ${low} a ${high}, você tem espaço para explorar harmonias graves encorpadas.`,
    },
    {
      nome: semitones >= 12 ? 'Dobramento em oitava (extensão ampla)' : 'Dobramento em oitava (extensão curta)',
      descricao: semitones >= 12
        ? `Sua extensão de ${semitones} semitons é ampla. Você consegue dobrar a voz em oitava — experimente cantar as partes mais graves uma oitava acima para um efeito brilhante.`
        : `Sua extensão de ${semitones} semitons sugere uma região vocal bem definida. O dobramento em oitava pode ser desafiador — foque nas harmonias em terça e quinta.`,
    },
    {
      nome: 'Stacked vocals na região central',
      descricao: `Grave 3 camadas da mesma linha vocal na região de ${center}. Com leve detuning entre as camadas (±10 cents) o resultado é um coral encorpado e profissional.`,
    },
    {
      nome: 'Pad vocal sustentado em ' + root,
      descricao: `Use sua nota mais confortável (próxima de ${center}) para segurar um pad longo em ${root}. Grave com vibrato suave no final da nota para dar vida ao backing.`,
    },
  ];
}

function buildMidi(key, scale) {
  const NOTE_IDX = Object.fromEntries(CHROMATIC.map((n, i) => [n, i]));
  function noteAt(root, semitones, octave) {
    return CHROMATIC[((NOTE_IDX[root] ?? 0) + semitones + 12) % 12] + octave;
  }
  const root    = (key || 'C').replace(/\s.*/,'').trim();
  const isMinor = scale === 'minor';
  const third   = isMinor ? 3 : 4, sixth = isMinor ? 8 : 9;
  return {
    root:    [ noteAt(root, 0, 4),     noteAt(root, 0, 5)     ],
    harmony: [ noteAt(root, third, 4), noteAt(root, 7, 4), noteAt(root, third, 5), noteAt(root, 7, 5) ],
    color:   [ noteAt(root, sixth, 4), noteAt(root, 2, 5),  noteAt(root, 11, 4)   ],
  };
}
