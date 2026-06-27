// api/import-btc-intraday.js — seeds the two intraday charting tiers:
//   • btc_1h — 1-hour candles, ~2 years rolling
//   • btc_1m — 1-minute candles, last 7 days
// Source: Bitstamp /api/v2/ohlc/btcusd (step=3600 / step=60), Coinbase fallback for 1h.
// (Binance is 451 from Vercel-US — same reason the daily backbone avoids it.) Idempotent
// upsert by ts. CRON_SECRET. Query ?tier=1h|1m|both (default both).

import { sbDelete } from '../lib/tokens.js';
import { fetchBitstampOhlc, upsertCandles } from '../lib/btcintraday.js';

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; bestbuy/1.0)', 'Accept': 'application/json' };
const iso = (sec) => new Date(sec * 1000).toISOString();

// Coinbase fallback for 1h (granularity 3600, 300 candles/window back from now).
async function fetchCoinbase1h(sinceSec) {
  const out = new Map();
  for (let winEnd = Date.now(); winEnd / 1000 > sinceSec;) {
    const winStart = Math.max(sinceSec * 1000, winEnd - 300 * 3600000);
    const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600&start=${new Date(winStart).toISOString()}&end=${new Date(winEnd).toISOString()}`;
    const r = await fetch(url, { headers: UA });
    if (!r.ok) throw new Error(`coinbase ${r.status}`);
    const arr = await r.json();                 // [[time, low, high, open, close, volume], …]
    for (const c of arr) {
      const t = Number(c[0]), close = c[4];
      if (close > 0) out.set(t, { ts: iso(t), open: c[3], high: c[2], low: c[1], close, volume: c[5], source: 'coinbase' });
    }
    winEnd = winStart - 3600000;
  }
  return out;
}

export default async function handler(req, res) {
  const base = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !serviceKey) { res.status(500).json({ ok: false, error: 'missing supabase env' }); return; }
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const q = (req.query && req.query.secret) || '';
    if (q !== secret && (req.headers['authorization'] || '') !== `Bearer ${secret}`) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
  }
  const tier = (req.query && req.query.tier) || 'both';
  const now = Math.floor(Date.now() / 1000);
  const out = { ok: true, tiers: {} };

  try {
    if (tier === '1h' || tier === 'both') {
      const since = now - 2 * 365 * 86400;       // ~2 years
      let rows = new Map();
      try { rows = await fetchBitstampOhlc(3600, since, 30); out.tiers.h_bitstamp = rows.size; }
      catch (e) { out.tiers.h_bitstamp_error = e.message; }
      if (rows.size < 1000) {
        try { const cb = await fetchCoinbase1h(since); for (const [t, v] of cb) if (!rows.has(t)) rows.set(t, v); out.tiers.h_coinbase = cb.size; }
        catch (e) { out.tiers.h_coinbase_error = e.message; }
      }
      const all = await upsertCandles(base, serviceKey, 'btc_1h', rows);
      await sbDelete(base, serviceKey, 'btc_1h', `ts=lt.${encodeURIComponent(iso(since - 7 * 86400))}`);
      out.tiers.btc_1h = { rows: all.length, first: all[0] && all[0].ts, last: all[all.length - 1] && all[all.length - 1].ts };
    }

    if (tier === '1m' || tier === 'both') {
      const since = now - 7 * 86400;             // last 7 days
      let rows = new Map();
      try { rows = await fetchBitstampOhlc(60, since, 12); out.tiers.m_bitstamp = rows.size; }
      catch (e) { out.tiers.m_bitstamp_error = e.message; }
      const all = await upsertCandles(base, serviceKey, 'btc_1m', rows);
      await sbDelete(base, serviceKey, 'btc_1m', `ts=lt.${encodeURIComponent(iso(since))}`);
      out.tiers.btc_1m = { rows: all.length, first: all[0] && all[0].ts, last: all[all.length - 1] && all[all.length - 1].ts };
    }
  } catch (e) { res.status(502).json({ ok: false, error: e.message, tiers: out.tiers }); return; }

  res.status(200).json(out);
}
