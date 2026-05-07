// api/insight-vocal.js
// Análise de voz solo:
// 1. Roda "Vocal Separation & Cleanup" para limpar a voz
// 2. Roda "Note Mapping" na voz limpa para detectar pitches
// 3. Lê o CSV retornado e extrai notas por segundo
// 4. Calcula extensão vocal, nota central e sugestões de harmonia

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const API_KEY = process.env.MUSICAI_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: 'MUSICAI_KEY não configurada no servidor.' });
  }

  const { inputUrl } = req.body;
  if (!inputUrl) {
    return res.status(400).json({ error: 'Campo obrigatório: inputUrl' });
  }

  const authHeaders = { Authorization: API_KEY, 'Content-Type': 'application/json' };

  try {
    // ── 1. Busca slugs reais dos workflows ────────────────────────────────────
    const wfRes = await fetch('https://api.music.ai/v1/workflow?size=100', {
      headers: { Authorization: API_KEY },
    });
    const { workflows = [] } = await wfRes.json();

    const cleanupWf = workflows.find((w) => {
      const n = w.name.toLowerCase();
      return n.includes('cleanup') || n.includes('clean up') || n.includes('vocal separation');
    });

    const noteWf = workflows.find((w) => {
      const n = w.name.toLowerCase();
      return n.includes('note mapping') || n.includes('note map') || n.includes('pitch map');
    });

    if (!noteWf) {
      const available = workflows.map((w) => `"${w.name}"`).join(', ');
      return res.status(404).json({
        error: `Workflow "Note Mapping" não encontrado. Crie-o no dashboard a partir do template. Disponíveis: ${available}`,
      });
    }

    // ── 2. Job 1: limpeza da voz (opcional, usa original se não tiver) ────────
    let vocalUrl = inputUrl;

    if (cleanupWf) {
      const cleanRes = await fetch('https://api.music.ai/v1/job', {
        method: 'POST', headers: authHeaders,
        body: JSON.stringify({
          name: 'Tone-ID vocal cleanup',
          workflow: cleanupWf.slug,
          params: { inputUrl },
        }),
      });
      const cleanJob = await cleanRes.json();

      if (cleanRes.ok && cleanJob.id) {
        const cleanResult = await pollUntilDone(cleanJob.id, API_KEY);
        // pega a URL da voz limpa — campo pode variar
        vocalUrl =
          cleanResult?.vocals    ||
          cleanResult?.voice     ||
          cleanResult?.output    ||
          cleanResult?.stem      ||
          inputUrl; // fallback para o original se não encontrar
      }
    }

    // ── 3. Job 2: Note Mapping na voz limpa ───────────────────────────────────
    const noteRes = await fetch('https://api.music.ai/v1/job', {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({
        name: 'Tone-ID note mapping',
        workflow: noteWf.slug,
        params: { inputUrl: vocalUrl },
      }),
    });
    const noteJob = await noteRes.json();

    if (!noteRes.ok || !noteJob.id) {
      return res.status(500).json({ error: 'Falha ao criar job de Note Mapping: ' + JSON.stringify(noteJob) });
    }

    const noteResult = await pollUntilDone(noteJob.id, API_KEY);

    // ── 4. Lê o CSV de pitches ────────────────────────────────────────────────
    // O Note Mapping retorna uma URL para um CSV com colunas: time, frequency, note, etc.
    const csvUrl =
      noteResult?.output    ||
      noteResult?.csv       ||
      noteResult?.pitchMap  ||
      noteResult?.notes     ||
      noteResult?.pitch     ||
      Object.values(noteResult || {}).find((v) => typeof v === 'string' && v.includes('http'));

    if (!csvUrl) {
      return res.status(500).json({
        error: 'Note Mapping não retornou URL de CSV.',
        rawResult: noteResult,
      });
    }

    const csvText = await fetch(csvUrl).then((r) => r.text());
    const points  = parseCsv(csvText);

    if (points.length === 0) {
      return res.status(200).json({
        noNoteDetected: true,
        error: 'Nenhuma nota detectada. Verifique se o arquivo contém voz clara.',
      });
    }

    // ── 5. Calcula estatísticas ───────────────────────────────────────────────
    const stats = calcStats(points);

    return res.status(200).json({
      workflowUsed: noteWf.name,
      usedCleanup:  !!cleanupWf,
      points,        // array de { time, hz, note } para o gráfico
      stats,         // extensão, nota central, sugestões
      tecnicas:      buildTecnicas(stats),
      midi:          buildMidi(stats.centerNote),
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── Polling ───────────────────────────────────────────────────────────────────
async function pollUntilDone(jobId, apiKey) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const r = await fetch(`https://api.music.ai/v1/job/${jobId}`, {
      headers: { Authorization: apiKey },
    });
    const d = await r.json();
    if (d.status === 'SUCCEEDED') return d.result;
    if (d.status === 'FAILED')    throw new Error(`Job ${jobId} falhou: ${JSON.stringify(d.error)}`);
  }
  throw new Error(`Timeout no job ${jobId}`);
}

// ── Parser de CSV ─────────────────────────────────────────────────────────────
// Suporta os formatos mais comuns do Music AI Note Mapping:
// time,frequency,note  |  time,note,octave,confidence  |  start,end,pitch
function parseCsv(text) {
  const lines  = text.trim().split('\n').filter(Boolean);
  if (lines.length < 2) return [];

  const headers = lines[0].toLowerCase().split(',').map((h) => h.trim());
  const points  = [];

  const iTime  = headers.findIndex((h) => h.includes('time')  || h === 'start');
  const iFreq  = headers.findIndex((h) => h.includes('freq')  || h.includes('hz') || h === 'pitch');
  const iNote  = headers.findIndex((h) => h === 'note'        || h.includes('note'));
  const iConf  = headers.findIndex((h) => h.includes('conf')  || h.includes('confidence'));

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map((c) => c.trim());
    const time = iTime  >= 0 ? parseFloat(cols[iTime])  : i;
    const hz   = iFreq  >= 0 ? parseFloat(cols[iFreq])  : null;
    const conf = iConf  >= 0 ? parseFloat(cols[iConf])  : 1;
    let   note = iNote  >= 0 ? cols[iNote] : null;

    // Ignora pontos de baixa confiança ou sem frequência
    if (conf < 0.5) continue;
    if (hz !== null && (hz < 50 || hz > 2100)) continue;

    // Converte Hz para nota se não tiver coluna de note
    if (!note && hz) note = hzToNote(hz);

    if (note && note !== 'N' && !isNaN(time)) {
      points.push({ time: Math.round(time * 10) / 10, hz: hz ? Math.round(hz) : null, note });
    }
  }

  return points;
}

