// api/insight.js
// 1. Busca os slugs reais dos workflows da conta via GET /workflow
// 2. Roda o workflow de acordes com o slug correto
// 3. Devolve resultado + notas MIDI calculadas ao front-end

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
    // ── 1. Busca todos os workflows da conta e acha o slug de acordes ─────────
    const wfRes = await fetch('https://api.music.ai/v1/workflow?size=100', {
      headers: { Authorization: API_KEY },
    });
    const wfData = await wfRes.json();
    const workflows = wfData.workflows || [];

    // Procura workflow de transcrição de acordes/tonalidade pelo nome
    const chordsWf = workflows.find((w) => {
      const name = w.name.toLowerCase();
      return name.includes('chord') || name.includes('key') || name.includes('bpm');
    });

    if (!chordsWf) {
      const available = workflows.map((w) => `"${w.name}" → ${w.slug}`).join(' | ');
      return res.status(404).json({
        error: `Nenhum workflow de acordes encontrado. Disponíveis: ${available}`,
      });
    }

    // ── 2. Cria o job com o slug real ─────────────────────────────────────────
    const jobRes = await fetch('https://api.music.ai/v1/job', {
      method: 'POST',
      headers: authHeader,
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

    const jobId = jobData.id;

    // ── 3. Polling até SUCCEEDED ou FAILED (máx 5 min) ───────────────────────
    let result = null;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const statusRes = await fetch(`https://api.music.ai/v1/job/${jobId}`, {
        headers: { Authorization: API_KEY },
      });
      const statusData = await statusRes.json();

      if (statusData.status === 'SUCCEEDED') {
        result = statusData.result;
        break;
      }
      if (statusData.status === 'FAILED') {
        return res.status(500).json({
          error: `Job falhou: ${JSON.stringify(statusData.error)}`,
        });
      }
    }

    if (!result) {
      return res.status(500).json({ error: 'Timeout: job demorou mais de 5 minutos.' });
    }

    // ── 4. Extrai tonalidade e monta o insight ────────────────────────────────
    const key   = result.key   || result.root  || result.tone  || null;
    const scale = result.scale || result.mode  || result.type  || 'major';
    const bpm   = result.bpm   || result.tempo || null;

    return res.status(200).json({
      workflowUsed: chordsWf.name,
      key:          key   || 'Não detectada',
      scale:        scale || 'Não detectada',
      bpm:          bpm   || null,
      rawResult:    result,
      tecnicas:     buildTecnicas(key, scale),
      midi:         buildMidi(key, scale),
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── Técnicas baseadas na tonalidade ──────────────────────────────────────────
function buildTecnicas(key, scale) {
  const isMinor = scale && scale.toLowerCase().includes('min');
  const keyName = key || 'detectada';

  return [
    {
      nome: 'Harmonias paralelas em terças',
      descricao: `Cante a mesma melodia um intervalo de terça acima ou abaixo na tonalidade de ${keyName}. Funciona muito bem em refrões e pontes.`,
    },
    {
      nome: isMinor ? 'Stacked vocals em modo menor' : 'Stacked vocals em modo maior',
      descricao: `Grave a mesma linha vocal 3 ou mais vezes e empilhe as faixas. Na tonalidade de ${keyName} ${isMinor ? 'menor' : 'maior'} isso cria um efeito encorpado típico de produções modernas.`,
    },
    {
      nome: 'Call and response',
      descricao: 'O backing responde às frases da voz principal com linhas curtas e complementares, criando um diálogo entre as vozes. Ideal para versos.',
    },
    {
      nome: 'Pad vocal (notas longas)',
      descricao: `Sustente a tônica e a quinta de ${keyName} em notas longas e suaves, criando um colchão harmônico que preenche os espaços da melodia principal.`,
    },
    {
      nome: 'Dobramento em oitava',
      descricao: 'Dobre a voz principal exatamente uma oitava acima ou abaixo. Simples e eficaz para adicionar brilho ou profundidade sem conflitar com a melodia.',
    },
  ];
}

// ── Notas MIDI baseadas na tonalidade ────────────────────────────────────────
const CHROMATIC = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const NOTE_IDX  = Object.fromEntries(CHROMATIC.map((n, i) => [n, i]));

function noteAt(root, semitones, octave) {
  const base = NOTE_IDX[root] ?? 0;
  return CHROMATIC[(base + semitones + 12) % 12] + octave;
}

function buildMidi(key, scale) {
  const root    = (key || 'C').replace(/\s.*/,'').trim();
  const isMinor = scale && scale.toLowerCase().includes('min');
  const third   = isMinor ? 3 : 4;
  const sixth   = isMinor ? 8 : 9;

  return {
    root:    [ noteAt(root, 0, 4),    noteAt(root, 0, 5)    ],
    harmony: [ noteAt(root, third, 4), noteAt(root, 7, 4), noteAt(root, third, 5), noteAt(root, 7, 5) ],
    color:   [ noteAt(root, sixth, 4), noteAt(root, 2, 5),  noteAt(root, 11, 4)   ],
  };
}
