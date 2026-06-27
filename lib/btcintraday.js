// lib/btcintraday.js — fetch + maintain the intraday charting tiers (btc_1h, btc_1m).
// Source: Bitstamp /api/v2/ohlc/btcusd (keyless, reachable from Vercel-US; Binance is 451 here).
// Used by api/import-btc-intraday.js (seed) and api/cron-fetch.js (rolling refresh).

import { sbUpsert, sbDelete } from './tokens.js';

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; bestbuy/1.0)', 'Accept': 'application/json' };
const iso = (sec) => new Date(sec * 1000).toISOString();

// Bitstamp OHLC, paginate forward from `startSec` at `step` seconds (limit 1000/page).
export async function fetchBitstampOhlc(step, startSec, maxPages) {
  const out = new Map();
  let start = startSec;
  const now = Math.floor(Date.now() / 1000);
  for (let page = 0; page < maxPages && start < now; page++) {
    const url = `https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=${step}&limit=1000&start=${start}`;
    const r = await fetch(url, { headers: UA });
    if (!r.ok) throw new Error(`bitstamp ${r.status}`);
    const j = await r.json();
    const ohlc = (j && j.data && j.data.ohlc) || [];
    if (!ohlc.length) break;
    let maxT = start;
    for (const c of ohlc) {
      const t = Number(c.timestamp), close = Number(c.close);
      if (close > 0) out.set(t, {
        ts: iso(t), open: Number(c.open) || null, high: Number(c.high) || null,
        low: Number(c.low) || null, close, volume: Number(c.volume) || null, source: 'bitstamp',
      });
      if (t > maxT) maxT = t;
    }
    if (maxT <= start) break;
    start = maxT + step;
  }
  return out;
}

export async function upsertCandles(base, key, table, rows) {
  const all = [...rows.values()].sort((a, b) => (a.ts < b.ts ? -1 : 1));
  for (let i = 0; i < all.length; i += 500) await sbUpsert(base, key, table, all.slice(i, i + 500), 'ts');
  return all;
}

// Rolling refresh called from the 3×/day cron: top up the recent edge of each tier and keep
// btc_1m to the last 7 days. Best-effort — the caller wraps this in try/catch.
export async function rollIntraday(base, key) {
  const now = Math.floor(Date.now() / 1000);
  const summary = {};
  // 1m: re-fetch the last ~18h (covers the ≤8h gap between cron runs), prune older than 7 days.
  const m = await fetchBitstampOhlc(60, now - 18 * 3600, 2);
  const mAll = await upsertCandles(base, key, 'btc_1m', m);
  await sbDelete(base, key, 'btc_1m', `ts=lt.${encodeURIComponent(iso(now - 7 * 86400))}`);
  summary.btc_1m = { upserted: mAll.length, last: mAll[mAll.length - 1] && mAll[mAll.length - 1].ts };
  // 1h: re-fetch the last ~10 days so the most recent hourly candles close cleanly.
  const h = await fetchBitstampOhlc(3600, now - 10 * 86400, 2);
  const hAll = await upsertCandles(base, key, 'btc_1h', h);
  summary.btc_1h = { upserted: hAll.length, last: hAll[hAll.length - 1] && hAll[hAll.length - 1].ts };
  return summary;
}
