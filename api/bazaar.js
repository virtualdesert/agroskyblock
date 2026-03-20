const https = require('https');

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const key = process.env.HYPIXEL_API_KEY;
  if (!key) {
    res.status(500).json({ success: false, cause: 'API key not configured' });
    return;
  }

  const url = `https://api.hypixel.net/v2/skyblock/bazaar?key=${key}`;

  https.get(url, (apiRes) => {
    let body = '';
    apiRes.on('data', chunk => { body += chunk; });
    apiRes.on('end', () => {
      try {
        const json = JSON.parse(body);
        res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
        res.status(apiRes.statusCode).json(json);
      } catch (e) {
        res.status(500).json({ success: false, cause: 'JSON parse error: ' + e.message });
      }
    });
  }).on('error', (e) => {
    res.status(500).json({ success: false, cause: e.message });
  });
};
