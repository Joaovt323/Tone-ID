// api/insight.js
// Insight para música completa (voz + instrumentos)
// Usa workflow "Transcribe Chords" para detectar tonalidade e acordes reais

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
    // ── 1. Busca slug do workflow de acordes ──────────────────────────────────
    const wfRes   = await fetch('https://api.music.ai/v1/workflow?size=100', { headers: { Authorization: API_KEY } });
    const wfData  = await wfRes.json();
    const workflows = wfData.workflows || [];

    const chordsWf = workflows.find((w) => {
      const name = w.name.toLowerCase();
      return name.includes('chord') || name.includes('key') || name.includes('bpm');
    });

    if (!chordsWf) {
      const available = workflows.map((w) => `"${w.name}" → ${w.slug}`).join(' | ');
      return res.status(404).json({ error: `Workflow de acordes não encontrado. Disponíveis: ${available}` });
    }

    // ── 2. Cria job ───────────────────────────────────────────────────────────
    const jobRes  = await fetch('https://api.music.ai/v1/job', {
      method: 'POST', headers: authHeader,
      body: JSON.stringify({ name: 'Tone-ID chord insight', workflow: chordsWf.slug, params: { inputUrl } }),
    });
    const jobData = await jobRes.json();
    if (!jobRes.ok) return res.status(jobRes.status).json({ error: JSON.stringify(jobData) });

    // ── 3. Polling ────────────────────────────────────────────────────────────
    let rawResult = null;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const s  = await fetch(`https://api.music.ai/v1/job/${jobData.id}`, { headers: { Authorization: API_KEY } });
      const sd = await s.json();
      if (sd.status === 'SUCCEEDED') { rawResult = sd.result; break; }
      if (sd.status === 'FAILED') return res.status(500).json({ error: `Job falhou: ${JSON.stringify(sd.error)}` });
    }
    if (!rawResult) return res.status(500).json({ error: 'Timeout: job demorou mais de 5 minutos.' });

    // ── 4. Lê array de acordes ────────────────────────────────────────────────
    let chordArray = [];
    if (Array.isArray(rawResult)) {
      chordArray = rawResult;
    } else if (rawResult.chords && typeof rawResult.chords === 'string' && rawResult.chords.startsWith('http')) {
      const cr = await fetch(rawResult.chords);
      chordArray = await cr.json();
    } else {
      for (const k of ['chords', 'chord', 'result', 'data']) {
        if (Array.isArray(rawResult[k])) { chordArray = rawResult[k]; break; }
      }
    }

    // ── 5. Extrai tonalidade mais frequente ───────────────────────────────────
    const CHORD_FIELDS = ['chord_basic_pop','chord_simple_pop','chord_majmin','chord_basic_jazz','chord_basic_nashville'];
    const freq = {};
    for (const seg of chordArray) {
      let chord = null;
      for (const field of CHORD_FIELDS) {
        if (seg[field] && seg[field] !== 'N' && seg[field] !== 'null') { chord = seg[field]; break; }
      }
      if (chord) freq[chord] = (freq[chord] || 0) + 1;
    }

    const sortedChords  = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    const dominantChord = sortedChords[0]?.[0] || null;
    const topChords     = sortedChords.slice(0, 5).map(([c]) => c);
    const noChord       = sortedChords.length === 0;

    let key = null, scale = 'major';
    if (dominantChord) {
      const match = dominantChord.match(/^([A-G][b#]?)(m(?!aj))?/);
      if (match) { key = match[1]; scale = match[2] ? 'minor' : 'major'; }
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
      { nome: 'Envie um áudio com instrumentos', descricao: 'A detecção de acordes funciona melhor com músicas completas (voz + instrumentos). Tente enviar o áudio original com a faixa instrumental.' },
      { nome: 'Harmonias paralelas em terças', descricao: 'Mesmo sem detectar a tonalidade, você pode cantar um intervalo de terça acima da sua voz principal — é uma técnica segura que funciona na maioria das músicas.' },
      { nome: 'Dobramento em oitava', descricao: 'Dobre sua voz exatamente uma oitava acima ou abaixo. Funciona independentemente da tonalidade e adiciona profundidade à gravação.' },
    ];
  }
  return [
    { nome: 'Harmonias paralelas em terças', descricao: `Cante a mesma melodia um intervalo de terça ${isMinor ? 'menor' : 'maior'} acima ou abaixo na tonalidade de ${keyName}.` },
    { nome: `Stacked vocals em ${keyName} ${isMinor ? 'menor' : 'maior'}`, descricao: `Grave a mesma linha vocal 3 ou mais vezes e empilhe as faixas para um efeito encorpado.` },
    { nome: 'Call and response', descricao: `O backing responde às frases da voz principal com linhas curtas e complementares na tonalidade de ${keyName}.` },
    { nome: 'Pad vocal (notas sustentadas)', descricao: `Sustente a tônica (${keyName}) e a quinta em notas longas e suaves, criando um colchão harmônico.` },
    { nome: 'Dobramento em oitava', descricao: `Dobre a voz principal exatamente uma oitava acima ou abaixo em ${keyName}.` },
  ];
}

const CHROMATIC = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const NOTE_IDX  = Object.fromEntries(CHROMATIC.map((n, i) => [n, i]));
function noteAt(root, semitones, octave) {
  return CHROMATIC[(( NOTE_IDX[root] ?? 0) + semitones + 12) % 12] + octave;
}
function buildMidi(key, scale) {
  const root = (key || 'C').replace(/\s.*/,'').trim();
  const isMinor = scale === 'minor';
  const third = isMinor ? 3 : 4, sixth = isMinor ? 8 : 9;
  return {
    root:    [ noteAt(root, 0, 4),     noteAt(root, 0, 5)     ],
    harmony: [ noteAt(root, third, 4), noteAt(root, 7, 4), noteAt(root, third, 5), noteAt(root, 7, 5) ],
    color:   [ noteAt(root, sixth, 4), noteAt(root, 2, 5),  noteAt(root, 11, 4)   ],
  };
}