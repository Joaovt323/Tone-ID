// api/job.js
// Cria um job no Music AI com o workflow e a URL do arquivo.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const API_KEY = process.env.MUSICAI_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: 'MUSICAI_KEY não configurada no servidor.' });
  }

  const { name, workflow, inputUrl } = req.body;

  if (!workflow || !inputUrl) {
    return res.status(400).json({ error: 'Campos obrigatórios: workflow e inputUrl.' });
  }

  try {
    const response = await fetch('https://api.music.ai/v1/job', {
      method: 'POST',
      headers: {
        Authorization: API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: name || 'Tone-ID Job',
        workflow,
        params: { inputUrl },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: JSON.stringify(data) });
    }

    // retorna { id } do job criado
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
