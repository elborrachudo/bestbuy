// api/import-btc-history.js — Phase 3. Imports long BTC daily OHLC (≥2013) into btc_history
// so the cycle detector computes a COMPLETE 200-week MA + validates over 3 real cycles.
//
// Source: CryptoCompare histoday (keyless, back to ~2010, not geo-blocked from US — Binance
// is 451 here). CoinGecko days=max is a close-only fallback. Idempotent upsert by date.
// Protected by CRON_SECRET. Returns coverage + the backbone-milestone closes for validation.

import { sbUpsert } from '../lib/tokens.js';

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; bestbuy/1.0)', 'Accept': 'application/json' };
const day = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

// CryptoCompare: paginate back with toTs until we reach ~2010 or data runs out.
async function fetchCryptoCompare() {
  const out = new Map();
  let toTs = Math.floor(Date.now() / 1000);
  const floor = Math.floor(new Date('2010-07-01').getTime() / 1000);
  for (let page = 0; page < 8; page++) {
    const url = `https://min-api.cryptocompare.com/data/v2/histoday?fsym=BTC&tsym=USD&limit=2000&toTs=${toTs}`;
    const r = await fetch(url, { headers: UA });
    if (!r.ok) throw new Error(`cryptocompare ${r.status}`);
    const j = await r.json();
    const data = (j && j.Data && j.Data.Data) || [];
    if (!data.length) break;
    for (const d of data) {
      if (d.close > 0) out.set(day(d.time), {
        date: day(d.time), open: d.open, high: d.high, low: d.low, close: d.close,
        volume: d.volumeto != null ? d.volumeto : null, source: 'cryptocompare',
      });
    }
    const oldest = data[0].time;                 // CC returns ascending → [0] is oldest
    if (oldest <= floor || data.every((d) => d.close === 0)) break;
    toTs = oldest - 86400;
  }
  return out;
}

// CoinGecko close-only fallback (days=max → daily for the demo key).
async function fetchCoinGecko(apiKey) {
  const h = { ...UA }; if (apiKey) h['x-cg-demo-api-key'] = apiKey;
  const r = await fetch('https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=max', { headers: h });
  if (!r.ok) throw new Error(`coingecko ${r.status}`);
  const j = await r.json();
  const out = new Map();
  for (const [ms, price] of (j.prices || [])) {
    const date = new Date(ms).toISOString().slice(0, 10);
    if (price > 0) out.set(date, { date, open: null, high: null, low: null, close: price, volume: null, source: 'coingecko' });
  }
  return out;
}

const MILESTONES = {
  '2013-11-30': 1127, '2015-01-15': 172, '2017-12-17': 19800, '2018-12-15': 3200,
  '2021-11-10': 69000, '2022-11-21': 15500, '2025-10-06': 126296,
};

export default async function handler(req, res) {
  const base = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const cgKey = process.env.COINGECKO_API_KEY || null;
  if (!base || !serviceKey) { res.status(500).json({ ok: false, error: 'missing supabase env' }); return; }
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const q = (req.query && req.query.secret) || '';
    if (q !== secret && (req.headers['authorization'] || '') !== `Bearer ${secret}`) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
  }

  const sources = {};
  let rows = new Map();
  try { rows = await fetchCryptoCompare(); sources.cryptocompare = rows.size; }
  catch (e) { sources.cryptocompare_error = e.message; }
  // Fallback / gap-fill with CoinGecko if CC failed or covers little.
  if (rows.size < 1000) {
    try {
      const cg = await fetchCoinGecko(cgKey); sources.coingecko = cg.size;
      for (const [d, v] of cg) if (!rows.has(d)) rows.set(d, v);
    } catch (e) { sources.coingecko_error = e.message; }
  }
  if (!rows.size) { res.status(502).json({ ok: false, error: 'no data from any source', sources }); return; }

  const all = [...rows.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  try {
    for (let i = 0; i < all.length; i += 500) await sbUpsert(base, serviceKey, 'btc_history', all.slice(i, i + 500), 'date');
  } catch (e) { res.status(500).json({ ok: false, error: `upsert: ${e.message}`, sources }); return; }

  const milestones = {};
  for (const [d, expected] of Object.entries(MILESTONES)) {
    const got = rows.get(d);
    const close = got ? Number(got.close) : null;
    milestones[d] = { expected, got: close == null ? null : Math.round(close), ok: close == null ? null : Math.abs(close - expected) / expected <= 0.05 };
  }
  res.status(200).json({
    ok: true, imported: all.length, first: all[0].date, last: all[all.length - 1].date,
    sources, milestones,
  });
}
