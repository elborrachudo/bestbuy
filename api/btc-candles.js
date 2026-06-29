// api/btc-candles.js — serves BTC candles for the charting screen at a chosen resolution tier.
//   ?tier=daily → btc_history (daily OHLC, 2011→today; time = 'YYYY-MM-DD')
//   ?tier=1h    → btc_1h     (hourly, ~2y rolling; time = UTC epoch seconds)
//   ?tier=1m    → btc_1m     (minute, last 7 days; time = UTC epoch seconds)
// The client aggregates larger buckets (5m/15m from 1m, 4H from 1h, 1W/1M/…/2A from daily)
// on the fly — no per-resolution tables. Read-only; reads stored data, recomputes nothing.

import { sbSelectAll } from '../lib/tokens.js';

const n = (x) => (x == null || x === '' ? null : Number(x));
const secs = (tsStr) => Math.floor(Date.parse(tsStr) / 1000);

// Multi-asset support (Screen B asset selector + overlays). The 10 coins with 1D candles in
// market_history; BTC keeps its deeper btc_history series. Overlay series read market-wide
// columns (market_history@BTC), the present stable/others dominance (dominance_history), and
// the Mayer multiple (market_daily). Coins are whitelisted (they go into the PostgREST filter).
const COINS = ['BTC', 'ETH', 'ADA', 'AVAX', 'BNB', 'DOGE', 'DOT', 'LTC', 'SOL', 'XRP'];
const SERIES = {
  btcd:    { table: 'market_history', filter: 'coin=eq.BTC', col: 'btc_dominance_pct' },
  ethd:    { table: 'market_history', filter: 'coin=eq.BTC', col: 'eth_dominance_pct' },
  fng:     { table: 'market_history', filter: 'coin=eq.BTC', col: 'fear_greed_value' },
  dxy:     { table: 'market_history', filter: 'coin=eq.BTC', col: 'dxy_close' },
  us10y:   { table: 'market_history', filter: 'coin=eq.BTC', col: 'us10y_yield' },
  mcap:    { table: 'market_history', filter: 'coin=eq.BTC', col: 'total_market_cap_calc' },
  stabled: { table: 'dominance_history', filter: '', col: 'stable_d' },
  othersd: { table: 'dominance_history', filter: '', col: 'others_d' },
  mayer:   { table: 'market_daily', filter: '', col: 'mayer' },
};

export default async function handler(req, res) {
  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) { res.status(500).json({ ok: false, error: 'missing supabase env' }); return; }
  const tier = (req.query && req.query.tier) || 'daily';
  const coin = ((req.query && req.query.coin) || 'BTC').toUpperCase();
  const series = req.query && req.query.series;

  try {
    // ── overlay series: { t(date), v } ascending, nulls dropped ──────────────────────────────
    if (series) {
      const spec = SERIES[series];
      if (!spec) { res.status(400).json({ ok: false, error: `unknown series '${series}'` }); return; }
      const path = `${spec.table}?select=date,${spec.col}${spec.filter ? '&' + spec.filter : ''}&order=date.asc`;
      const rows = await sbSelectAll(base, key, path);
      const points = rows.map((r) => ({ t: r.date, v: n(r[spec.col]) })).filter((p) => p.v != null);
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
      res.status(200).json({ ok: true, series, count: points.length, first: points[0] && points[0].t, last: points[points.length - 1] && points[points.length - 1].t, points });
      return;
    }

    // ── non-BTC asset: 1D candles from market_history ────────────────────────────────────────
    if (tier === 'daily' && coin !== 'BTC') {
      if (COINS.indexOf(coin) < 0) { res.status(400).json({ ok: false, error: `unknown coin '${coin}'` }); return; }
      const rows = await sbSelectAll(base, key, `market_history?coin=eq.${coin}&select=date,open,high,low,close,volume&order=date.asc`);
      const candles = rows.map((r) => {
        const c = n(r.close);
        return { t: r.date, o: n(r.open) != null ? n(r.open) : c, h: n(r.high) != null ? n(r.high) : c, l: n(r.low) != null ? n(r.low) : c, c, v: n(r.volume) };
      }).filter((d) => d.c != null);
      const first = candles.length ? candles[0].t : null, last = candles.length ? candles[candles.length - 1].t : null;
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
      res.status(200).json({ ok: true, tier, coin, count: candles.length, first, last, candles });
      return;
    }

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
