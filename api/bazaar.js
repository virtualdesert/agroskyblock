const https = require('https');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const key = process.env.HYPIXEL_API_KEY;
  if (!key) {
    return res.status(500).json({ success: false, cause: 'API key not configured' });
  }

  try {
    const data = await fetch(`https://api.hypixel.net/v2/skyblock/bazaar?key=${key}`);
    const json = await data.json();
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.status(data.status).json(json);
  } catch (e) {
    return res.status(500).json({ success: false, cause: e.message });
  }
};
