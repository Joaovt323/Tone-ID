// api/workflows.js
// Lista os workflows disponíveis na conta e seus slugs.
// Usado internamente para descobrir os slugs corretos de cada workflow.

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const API_KEY = process.env.MUSICAI_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: 'MUSICAI_KEY não configurada no servidor.' });
  }

  try {
    const response = await fetch('https://api.music.ai/v1/workflow?size=100', {
      method: 'GET',
      headers: { Authorization: API_KEY },
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: JSON.stringify(data) });
    }

    // Retorna apenas id, name e slug para facilitar a leitura
    const simplified = (data.workflows || []).map((w) => ({
      id: w.id,
      name: w.name,
      slug: w.slug,
    }));

    return res.status(200).json({ workflows: simplified });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
