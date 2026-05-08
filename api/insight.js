// api/insight.js
// Retorna o array completo de segmentos de acordes com timestamps
// para o frontend montar a timeline interativa sincronizada com o player

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const API_KEY = process.env.MUSICAI_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'MUSICAI_KEY não configurada.' });

  const { inputUrl } = req.body;
  if (!inputUrl) return res.status(400).json({ error: 'Campo obrigatório: inputUrl' });

  const auth = { Authorization: API_KEY, 'Content-Type': 'application/json' };

  try {
    // ── 1. Slug do workflow de acordes ────────────────────────────────────────
    const wfData    = await (await fetch('https://api.music.ai/v1/workflow?size=100', { headers: { Authorization: API_KEY } })).json();
    const workflows = wfData.workflows || [];
    const chordsWf  = workflows.find(w => /chord|key|bpm/i.test(w.name));
    if (!chordsWf) {
      return res.status(404).json({ error: 'Workflow de acordes não encontrado. Disponíveis: ' + workflows.map(w => `"${w.name}"`).join(', ') });
    }

    // ── 2. Cria job ───────────────────────────────────────────────────────────
    const jobData = await (await fetch('https://api.music.ai/v1/job', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ name: 'Tone-ID chord insight', workflow: chordsWf.slug, params: { inputUrl } }),
    })).json();
    if (!jobData.id) return res.status(500).json({ error: 'Falha ao criar job: ' + JSON.stringify(jobData) });

    // ── 3. Polling ────────────────────────────────────────────────────────────
    let rawResult = null;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const sd = await (await fetch(`https://api.music.ai/v1/job/${jobData.id}`, { headers: { Authorization: API_KEY } })).json();
      if (sd.status === 'SUCCEEDED') { rawResult = sd.result; break; }
      if (sd.status === 'FAILED')    return res.status(500).json({ error: 'Job falhou: ' + JSON.stringify(sd.error) });
    }
    if (!rawResult) return res.status(500).json({ error: 'Timeout após 5 minutos.' });

    // ── 4. Normaliza o array de segmentos ─────────────────────────────────────
    let segments = [];
    if (Array.isArray(rawResult)) {
      segments = rawResult;
    } else if (rawResult.chords && typeof rawResult.chords === 'string') {
      segments = await (await fetch(rawResult.chords)).json();
    } else {
      for (const k of ['chords', 'chord', 'result', 'data']) {
        if (Array.isArray(rawResult[k])) { segments = rawResult[k]; break; }
      }
    }

    // ── 5. Extrai tonalidade global (acorde mais frequente = tônica) ──────────
    const FIELDS = ['chord_simple_pop', 'chord_basic_pop', 'chord_majmin', 'chord_basic_jazz'];
    const freq = {};
    for (const seg of segments) {
      let chord = null;
      for (const f of FIELDS) { if (seg[f] && seg[f] !== 'N') { chord = seg[f]; break; } }
      if (chord) freq[chord] = (freq[chord] || 0) + (seg.end - seg.start);
    }
    const sorted        = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    const dominantChord = sorted[0]?.[0] || null;
    let globalKey = 'D#', globalScale = 'major';
    if (dominantChord) {
      const m = dominantChord.match(/^([A-G][#b]?)(m(?!aj)|-)?/);
      if (m) { globalKey = m[1]; globalScale = m[2] ? 'minor' : 'major'; }
    }

    // ── 6. Processa cada segmento para o frontend ─────────────────────────────
    const processed = segments
      .filter(seg => seg.end - seg.start > 0.1) // remove segmentos muito curtos
      .map(seg => {
        const chordName = FIELDS.reduce((acc, f) => acc || (seg[f] !== 'N' ? seg[f] : null), null) || null;
        const complex   = seg.chord_complex_pop !== 'N' ? seg.chord_complex_pop : chordName;
        let root = null, isMinor = false;
        if (chordName) {
          const m = chordName.match(/^([A-G][#b]?)(m(?!aj)|-)?/);
          if (m) { root = m[1]; isMinor = !!m[2]; }
        }
        return {
          start:    seg.start,
          end:      seg.end,
          chord:    chordName,        // ex: "G#m"
          complex:  complex,          // ex: "G#m7" — para exibir versão mais completa
          bass:     seg.bass || null,
          root,
          isMinor,
          noChord:  !chordName,
          midi:     root ? buildChordMidi(root, isMinor) : null,
          tips:     root ? buildChordTips(chordName, root, isMinor, globalKey) : null,
        };
      });

    return res.status(200).json({
      globalKey,
      globalScale,
      workflowUsed: chordsWf.name,
      segments: processed,
      audioUrl: inputUrl, // repassa para o player
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── Notas MIDI para um acorde específico ──────────────────────────────────────
const CHROMATIC = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const NOTE_IDX  = Object.fromEntries(CHROMATIC.map((n, i) => [n, i]));
function noteAt(root, semitones, octave) {
  return CHROMATIC[((NOTE_IDX[root] ?? 0) + semitones + 12) % 12] + octave;
}

function buildChordMidi(root, isMinor) {
  const third = isMinor ? 3 : 4;
  const sixth = isMinor ? 8 : 9;
  return {
    root:    [noteAt(root, 0, 4), noteAt(root, 0, 5)],
    harmony: [noteAt(root, third, 4), noteAt(root, 7, 4), noteAt(root, third, 5), noteAt(root, 7, 5)],
    color:   [noteAt(root, sixth, 4), noteAt(root, 2, 5), noteAt(root, isMinor ? 10 : 11, 4)],
  };
}

// ── Dica contextual por acorde ────────────────────────────────────────────────
function buildChordTips(chord, root, isMinor, globalKey) {
  const mode = isMinor ? 'menor' : 'maior';
  const tips = [
    `Neste acorde de ${chord}, a nota de backing mais segura é ${noteAt(root, 0, 4)} (tônica) ou ${noteAt(root, isMinor ? 3 : 4, 4)} (terça ${mode}).`,
    `Quinta do acorde: ${noteAt(root, 7, 4)} — funciona bem como pad sustentado.`,
  ];
  // tensões específicas por tipo
  if (chord?.includes('maj7') || chord?.includes('Δ')) {
    tips.push(`Acorde com sétima maior — a nota ${noteAt(root, 11, 4)} adiciona brilho suave e sofisticação ao backing.`);
  } else if (chord?.includes('7') && !chord?.includes('maj')) {
    tips.push(`Acorde dominante com sétima — evite a nota ${noteAt(root, 11, 4)} no backing para não criar tensão excessiva. Prefira ${noteAt(root, 10, 4)}.`);
  } else if (chord?.includes('dim') || chord?.includes('o')) {
    tips.push(`Acorde diminuto — notas de passagem. Use o backing com movimentação, não sustentado. Experimente ${noteAt(root, 3, 4)} → ${noteAt(root, 4, 4)}.`);
  } else if (chord?.includes('m') && !chord?.includes('maj')) {
    tips.push(`Acorde menor — o backing em modo ${mode} de ${root} cria profundidade. Evite a terça maior (${noteAt(root, 4, 4)}) que conflita com o modo.`);
  }
  return tips;
}