// ── Hz → nome de nota ─────────────────────────────────────────────────────────
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
function hzToNote(hz) {
  if (!hz || hz <= 0) return null;
  const midi   = Math.round(12 * Math.log2(hz / 440) + 69);
  const octave = Math.floor(midi / 12) - 1;
  return NOTE_NAMES[midi % 12] + octave;
}

// ── Nota → número MIDI ────────────────────────────────────────────────────────
function noteToMidi(noteStr) {
  const m = noteStr.match(/^([A-G][#b]?)(-?\d+)$/);
  if (!m) return null;
  const idx = NOTE_NAMES.indexOf(m[1]);
  if (idx < 0) return null;
  return (parseInt(m[2]) + 1) * 12 + idx;
}

// ── Estatísticas ──────────────────────────────────────────────────────────────
function calcStats(points) {
  const midis = points.map((p) => noteToMidi(p.note)).filter(Boolean);
  if (!midis.length) return {};

  const minMidi = Math.min(...midis);
  const maxMidi = Math.max(...midis);
  const avgMidi = Math.round(midis.reduce((a, b) => a + b, 0) / midis.length);

  // Nota mais frequente
  const freq = {};
  midis.forEach((m) => { freq[m] = (freq[m] || 0) + 1; });
  const centerMidi = parseInt(Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0]);

  const midiToName = (m) => NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);

  return {
    lowestNote:  midiToName(minMidi),
    highestNote: midiToName(maxMidi),
    centerNote:  midiToName(centerMidi),
    avgNote:     midiToName(avgMidi),
    rangeOctaves: Math.round((maxMidi - minMidi) / 12 * 10) / 10,
    semitones:   maxMidi - minMidi,
  };
}

// ── Técnicas para voz solo ────────────────────────────────────────────────────
function buildTecnicas(stats) {
  const center = stats.centerNote || 'sua nota central';
  const high   = stats.highestNote || 'sua nota mais alta';
  const low    = stats.lowestNote  || 'sua nota mais baixa';

  return [
    {
      nome: 'Harmonia em terça acima',
      descricao: `Sua voz ficou centrada em ${center}. Experimente gravar um backing vocal uma terça maior acima — isso cria uma harmonia natural e encorpada com sua voz principal.`,
    },
    {
      nome: 'Harmonia em terça abaixo',
      descricao: `Cante uma terça abaixo de ${center} para um backing mais grave e aveludado. Essa técnica é muito usada em música pop e gospel para criar camadas.`,
    },
    {
      nome: `Explore seu registro agudo (acima de ${high})`,
      descricao: `Sua nota mais alta detectada foi ${high}. Tente usar falsete ou voz de cabeça acima dessa nota para criar um backing etéreo e delicado nos refrões.`,
    },
    {
      nome: `Explore seu registro grave (abaixo de ${low})`,
      descricao: `Sua nota mais baixa foi ${low}. Você pode usar esse grave para criar um pad vocal profundo em notas sustentadas como base do backing.`,
    },
    {
      nome: 'Stacked vocals na nota central',
      descricao: `Grave ${center} (sua nota mais frequente) 3 ou mais vezes em faixas separadas, com pequenas variações de timing e vibrato. Isso cria o famoso efeito "coral" de produções modernas.`,
    },
  ];
}

// ── Notas MIDI ────────────────────────────────────────────────────────────────
const CHROMATIC = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const NOTE_IDX  = Object.fromEntries(CHROMATIC.map((n, i) => [n, i]));

function noteAt(root, semitones, octave) {
  const base = NOTE_IDX[root] ?? 0;
  return CHROMATIC[(base + semitones + 12) % 12] + octave;
}

function buildMidi(centerNote) {
  const match  = (centerNote || 'C4').match(/^([A-G][#b]?)(-?\d+)$/);
  const root   = match ? match[1] : 'C';
  const octave = match ? parseInt(match[2]) : 4;

  return {
    root:    [ noteAt(root, 0, octave),   noteAt(root, 0, octave + 1) ],
    harmony: [ noteAt(root, 4, octave),   noteAt(root, 7, octave),
               noteAt(root, 3, octave),   noteAt(root, 7, octave + 1) ],
    color:   [ noteAt(root, 9, octave),   noteAt(root, 2, octave + 1),
               noteAt(root, 11, octave) ],
  };
}
