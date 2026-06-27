// api/cycle-series.js — serves the FULL market-cycle series (≥2011) to the charting screen
// (Screen B). market_cycle already holds btc_price + phase + the 4 indicators per day; this
// just pages past PostgREST's 1000-row cap and returns a compact payload (mobile-first).
// Read-only public data (same as the dashboard's anon reads) — no secret required.

import { sbSelectAll } from '../lib/tokens.js';

const PH = { accumulation: 'accu', rise: 'rise', euphoria: 'euph', correction: 'corr' };
const n = (x) => (x == null || x === '' ? null : Number(x));

export default async function handler(req, res) {
  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) { res.status(500).json({ ok: false, error: 'missing supabase env' }); return; }
  try {
    const rows = await sbSelectAll(base, key, 'market_cycle?select=cycle_date,btc_price,phase,indicator_values&order=cycle_date.asc');
    const series = rows.map((r) => {
      const iv = r.indicator_values || {};
      return {
        t: r.cycle_date,
        c: n(r.btc_price),
        p: PH[r.phase] || 'corr',
        mayer: n(iv.mayer),
        ma200w: n(iv.ma200w),
        pct: n(iv.price_pct),
        partial: iv.ma200w_partial === true || iv.ma200w_partial === 'true',
      };
    }).filter((d) => d.c != null);
    const last = rows.length ? rows[rows.length - 1] : null;
    const liv = last ? (last.indicator_values || {}) : {};
    const current = last ? {
      phase: last.phase,
      confidence: liv.phase_confidence != null ? Math.round(Number(liv.phase_confidence) * 100) : null,
      mayer: n(liv.mayer),
      m2_value: n(liv.m2_value), m2_yoy_pct: n(liv.m2_yoy_pct),
      m2_expanding: liv.m2_expanding === true || liv.m2_expanding === 'true',
      m2_coverage: liv.m2_coverage || null,
    } : null;
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    res.status(200).json({ ok: true, count: series.length, current, series });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
}
