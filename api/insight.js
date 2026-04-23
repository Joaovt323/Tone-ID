// api/insight.js
// Chama a API da Anthropic no servidor para analisar backing vocal.
// A chave ANTHROPIC_KEY nunca vai ao navegador.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_KEY não configurada no servidor.' });
  }

  const { stems } = req.body;
  if (!stems) {
    return res.status(400).json({ error: 'Campo obrigatório: stems' });
  }

  const prompt = `Você é um especialista em técnicas vocais e produção musical.

Uma IA isolou os seguintes stems de um áudio enviado por um músico:
${JSON.stringify(stems)}

Com base nos stems disponíveis, analise e forneça:

1. TÉCNICAS DE BACKING VOCAL recomendadas para complementar esta gravação.
   Para cada técnica, dê: nome e descrição curta de quando e como usar.
   Sugira entre 3 e 5 técnicas (ex: harmonias paralelas, stacked vocals, call and response, etc.)

2. NOTAS MIDI SUGERIDAS para backing vocal.
   Considerando que a voz principal está na região média (C3-C5), sugira de 8 a 12 notas
   divididas em três grupos:
   - "root": fundamental e uníssonos
   - "harmony": terceiras, quintas e oitavas
   - "color": sétimas, nonos e notas de cor

Responda APENAS em JSON válido, sem texto fora do JSON, sem markdown, sem blocos de código:
{
  "tecnicas": [
    { "nome": "...", "descricao": "..." }
  ],
  "midi": {
    "root":    ["C4"],
    "harmony": ["E4", "G4"],
    "color":   ["B4"]
  }
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: JSON.stringify(data) });
    }

    const raw = data.content.map((b) => b.text || '').join('');
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
