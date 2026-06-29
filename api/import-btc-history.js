// api/import-btc-history.js — Phase 3. Imports long BTC daily OHLC into btc_history so the
// cycle detector computes a COMPLETE 200-week MA + validates over 3 real cycles.
//
// Keyless sources reachable from Vercel's US region (Binance is 451 here; CryptoCompare now
// needs a key; CoinGecko demo caps at 365d):
//   • Bitstamp  /api/v2/ohlc/btcusd  — BTC/USD daily since 2011-08 (covers all milestones).
//   • Coinbase  /products/BTC-USD/candles — daily since 2015-07 (fallback / gap-fill).
// Idempotent upsert by date. CRON_SECRET. Returns coverage + milestone closes for ±5% check.

import { sbUpsert } from '../lib/tokens.js';

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; bestbuy/1.0)', 'Accept': 'application/json' };
const dstr = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);

// Bitstamp: paginate forward from 2011 (limit 1000 candles/page).
async function fetchBitstamp() {
  const out = new Map();
  let start = Math.floor(new Date('2011-08-01').getTime() / 1000);
  const now = Math.floor(Date.now() / 1000);
  for (let page = 0; page < 40 && start < now; page++) {
    const url = `https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=86400&limit=1000&start=${start}`;
    const r = await fetch(url, { headers: UA });
    if (!r.ok) throw new Error(`bitstamp ${r.status}`);
    const j = await r.json();
    const ohlc = (j && j.data && j.data.ohlc) || [];
    if (!ohlc.length) break;
    let maxT = start;
    for (const c of ohlc) {
      const t = Number(c.timestamp), close = Number(c.close);
      if (close > 0) out.set(dstr(t), {
        date: dstr(t), open: Number(c.open) || null, high: Number(c.high) || null,
        low: Number(c.low) || null, close, volume: Number(c.volume) || null, source: 'bitstamp',
      });
      if (t > maxT) maxT = t;
    }
    if (maxT <= start) break;
    start = maxT + 86400;
  }
  return out;
}

// Coinbase: 300-day windows back from now to 2015-07.
async function fetchCoinbase() {
  const out = new Map();
  const start0 = new Date('2015-07-20').getTime();
  for (let winEnd = Date.now(); winEnd > start0;) {
    const winStart = Math.max(start0, winEnd - 300 * 86400000);
    const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&start=${new Date(winStart).toISOString()}&end=${new Date(winEnd).toISOString()}`;
    const r = await fetch(url, { headers: UA });
    if (!r.ok) throw new Error(`coinbase ${r.status}`);
    const arr = await r.json();                 // [[time, low, high, open, close, volume], …]
    for (const c of arr) {
      const date = dstr(c[0]), close = c[4];
      if (close > 0) out.set(date, { date, open: c[3], high: c[2], low: c[1], close, volume: c[5], source: 'coinbase' });
    }
    winEnd = winStart - 86400000;
  }
  return out;
}

const MILESTONES = {
  '2013-11-30': 1127, '2015-01-15': 172, '2017-12-17': 19800, '2018-12-15': 3200,
  '2021-11-10': 69000, '2022-11-21': 15500, '2025-10-06': 126296,
};

export default async function handler(req, res) {
  const base = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !serviceKey) { res.status(500).json({ ok: false, error: 'missing supabase env' }); return; }
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const q = (req.query && req.query.secret) || '';
    if (q !== secret && (req.headers['authorization'] || '') !== `Bearer ${secret}`) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
  }

  const sources = {};
  let rows = new Map();
  try { rows = await fetchBitstamp(); sources.bitstamp = rows.size; }
  catch (e) { sources.bitstamp_error = e.message; }
  if (rows.size < 1500) {
    try { const cb = await fetchCoinbase(); sources.coinbase = cb.size; for (const [d, v] of cb) if (!rows.has(d)) rows.set(d, v); }
    catch (e) { sources.coinbase_error = e.message; }
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
  res.status(200).json({ ok: true, imported: all.length, first: all[0].date, last: all[all.length - 1].date, sources, milestones });
}
