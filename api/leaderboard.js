const https  = require('https');
const crypto = require('crypto');

// ---- Upstash Redis HTTP REST helper ----
function upstash(commands) {
  // commands: array of [cmd, ...args] for pipeline
  // or single [cmd, ...args] for single command
  const url    = process.env.UPSTASH_REDIS_REST_URL;
  const token  = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return Promise.reject(new Error('Upstash not configured'));

  const isPipeline = Array.isArray(commands[0]);
  const path   = isPipeline ? '/pipeline' : '';
  const body   = JSON.stringify(isPipeline ? commands : commands);
  const parsed = new URL(url);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + path,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---- Body parser for POST ----
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 4096) reject(new Error('Body too large')); });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch(e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ---- CAPTCHA helpers ----
function generateChallenge(secret) {
  const a   = Math.floor(Math.random() * 15) + 1;
  const b   = Math.floor(Math.random() * 15) + 1;
  const ans = String(a + b);
  const ts  = Date.now();
  const sig = crypto.createHmac('sha256', secret).update(ans + ':' + ts).digest('hex');
  return { question: `${a} + ${b} = ?`, token: sig + ':' + ts };
}

function verifyCaptcha(answer, token, secret) {
  if (!token || !answer) return false;
  const parts = token.split(':');
  if (parts.length !== 2) return false;
  const [sig, ts] = parts;
  const age = Date.now() - parseInt(ts, 10);
  if (age > 5 * 60 * 1000 || age < 0) return false; // expired or future
  const expected = crypto.createHmac('sha256', secret).update(String(answer) + ':' + ts).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
}

// ---- Main handler ----
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const secret = process.env.LEADERBOARD_SECRET;
  if (!secret) { res.status(500).json({ success: false, cause: 'Server not configured' }); return; }

  const urlObj = new URL('http://x' + req.url);
  const action = urlObj.searchParams.get('action');

  // ---- GET challenge ----
  if (req.method === 'GET' && action === 'challenge') {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(generateChallenge(secret));
    return;
  }

  // ---- GET leaderboard ----
  if (req.method === 'GET') {
    try {
      // ZRANGE leaderboard:scores 0 49 BYSCORE REV WITHSCORES
      const result = await upstash(['ZRANGE', 'leaderboard:scores', '+inf', '-inf', 'BYSCORE', 'REV', 'LIMIT', '0', '50', 'WITHSCORES']);
      const raw = (result.result || []);
      const entries = [];
      for (let i = 0; i < raw.length; i += 2) {
        const nick  = raw[i];
        const score = parseFloat(raw[i + 1]);
        // fetch meta
        entries.push({ nickname: nick, totalProfit: score, rank: entries.length + 1, flips: 0 });
      }
      // Fetch flips counts in pipeline
      if (entries.length) {
        const pipeline = entries.map(e => ['HGET', `leaderboard:meta:${e.nickname}`, 'flips']);
        const metaRes  = await upstash(pipeline);
        metaRes.forEach((r, i) => { entries[i].flips = parseInt(r.result, 10) || 0; });
      }
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ success: true, entries });
    } catch(e) {
      res.status(500).json({ success: false, cause: e.message });
    }
    return;
  }

  // ---- POST submit/sync ----
  if (req.method === 'POST') {
    let body;
    try { body = await readBody(req); }
    catch(e) { res.status(400).json({ success: false, cause: e.message }); return; }

    const { nickname, profit, flips, captchaAnswer, captchaToken, syncMode } = body;

    // Validate nickname
    if (!nickname || !/^[a-zA-Z0-9_]{3,20}$/.test(nickname)) {
      res.status(400).json({ success: false, cause: 'Nickname inválido (3-20 chars, letras/números/_).' });
      return;
    }

    // Validate profit
    const profitNum = parseFloat(profit);
    if (isNaN(profitNum) || profitNum < 0 || profitNum > 2_000_000_000_000) {
      res.status(400).json({ success: false, cause: 'Valor de lucro inválido.' });
      return;
    }

    // syncMode doesn't need CAPTCHA (nickname already registered)
    if (!syncMode) {
      if (!verifyCaptcha(captchaAnswer, captchaToken, secret)) {
        res.status(400).json({ success: false, cause: 'CAPTCHA inválido ou expirado.' });
        return;
      }
    }

    try {
      // Rate limit: 1 submit per nickname per 5 minutes
      const lastSubmit = await upstash(['GET', `leaderboard:ratelimit:${nickname}`]);
      if (lastSubmit.result) {
        res.status(429).json({ success: false, cause: 'Aguarde 5 minutos entre atualizações.' });
        return;
      }

      const now   = new Date().toISOString();
      const flipsN = parseInt(flips, 10) || 0;

      // Set score (absolute, not incremental — user sends their total)
      const pipeline = [
        ['ZADD', 'leaderboard:scores', profitNum, nickname],
        ['HSET', `leaderboard:meta:${nickname}`, 'lastSeen', now, 'flips', flipsN],
        ['SET', `leaderboard:ratelimit:${nickname}`, '1', 'EX', '300'], // 5 min TTL
      ];
      // Set joinedAt only if new member
      pipeline.push(['HSETNX', `leaderboard:meta:${nickname}`, 'joinedAt', now]);

      await upstash(pipeline);

      // Get rank (1-based)
      const rankRes = await upstash(['ZREVRANK', 'leaderboard:scores', nickname]);
      const rank    = (rankRes.result !== null && rankRes.result !== undefined) ? rankRes.result + 1 : '?';

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ success: true, rank });
    } catch(e) {
      res.status(500).json({ success: false, cause: e.message });
    }
    return;
  }

  res.status(405).json({ success: false, cause: 'Method not allowed' });
};
