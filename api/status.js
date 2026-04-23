// api/status.js
// Consulta o status e resultado de um job no Music AI.

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const API_KEY = process.env.MUSICAI_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: 'MUSICAI_KEY não configurada no servidor.' });
  }

  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ error: 'Parâmetro obrigatório: id' });
  }

  try {
    const response = await fetch(`https://api.music.ai/v1/job/${id}`, {
      method: 'GET',
      headers: { Authorization: API_KEY },
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: JSON.stringify(data) });
    }

    // retorna { id, status, result } — status pode ser STARTED, SUCCEEDED ou FAILED
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
