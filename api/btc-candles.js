// api/btc-candles.js — serves BTC candles for the charting screen at a chosen resolution tier.
//   ?tier=daily → btc_history (daily OHLC, 2011→today; time = 'YYYY-MM-DD')
//   ?tier=1h    → btc_1h     (hourly, ~2y rolling; time = UTC epoch seconds)
//   ?tier=1m    → btc_1m     (minute, last 7 days; time = UTC epoch seconds)
// The client aggregates larger buckets (5m/15m from 1m, 4H from 1h, 1W/1M/…/2A from daily)
// on the fly — no per-resolution tables. Read-only; reads stored data, recomputes nothing.

import { sbSelectAll } from '../lib/tokens.js';

const n = (x) => (x == null || x === '' ? null : Number(x));
const secs = (tsStr) => Math.floor(Date.parse(tsStr) / 1000);

export default async function handler(req, res) {
  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) { res.status(500).json({ ok: false, error: 'missing supabase env' }); return; }
  const tier = (req.query && req.query.tier) || 'daily';
  try {
    let candles = [];
    if (tier === 'daily') {
      const rows = await sbSelectAll(base, key, 'btc_history?select=date,open,high,low,close,volume&order=date.asc');
      candles = rows.map((r) => {
        const c = n(r.close);
        return { t: r.date, o: n(r.open) != null ? n(r.open) : c, h: n(r.high) != null ? n(r.high) : c,
                 l: n(r.low) != null ? n(r.low) : c, c, v: n(r.volume) };
      }).filter((d) => d.c != null);
    } else if (tier === '1h' || tier === '1m') {
      const table = tier === '1h' ? 'btc_1h' : 'btc_1m';
      const rows = await sbSelectAll(base, key, `${table}?select=ts,open,high,low,close,volume&order=ts.asc`);
      candles = rows.map((r) => {
        const c = n(r.close);
        return { t: secs(r.ts), o: n(r.open) != null ? n(r.open) : c, h: n(r.high) != null ? n(r.high) : c,
                 l: n(r.low) != null ? n(r.low) : c, c, v: n(r.volume) };
      }).filter((d) => d.c != null && Number.isFinite(d.t));
    } else {
      res.status(400).json({ ok: false, error: `unknown tier '${tier}'` }); return;
    }
    const first = candles.length ? candles[0].t : null, last = candles.length ? candles[candles.length - 1].t : null;
    res.setHeader('Cache-Control', tier === '1m'
      ? 's-maxage=120, stale-while-revalidate=300'      // minute tier moves fast
      : 's-maxage=1800, stale-while-revalidate=3600');
    res.status(200).json({ ok: true, tier, count: candles.length, first, last, candles });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
}
