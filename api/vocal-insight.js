// api/vocal-insight.js
// Lê explicitamente a chave "pitch map" (com espaço) retornada pelo Note Mapping
// e inclui preview do CSV para diagnosticar o formato

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
        available: workflows.map(w => `"${w.name}" → ${w.slug}`)
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
            if (sd.status === 'SUCCEEDED') { vocalUrl = sd.result?.vocals || sd.result?.voice || sd.result?.output || inputUrl; break; }
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

    // ── 5. Lê a chave "pitch map" (com espaço) ────────────────────────────────
    // O Note Mapping retorna: { "pitch map": "<url>", "pitch tracker with timestamps": "<url>" }
    const pitchMapUrl       = rawResult['pitch map'] || null;
    const pitchTrackerUrl   = rawResult['pitch tracker with timestamps'] || null;
    const csvUrl            = pitchMapUrl || pitchTrackerUrl || null;

    if (!csvUrl) {
      return res.status(500).json({
        error: 'Nenhuma URL de pitch map encontrada no resultado.',
        rawResultKeys: Object.keys(rawResult),
        rawResult,
      });
    }

    // ── 6. Baixa o CSV ────────────────────────────────────────────────────────
    let csvText = '';
    try {
      const csvResp = await fetch(csvUrl);
      if (!csvResp.ok) throw new Error('HTTP ' + csvResp.status);
      csvText = await csvResp.text();
    } catch (e) {
      return res.status(500).json({ error: 'Falha ao baixar CSV: ' + e.message, csvUrl });
    }

    // ── 7. Debug: primeiras linhas do CSV ─────────────────────────────────────
    const csvLines   = csvText.trim().split('\n');
    const csvPreview = csvLines.slice(0, 6).join('\n'); // header + 5 primeiras linhas

    // ── 8. Parseia o CSV com base no formato real ─────────────────────────────
    const noteEvents = parseNoteCSV(csvText);

    // ── 9. Análise ────────────────────────────────────────────────────────────
    const analysis = analyzeNotes(noteEvents);

    return res.status(200).json({
      workflowUsed:  noteWf.name,
      cleanupUsed:   !!cleanupWf && vocalUrl !== inputUrl,
      csvPreview,                           // remove depois de confirmar o formato
      totalRows:     csvLines.length - 1,
      parsedEvents:  noteEvents.length,
      noteEvents:    noteEvents.slice(0, 2000),
      ...analysis,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── Parser CSV flexível ───────────────────────────────────────────────────────
// Suporta múltiplos formatos: CREPE, PESTO, crepe-f0, pitch tracker, etc.
const CHROMATIC = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

function hzToNote(hz) {
  if (!hz || hz <= 0) return null;
  const midi = Math.round(12 * Math.log2(hz / 440) + 69);
  if (midi < 0 || midi > 127) return null;
  return CHROMATIC[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

function noteToMidi(n) {
  const m = n?.match(/^([A-G][#b]?)(-?\d+)$/);
  if (!m) return 60;
  return (parseInt(m[2]) + 1) * 12 + (CHROMATIC.indexOf(m[1]) || 0);
}

function parseNoteCSV(text) {
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const header = lines[0].toLowerCase().split(',').map(s => s.trim().replace(/['"]/g, ''));

  // Mapeamento flexível de colunas — cobre CREPE, PESTO, Music AI e outros
  const ti = header.findIndex(h =>
    h === 'time' || h === 't' || h === 'time(s)' || h === 'timestamp' || h === 'times'
  );
  const fi = header.findIndex(h =>
    h === 'frequency' || h === 'freq' || h === 'hz' || h === 'f0' ||
    h === 'pitch' || h === 'frequency(hz)' || h === 'f0(hz)' || h.includes('freq')
  );
  const ni = header.findIndex(h =>
    h === 'note' || h === 'note_name' || h === 'note name' || h === 'pitch_name' || h === 'midi_note'
  );
  const ci = header.findIndex(h =>
    h === 'confidence' || h === 'conf' || h === 'voiced_prob' || h === 'probability' ||
    h === 'activation' || h.includes('conf')
  );
  const mi = header.findIndex(h =>
    h === 'midi' || h === 'midi_pitch' || h === 'midi pitch' || h === 'pitch_midi'
  );

  const events = [];
  for (let i = 1; i < lines.length; i++) {
    const raw  = lines[i].trim();
    if (!raw)  continue;
    const cols = raw.split(',').map(s => s.trim().replace(/['"]/g, ''));

    const time = ti >= 0 ? parseFloat(cols[ti]) : (i - 1) * 0.01;
    if (isNaN(time)) continue;

    // Hz: tenta coluna de frequência, depois converte de MIDI se disponível
    let hz = fi >= 0 ? parseFloat(cols[fi]) : 0;
    if ((!hz || isNaN(hz)) && mi >= 0) {
      const midiVal = parseFloat(cols[mi]);
      if (!isNaN(midiVal) && midiVal > 0) hz = 440 * Math.pow(2, (midiVal - 69) / 12);
    }
    if (isNaN(hz)) hz = 0;

    // nota: tenta coluna de nota, depois converte de Hz
    let note = (ni >= 0 && cols[ni]) ? cols[ni] : hzToNote(hz);

    // confiança: padrão 1 se não existir
    const conf = ci >= 0 ? parseFloat(cols[ci]) : 1;
    if (isNaN(conf)) continue;

    // filtra: deve ter Hz válido e confiança mínima
    if (hz > 40 && hz < 4200 && conf > 0.05) {
      events.push({ time: +time.toFixed(3), hz: +hz.toFixed(2), note });
    }
  }
  return events;
}

// ── Análise das notas ─────────────────────────────────────────────────────────
function analyzeNotes(events) {
  const valid = (events || [])
    .map(e => ({ ...e, midi: noteToMidi(e.note || hzToNote(e.hz) || 'C4') }))
    .filter(e => e.midi >= 24 && e.midi <= 108);

  if (!valid.length) {
    return {
      range: null, centerNote: null, lowestNote: null, highestNote: null, semitones: 0,
      tecnicas: [{ nome: 'Nenhuma nota detectada', descricao: 'Verifique se o arquivo contém voz clara e tente novamente.' }],
      midi: { root:['C4','C5'], harmony:['E4','G4','E5','G5'], color:['A4','D5','B4'] },
    };
  }

  const midis  = valid.map(e => e.midi);
  const lo     = Math.min(...midis), hi = Math.max(...midis);
  const center = Math.round(midis.reduce((a, b) => a + b, 0) / midis.length);
  const toNote = m => CHROMATIC[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  const loNote = toNote(lo), hiNote = toNote(hi), cNote = toNote(center);
  const semi   = hi - lo;

  const rootMatch = cNote.match(/^([A-G][#]?)/);
  const root      = rootMatch ? rootMatch[1] : 'C';
  const isMinor   = center < 60;
  const third     = isMinor ? 3 : 4, sixth = isMinor ? 8 : 9;

  const NOTE_IDX = Object.fromEntries(CHROMATIC.map((n, i) => [n, i]));
  const noteAt   = (r, s, o) => CHROMATIC[((NOTE_IDX[r] ?? 0) + s + 12) % 12] + o;

  return {
    lowestNote: loNote, highestNote: hiNote, centerNote: cNote,
    semitones:  semi,   range: `${loNote} — ${hiNote}`,
    tecnicas: [
      { nome: 'Harmonia em terça acima',  descricao: `Sua voz ficou centrada em torno de ${cNote}. Cante uma terça ${isMinor?'menor':'maior'} acima para o backing mais natural.` },
      { nome: 'Harmonia em terça abaixo', descricao: `Tente cantar uma terça abaixo de ${cNote}. Com extensão de ${loNote} a ${hiNote} há espaço para harmonias graves.` },
      { nome: semi >= 12 ? 'Dobramento em oitava' : 'Stacked vocals', descricao: semi >= 12 ? `Extensão de ${semi} semitons — experimente dobrar partes graves uma oitava acima.` : `Grave 3 camadas próximas de ${cNote} com leve detuning (±10 cents) para um coral encorpado.` },
      { nome: 'Pad vocal sustentado', descricao: `Segure a nota ${cNote} com vibrato suave. Grave com intensidade baixa para não sobrepor a voz principal.` },
    ],
    midi: {
      root:    [noteAt(root, 0, 4),     noteAt(root, 0, 5)],
      harmony: [noteAt(root, third, 4), noteAt(root, 7, 4), noteAt(root, third, 5), noteAt(root, 7, 5)],
      color:   [noteAt(root, sixth, 4), noteAt(root, 2, 5), noteAt(root, 11, 4)],
    },
  };
}
