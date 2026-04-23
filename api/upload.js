// api/upload.js
// Pede uma URL de upload assinada ao Music AI e repassa ao front-end.
// A API key fica segura aqui no servidor — nunca vai ao navegador.

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const API_KEY = process.env.MUSICAI_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: 'MUSICAI_KEY não configurada no servidor.' });
  }

  try {
    const response = await fetch('https://api.music.ai/v1/upload', {
      method: 'GET',
      headers: { Authorization: API_KEY },
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: JSON.stringify(data) });
    }

    // retorna { uploadUrl, downloadUrl } ao front-end
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
