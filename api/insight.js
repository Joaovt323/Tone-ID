// api/insight.js
// Insight para música completa (voz + instrumentos):
// Detecta tonalidade e acordes via "Transcribe Chords"

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

  const authHeader = { Authorization: API_KEY, 'Content-Type': 'application/json' };

  try {
    // ── 1. Busca slug do workflow de acordes ──────────────────────────────────
    const wfRes = await fetch('https://api.music.ai/v1/workflow?size=100', {
      headers: { Authorization: API_KEY },
    });
    const { workflows = [] } = await wfRes.json();

    const chordsWf = workflows.find((w) => {
      const n = w.name.toLowerCase();
      return n.includes('chord') || n.includes('key') || n.includes('bpm');
    });

    if (!chordsWf) {
      const available = workflows.map((w) => `"${w.name}"`).join(', ');
      return res.status(404).json({
        error: `Workflow de acordes não encontrado. Disponíveis: ${available}`,
      });
    }

    // ── 2. Cria job e faz polling ─────────────────────────────────────────────
    const jobRes = await fetch('https://api.music.ai/v1/job', {
      method: 'POST', headers: authHeader,
      body: JSON.stringify({
        name: 'Tone-ID insight',
        workflow: chordsWf.slug,
        params: { inputUrl },
      }),
    });
    const jobData = await jobRes.json();
    if (!jobRes.ok) {
      return res.status(jobRes.status).json({ error: JSON.stringify(jobData) });
    }

    let rawResult = null;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const s  = await fetch(`https://api.music.ai/v1/job/${jobData.id}`, { headers: { Authorization: API_KEY } });
      const sd = await s.json();
      if (sd.status === 'SUCCEEDED') { rawResult = sd.result; break; }
      if (sd.status === 'FAILED')    return res.status(500).json({ error: `Job falhou: ${JSON.stringify(sd.error)}` });
    }
    if (!rawResult) return res.status(500).json({ error: 'Timeout.' });

    // ── 3. Lê array de acordes ────────────────────────────────────────────────
    let chordArray = [];
    if (Array.isArray(rawResult)) {
      chordArray = rawResult;
    } else if (rawResult.chords && typeof rawResult.chords === 'string' && rawResult.chords.startsWith('http')) {
      chordArray = await fetch(rawResult.chords).then((r) => r.json());
    } else {
      for (const k of ['chords','chord','result','data']) {
        if (Array.isArray(rawResult[k])) { chordArray = rawResult[k]; break; }
      }
    }

    // ── 4. Extrai tonalidade dominante ────────────────────────────────────────
    const CHORD_FIELDS = ['chord_basic_pop','chord_simple_pop','chord_majmin','chord_basic_jazz','chord_basic_nashville'];
    const freq = {};
    for (const seg of chordArray) {
      let chord = null;
      for (const field of CHORD_FIELDS) {
        if (seg[field] && seg[field] !== 'N' && seg[field] !== 'null') { chord = seg[field]; break; }
      }
      if (chord) freq[chord] = (freq[chord] || 0) + 1;
    }

    const sorted        = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    const dominantChord = sorted[0]?.[0] || null;
    const topChords     = sorted.slice(0, 5).map(([c]) => c);
    const noChord       = sorted.length === 0;

    let key = null, scale = 'major';
    if (dominantChord) {
      const m = dominantChord.match(/^([A-G][b#]?)(m(?!aj))?/);
      if (m) { key = m[1]; scale = m[2] ? 'minor' : 'major'; }
    }

    return res.status(200).json({
      workflowUsed: chordsWf.name,
      key:          key   || 'Não detectada',
      scale,
      topChords,
      noChordDetected: noChord,
      tecnicas:     buildTecnicas(key, scale, noChord),
      midi:         buildMidi(key, scale),
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function buildTecnicas(key, scale, noChord) {
  const isMinor = scale === 'minor';
  const keyName = key || 'da música';
  if (noChord) {
    return [
      { nome: 'Envie um áudio com instrumentos', descricao: 'A detecção de acordes funciona melhor com músicas completas (voz + instrumentos). Tente o modo de voz solo para análise apenas vocal.' },
      { nome: 'Harmonias paralelas em terças',   descricao: 'Mesmo sem detectar a tonalidade, cantar uma terça acima da voz principal é uma técnica segura que funciona na maioria das músicas.' },
      { nome: 'Dobramento em oitava',             descricao: 'Dobre sua voz exatamente uma oitava acima ou abaixo. Funciona independentemente da tonalidade.' },
    ];
  }
  return [
    { nome: 'Harmonias paralelas em terças',      descricao: `Cante a mesma melodia uma terça ${isMinor?'menor':'maior'} acima ou abaixo na tonalidade de ${keyName}.` },
    { nome: `Stacked vocals em ${keyName}`,        descricao: `Grave a mesma linha vocal 3 ou mais vezes. No modo ${isMinor?'menor':'maior'} de ${keyName} cria um efeito encorpado.` },
    { nome: 'Call and response',                   descricao: `O backing responde às frases da voz principal com linhas curtas em ${keyName}. Ideal para versos.` },
    { nome: 'Pad vocal',                           descricao: `Sustente a tônica (${keyName}) e a quinta em notas longas para criar um colchão harmônico.` },
    { nome: 'Dobramento em oitava',                descricao: `Dobre a voz principal uma oitava acima ou abaixo em ${keyName}. Simples e eficaz.` },
  ];
}

const CHROMATIC = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const NOTE_IDX  = Object.fromEntries(CHROMATIC.map((n, i) => [n, i]));
function noteAt(root, semitones, octave) {
  return CHROMATIC[(( NOTE_IDX[root] ?? 0) + semitones + 12) % 12] + octave;
}
function buildMidi(key, scale) {
  const root  = (key || 'C').replace(/\s.*/,'').trim();
  const third = scale === 'minor' ? 3 : 4;
  const sixth = scale === 'minor' ? 8 : 9;
  return {
    root:    [ noteAt(root,0,4),     noteAt(root,0,5)     ],
    harmony: [ noteAt(root,third,4), noteAt(root,7,4), noteAt(root,third,5), noteAt(root,7,5) ],
    color:   [ noteAt(root,sixth,4), noteAt(root,2,5), noteAt(root,11,4)   ],
  };
}