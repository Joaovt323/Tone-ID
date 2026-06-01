// api/insight.js
// Retorna segmentos de acordes com timestamps para a timeline sincronizada
// CORRIGIDO: bug de cálculo de oitava em noteAt + notas MIDI em range vocal real

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

    // ── 4. Normaliza array de segmentos ───────────────────────────────────────
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

    // ── 5. Tonalidade global ──────────────────────────────────────────────────
    const FIELDS = ['chord_simple_pop', 'chord_basic_pop', 'chord_majmin', 'chord_basic_jazz'];
    const freq = {};
    for (const seg of segments) {
      let chord = null;
      for (const f of FIELDS) { if (seg[f] && seg[f] !== 'N') { chord = seg[f]; break; } }
      if (chord) freq[chord] = (freq[chord] || 0) + (seg.end - seg.start);
    }
    const sorted        = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    const dominantChord = sorted[0]?.[0] || null;
    let globalKey = 'C', globalScale = 'major';
    if (dominantChord) {
      const m = dominantChord.match(/^([A-G][#b]?)(m(?!aj)|-)?/);
      if (m) { globalKey = m[1]; globalScale = m[2] ? 'minor' : 'major'; }
    }

    // ── 6. Processa cada segmento ─────────────────────────────────────────────
    const processed = segments
      .filter(seg => seg.end - seg.start > 0.1)
      .map(seg => {
        const chordName = FIELDS.reduce((acc, f) => acc || (seg[f] && seg[f] !== 'N' ? seg[f] : null), null) || null;
        const complex   = (seg.chord_complex_pop && seg.chord_complex_pop !== 'N') ? seg.chord_complex_pop : chordName;
        let root = null, isMinor = false;
        if (chordName) {
          const m = chordName.match(/^([A-G][#b]?)(m(?!aj)|-)?/);
          if (m) { root = m[1]; isMinor = !!m[2]; }
        }
        return {
          start:   seg.start,
          end:     seg.end,
          chord:   chordName,
          complex: complex,
          bass:    seg.bass || null,
          root,
          isMinor,
          noChord: !chordName,
          midi:    root ? buildChordMidi(root, isMinor) : null,
          tips:    root ? buildChordTips(chordName, root, isMinor) : null,
        };
      });

    return res.status(200).json({
      globalKey,
      globalScale,
      workflowUsed: chordsWf.name,
      segments: processed,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITÁRIOS DE NOTAS — CORRIGIDOS
// ═══════════════════════════════════════════════════════════════════════════════
const CHROMATIC = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const NOTE_IDX  = Object.fromEntries(CHROMATIC.map((n, i) => [n, i]));

/**
 * Retorna o nome da nota corretamente calculando a mudança de oitava.
 * Ex: noteAt('G', 7, 4) → 'D5'  (quinta acima de G4, não D4)
 *     noteAt('B', 1, 3) → 'C4'  (semitom acima de B3)
 */
function noteAt(root, semitones, octave) {
  const baseIdx     = NOTE_IDX[root] ?? 0;
  const total       = baseIdx + semitones;
  const noteIdx     = ((total % 12) + 12) % 12;
  const octaveShift = Math.floor(total / 12);
  return CHROMATIC[noteIdx] + (octave + octaveShift);
}

/**
 * Retorna o número MIDI de uma nota (C4 = 60).
 */
function midiOf(root, semitones, octave) {
  const baseIdx     = NOTE_IDX[root] ?? 0;
  const total       = baseIdx + semitones;
  const octaveShift = Math.floor(total / 12);
  return (octave + octaveShift + 1) * 12 + ((total % 12) + 12) % 12;
}

// Range ideal para backing vocals: C3 (48) a C6 (84)
// Centro em E4 (64) — sweet spot para a maioria das vozes
const BV_MIN    = 48;   // C3
const BV_MAX    = 84;   // C6
const BV_CENTER = 64;   // E4

/**
 * Retorna até `count` ocorrências de um tom de acorde dentro do range
 * de backing vocal, priorizando as mais próximas do centro (E4).
 */
function bestNotes(root, semitones, count = 2) {
  const candidates = [];
  for (let oct = 2; oct <= 6; oct++) {
    const midi = midiOf(root, semitones, oct);
    const name = noteAt(root, semitones, oct);
    if (midi >= BV_MIN && midi <= BV_MAX) {
      candidates.push({ name, midi, dist: Math.abs(midi - BV_CENTER) });
    }
  }
  // Ordena por proximidade ao centro e retorna os melhores
  candidates.sort((a, b) => a.dist - b.dist);
  return candidates
    .slice(0, count)
    .sort((a, b) => a.midi - b.midi) // reordena ascendente para exibição
    .map(n => n.name);
}

/**
 * Constrói as notas MIDI sugeridas para um acorde, cobrindo o
 * range de backing vocal real (C3-C6) em vez de fixar oitava 4.
 */
function buildChordMidi(root, isMinor) {
  const third   = isMinor ? 3 : 4;
  const fifth   = 7;
  const sixth   = isMinor ? 8 : 9;
  const seventh = isMinor ? 10 : 11;

  return {
    // tônica em 2 oitavas próximas ao centro vocal
    root: bestNotes(root, 0, 2),
    // terça + quinta (pilares da harmonia)
    harmony: [
      ...bestNotes(root, third, 2),
      ...bestNotes(root, fifth, 1),
    ],
    // cor harmônica: sexta/sétima + nona
    color: [
      ...bestNotes(root, sixth, 1),
      ...bestNotes(root, seventh, 1),
      ...bestNotes(root, 2, 1),  // nona (= 2 semitons, oitava acima)
    ].filter(Boolean),
  };
}

/**
 * Dicas contextuais para o acorde, com referências de notas
 * calculadas no range vocal correto.
 */
function buildChordTips(chord, root, isMinor) {
  const mode     = isMinor ? 'menor' : 'maior';
  const third    = isMinor ? 3 : 4;
  const rootRef  = bestNotes(root, 0,     1)[0] || noteAt(root, 0,     4);
  const thirdRef = bestNotes(root, third, 1)[0] || noteAt(root, third, 4);
  const fifthRef = bestNotes(root, 7,     1)[0] || noteAt(root, 7,     4);

  const tips = [
    `Neste acorde de ${chord}, a nota mais segura para backing é ${rootRef} (tônica) ou ${thirdRef} (terça ${mode}).`,
    `Quinta do acorde: ${fifthRef} — ideal como pad sustentado sobre este trecho.`,
  ];

  if (chord?.includes('maj7') || chord?.includes('Δ')) {
    const maj7ref = bestNotes(root, 11, 1)[0] || noteAt(root, 11, 4);
    tips.push(`Acorde com sétima maior — ${maj7ref} adiciona brilho sofisticado ao backing sem criar tensão.`);
  } else if (chord?.includes('7') && !chord?.includes('maj')) {
    const b7ref  = bestNotes(root, 10, 1)[0] || noteAt(root, 10, 4);
    const maj7ref = bestNotes(root, 11, 1)[0] || noteAt(root, 11, 4);
    tips.push(`Acorde dominante — evite ${maj7ref} no backing (cria tensão excessiva). Use ${b7ref} (sétima menor) para suavizar.`);
  } else if (chord?.includes('dim') || chord?.includes('o')) {
    const t1 = bestNotes(root, 3, 1)[0] || noteAt(root, 3, 4);
    const t2 = bestNotes(root, 4, 1)[0] || noteAt(root, 4, 4);
    tips.push(`Acorde diminuto — use o backing em movimento, não sustentado. Experimente a passagem ${t1} → ${t2}.`);
  } else if (chord?.includes('m') && !chord?.includes('maj')) {
    const maj3ref = bestNotes(root, 4, 1)[0] || noteAt(root, 4, 4);
    tips.push(`Acorde menor — evite a terça maior ${maj3ref} no backing, pois conflita com o modo ${mode}.`);
  }

  return tips;
}