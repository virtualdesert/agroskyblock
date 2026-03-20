const https = require('https');

let itemsCache = null;
let itemsCacheTime = 0;
const ITEMS_TTL = 3600 * 1000; // 1 hora

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

function parseSlot(val) {
  if (!val || val === '' || val === 'AIR:0' || val === 'AIR') return null;
  const parts = val.split(':');
  const id  = parts[0];
  const qty = parseInt(parts[parts.length - 1], 10);
  if (!id || id === 'AIR' || isNaN(qty) || qty <= 0) return null;
  return { id, qty };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const key = process.env.HYPIXEL_API_KEY;
  if (!key) {
    return res.status(500).json({ success: false, cause: 'API key not configured' });
  }

  try {
    const now = Date.now();
    const itemsFetch = (itemsCache && now - itemsCacheTime < ITEMS_TTL)
      ? Promise.resolve(itemsCache)
      : get('https://api.hypixel.net/v2/resources/skyblock/items').then(d => {
          itemsCache     = d;
          itemsCacheTime = Date.now();
          return d;
        });

    const [bazaar, itemsData] = await Promise.all([
      get(`https://api.hypixel.net/v2/skyblock/bazaar?key=${key}`),
      itemsFetch,
    ]);

    if (!bazaar.success) throw new Error(bazaar.cause || 'Bazaar error');

    const products = bazaar.products;
    const items    = itemsData.items || [];
    const TAX      = 0.9875;
    const SLOTS    = ['A1','A2','A3','B1','B2','B3','C1','C2','C3'];
    const results  = [];

    for (const item of items) {
      if (!item.recipe) continue;

      const id      = item.id;
      const bazItem = products[id];
      if (!bazItem?.quick_status) continue;

      const qs = bazItem.quick_status;
      if (!qs.buyPrice || !qs.sellPrice || qs.buyPrice <= 0) continue;

      // buyPrice  = sell-order price (what buyers bid = what you receive placing a sell order)
      // sellPrice = instabuy price (what you pay buying instantly)
      const sellOrderPrice = qs.buyPrice;
      const instaSellPrice = qs.sellPrice;
      const sellVolH       = qs.sellMovingWeek / 7 / 24; // sell-order volume / hr
      const buyVolH        = qs.buyMovingWeek  / 7 / 24; // instabuy demand / hr

      // Parse ingredients
      const ingredients = {};
      for (const slot of SLOTS) {
        const ing = parseSlot(item.recipe[slot]);
        if (!ing) continue;
        ingredients[ing.id] = (ingredients[ing.id] || 0) + ing.qty;
      }
      if (!Object.keys(ingredients).length) continue;

      const outputCount = parseInt(item.recipe.count || 1, 10) || 1;

      // Buy-order ingredient cost + insta ingredient cost
      let craftCostBuyOrder = 0;
      let craftCostInsta    = 0;
      let valid             = true;
      let minIngCraftsH     = Infinity; // bottleneck: crafts / hr

      for (const [ingId, qty] of Object.entries(ingredients)) {
        const ingBaz = products[ingId];
        if (!ingBaz?.quick_status?.buyPrice || !ingBaz?.quick_status?.sellPrice) {
          valid = false; break;
        }
        const ingQs        = ingBaz.quick_status;
        craftCostBuyOrder += ingQs.buyPrice  * qty;
        craftCostInsta    += ingQs.sellPrice * qty;
        // How many crafts per hour this ingredient allows
        const ingCraftsH   = (ingQs.buyMovingWeek / 7 / 24) / qty;
        if (ingCraftsH < minIngCraftsH) minIngCraftsH = ingCraftsH;
      }

      if (!valid || !isFinite(minIngCraftsH) || minIngCraftsH <= 0) continue;

      const craftPricePerUnit      = craftCostBuyOrder / outputCount;
      const instaCraftPricePerUnit = craftCostInsta    / outputCount;

      // Gross margin (for display — no tax)
      const craftMarginGross = sellOrderPrice - craftPricePerUnit;
      if (craftMarginGross <= 0) continue;

      // Net margin (with 1.25% sell tax)
      const craftMarginNet  = sellOrderPrice * TAX - craftPricePerUnit;
      if (craftMarginNet <= 0) continue;

      const instaMarginNet  = instaSellPrice * TAX - instaCraftPricePerUnit;

      // Effective production / hr = ingredient-bottleneck crafts × output per craft
      const effectiveProdH = minIngCraftsH * outputCount;

      // Max production per hour: limited by ingredients AND by instabuy demand
      const maxProdH = Math.min(effectiveProdH, buyVolH);

      // Coins per hour: sell-order revenue × min(prod, sell-order volume)
      const coinsPerHour = craftMarginNet * Math.min(effectiveProdH, sellVolH);

      // Insta coins per hour: instasell revenue × min(prod, instabuy demand)
      const instaCoinsPerHour = instaMarginNet > 0
        ? instaMarginNet * Math.min(effectiveProdH, buyVolH)
        : 0;

      results.push({
        id,
        name:                 item.name || id.replace(/_/g, ' '),
        buy_price:            sellOrderPrice,
        one_hour_instabuys:   buyVolH,
        max_prod_h:           maxProdH,
        craft_price:          craftPricePerUnit,
        craft_margin:         craftMarginGross,
        coins_per_hour:       coinsPerHour,
        insta_coins_per_hour: instaCoinsPerHour,
      });
    }

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ success: true, items: results });
  } catch (e) {
    res.status(500).json({ success: false, cause: e.message });
  }
};
