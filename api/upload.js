// api/upload.js
// Vercel Serverless Function
// Solicita uma URL de upload assinada ao Music AI e repassa ao front-end.
// A API key NUNCA sai deste servidor.

export default async function handler(req, res) {
  // Apenas GET é permitido
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const API_KEY = process.env.MUSICAI_KEY;
  if (!API_KEY) {
    return res.status(500).json({ error: 'API key not configured on server.' });
  }

  try {
    const response = await fetch('https://api.music.ai/v1/upload', {
      method: 'GET',
      headers: { Authorization: API_KEY },
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();
    // data = { uploadUrl, downloadUrl }
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
