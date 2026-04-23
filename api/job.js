// api/job.js
// Vercel Serverless Function
// Cria um job no Music AI com o workflow e URL do arquivo enviados pelo front-end.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const API_KEY = process.env.MUSICAI_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: 'API key not configured on server.' });
  }

  const { name, workflow, inputUrl } = req.body;

  if (!workflow || !inputUrl) {
    return res.status(400).json({ error: 'Missing required fields: workflow, inputUrl' });
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

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();
    // data = { id: "uuid-do-job" }
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
