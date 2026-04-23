// api/status.js
// Vercel Serverless Function
// Consulta o status e resultado de um job no Music AI.

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const API_KEY = process.env.MUSICAI_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: 'API key not configured on server.' });
  }

  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ error: 'Missing job id' });
  }

  try {
    const response = await fetch(`https://api.music.ai/v1/job/${id}`, {
      method: 'GET',
      headers: { Authorization: API_KEY },
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();
    // data = { id, status: "SUCCEEDED"|"STARTED"|"FAILED", result: {...} }
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
