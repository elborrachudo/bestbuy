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
// Monthly commodity LINES served from commodity_monthly (symbol is whitelisted here — it goes into the PostgREST filter).
const COMMODITIES = {
  XAGUSD: { source: 'Silver: World Bank Pink Sheet monthly average (1960–) · USGS annual (1900–1959) · FRED London bar silver, annual (1833–1899) · USD per troy oz',
            note: 'Pre-1960 months repeat the annual value. 1833–1899 is London bar silver, not a New York price. Published to 0.1 USD/oz (up to ~±5% rounding at 1960s levels). Not recorded daily.' },
  XPTUSD: { source: 'Platinum: World Bank Pink Sheet monthly average (1960–) · USGS annual (1880–1959) · USD per troy oz',
            note: 'Pre-1960 months repeat the annual value. Prices up to 1983 are administered producer prices. 1907 is not available in the source (gap). Not recorded daily.' },
};
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

    // ── XAUUSD (gold): monthly LINE from gold_monthly (o=h=l=c=price; it is a line, never
    //    rendered as candles). Includes provisional flags + a meta block (source/licence). ─────
    if (coin === 'XAUUSD') {
      const rows = await sbSelectAll(base, key, 'gold_monthly?select=month,price,source,provisional,n_days&order=month.asc');
      const candles = rows.map((r) => { const p = n(r.price); return { t: r.month, o: p, h: p, l: p, c: p, provisional: !!r.provisional, n_days: r.n_days == null ? null : Number(r.n_days) }; }).filter((d) => d.c != null);
      const last = candles.length ? candles[candles.length - 1].t : null;
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
      res.status(200).json({ ok: true, tier: 'monthly', coin, count: candles.length,
        first: candles.length ? candles[0].t : null, last,
        meta: { source: 'World Gold Council / Timothy Green (1833–1959), World Bank Pink Sheet monthly avg (1960–)', licence: 'ODC-PDDL-1.0', updated: last },
        candles });
      return;
    }

    // ── XCUUSD.P (copper futures): monthly OHLC candles from copper_monthly (COMEX copper futures, USD/lb).
    //    Real exchange candles + the 1989-09 gap (all null) + provisional (snapshot-built) months,
    //    with a quality flag per candle. The frontend applies wick adjustment / gap whitespace.
    //    (Renamed from XCUUSD on 2026-10-18; the bare symbol is NOT aliased — it is reserved for another asset.) ─────
    if (coin === 'XCUUSD.P') {
      const rows = await sbSelectAll(base, key, 'copper_monthly?select=month,open,high,low,close,provisional,n_days,quality_flag,source&order=month.asc');
      const candles = rows.map((r) => ({ t: r.month, o: n(r.open), h: n(r.high), l: n(r.low), c: n(r.close), provisional: !!r.provisional, n_days: r.n_days == null ? null : Number(r.n_days), q: r.quality_flag || 'ok', src: r.source }));
      const last = candles.length ? candles[candles.length - 1].t : null;
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
      res.status(200).json({ ok: true, tier: 'monthly', coin, count: candles.length,
        first: candles.length ? candles[0].t : null, last,
        meta: { source: 'COMEX copper futures (continuous) via Investing.com · USD/lb', updated: last },
        candles });
      return;
    }

    // ── XAGUSD / XPTUSD (silver / platinum): monthly LINES from commodity_monthly (o=h=l=c=price). No daily recorder —
    //    the series ends at the last seeded month. Pre-1960 months are an ANNUAL value repeated (ar=true); a source hole
    //    (platinum 1907) is returned as a null month with q='missing_source' — never carried forward or interpolated.
    //    MUST stay ABOVE the unknown-coin guard below, otherwise these coins would be rejected. ─────────────────────────
    if (Object.prototype.hasOwnProperty.call(COMMODITIES, coin)) {
      const spec = COMMODITIES[coin];
      const rows = await sbSelectAll(base, key, `commodity_monthly?symbol=eq.${coin}&select=month,price,annual_repeated,quality_flag&order=month.asc`);
      const candles = rows.map((r) => { const p = n(r.price); return { t: r.month, o: p, h: p, l: p, c: p, ar: !!r.annual_repeated, q: r.quality_flag || 'ok' }; });
      const last = candles.length ? candles[candles.length - 1].t : null;
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
      res.status(200).json({ ok: true, tier: 'monthly', coin, count: candles.length,
        first: candles.length ? candles[0].t : null, last,
        meta: { source: spec.source, note: spec.note, updated: last },
        candles });
      return;
    }

    // ── unknown coin, ANY tier: a coin that is not BTC / a whitelisted 1D coin / a monthly asset handled
    //    above is an error — never a misleading "unknown tier", and never silently BTC's data (tier=1h|1m
    //    previously ignored `coin`). This is what makes a retired symbol (bare XCUUSD) a clean 400. ───────
    if (coin !== 'BTC' && COINS.indexOf(coin) < 0) { res.status(400).json({ ok: false, error: `unknown coin '${coin}'` }); return; }

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
