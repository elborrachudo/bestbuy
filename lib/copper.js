// lib/copper.js — XCUUSD (COMEX copper futures, continuous HG) daily recording.
//
// Sister of lib/gold.js. Hosted in api/cron-fetch.js as copperStep(), AFTER the gold step, in its
// OWN try/catch, imported dynamically — a copper failure must never affect the host job OR the gold
// step (lesson from the gold incident: a top-level import crash took the cron down).
//
// Data model (public.copper_monthly / public.copper_daily, RLS on, read server-side via service role):
//   - copper_monthly: the monthly OHLC candle. Real exchange candles are source='investing_csv'
//     (from the owner's Investing.com export, USD/lb). The current month is rebuilt from daily
//     snapshots: source='investing_csv_partial' (the seeded 2026-10, keeping the CSV open and never
//     shrinking its high/low) or 'snapshot_ohlc' (later months, built only from snapshots — high/low
//     are LESS extreme than a real exchange candle). quality_flag ∈ ok|ohlc_incoherent|thin|
//     missing_source_corrupt. The 1989-09 gap is source='gap', all O/H/L/C null.
//   - copper_daily: one HG spot/day (source 'gold_api_hg_spot'; no fallback — honest gap if it fails).
//
// Source priority (a real exchange candle always wins): investing_csv > investing_csv_partial >
// snapshot_ohlc > gap. We never overwrite a higher-rank row with a lower-rank write.

import { sbSelect, sbSelectAll, sbUpsert, sbPatch } from './tokens.js';

const SPOT_HG = 'https://api.gold-api.com/price/HG';   // {name:'Copper', price, symbol:'HG'} — USD/lb, no key
const RANK = { investing_csv: 3, investing_csv_partial: 2, snapshot_ohlc: 1, gap: 0 };

const todayUTC = () => new Date().toISOString().slice(0, 10);
const monthOf = (d) => d.slice(0, 7) + '-01';
function monthAfter(m) { const d = new Date(m + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 7) + '-01'; }

// Spot sanity: finite, > 0, within ±10% of the reference.
export function saneSpot(val, ref) {
  if (val == null || !Number.isFinite(val) || val <= 0) return false;
  if (ref == null || !Number.isFinite(ref) || ref <= 0) return true;
  return Math.abs(val - ref) / ref <= 0.10;
}

async function fetchJson(url) { const r = await fetch(url, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); }

export async function copperStep(base, key, opts = {}) {
  const log = {};
  const today = todayUTC();
  const curMonth = monthOf(today);

  // Gate: once per UTC day.
  try {
    const existing = await sbSelectAll(base, key, `copper_daily?select=date&date=eq.${today}&order=date.asc`);
    if (existing.length && !opts.force) return { skipped: 'already-ran-today', date: today };
  } catch (e) { log.gate_error = e.message; }

  // Reference for the ±10% band: latest copper_daily, else latest non-null copper_monthly.close.
  // sbSelect (NOT sbSelectAll) for the single-row reads — no duplicate `limit` (the gold-step bug).
  let ref = null, refDate = null, refSource = null;
  try {
    const cd = await sbSelect(base, key, 'copper_daily?select=date,price&order=date.desc&limit=1');
    if (cd.length) { ref = Number(cd[0].price); refDate = cd[0].date; refSource = 'daily'; }
    if (ref == null) { const cm = await sbSelect(base, key, 'copper_monthly?select=month,close&close=not.is.null&order=month.desc&limit=1'); if (cm.length) { ref = Number(cm[0].close); refDate = cm[0].month; refSource = 'monthly'; } }
  } catch (e) { log.ref_error = e.message; }

  // Spot — record today's HG price. No fallback. Out-of-band / source down → write nothing.
  let wroteDaily = false;
  try {
    let spot = null;
    if (opts.spotOverride != null) spot = Number(opts.spotOverride);
    else { try { const j = await fetchJson(SPOT_HG); const p = Number(j && j.price); if (Number.isFinite(p) && p > 0) spot = p; } catch (e) { log.spot_fetch_error = e.message; } }
    if (spot == null) { log.spot = 'no-source'; }
    else if (!saneSpot(spot, ref)) {
      log.spot_rejected = { value: spot, ref, reason: 'out-of-band ±10%' };
      if (refSource === 'daily' && refDate) { const daysStale = Math.round((Date.parse(today) - Date.parse(refDate)) / 86400000); if (daysStale >= 5) log.copper_stale_ref = { ref, refDate, daysStale, lastSpot: spot, note: 'reference ≥5 days old — possible real move > ±10%; not written, review needed' }; }
    } else {
      if (!opts.dryRun) await sbUpsert(base, key, 'copper_daily', [{ date: today, price: spot, source: 'gold_api_hg_spot', fetched_at: new Date().toISOString() }], 'date');
      log.spot = { date: today, price: spot, source: 'gold_api_hg_spot' }; wroteDaily = true;
    }
  } catch (e) { log.spot_error = e.message; }

  // Rebuild the CURRENT month's provisional candle from copper_daily snapshots.
  try {
    const snaps = (await sbSelectAll(base, key, `copper_daily?select=date,price&date=gte.${curMonth}&date=lt.${monthAfter(curMonth)}&order=date.asc`)).map((r) => Number(r.price)).filter(Number.isFinite);
    if (snaps.length) {
      const existRows = await sbSelect(base, key, `copper_monthly?select=month,open,high,low,source&month=eq.${curMonth}&limit=1`);
      const exist = existRows[0] || null;
      if (!exist || RANK[exist.source] == null || RANK[exist.source] < RANK.investing_csv) {   // never overwrite a full investing_csv candle
        const snHi = Math.max(...snaps), snLo = Math.min(...snaps), close = snaps[snaps.length - 1];
        let row;
        if (exist && exist.source === 'investing_csv_partial') {
          // keep the CSV open; NEVER shrink the CSV high/low — only extend them
          row = { month: curMonth, open: Number(exist.open), high: Math.max(Number(exist.high), snHi), low: Math.min(Number(exist.low), snLo), close, source: 'investing_csv_partial', provisional: true, quality_flag: 'ok', n_days: snaps.length, updated_at: new Date().toISOString() };
        } else {
          // later month, no CSV row → built only from snapshots (high/low less extreme than a real candle)
          row = { month: curMonth, open: snaps[0], high: snHi, low: snLo, close, source: 'snapshot_ohlc', provisional: true, quality_flag: 'ok', n_days: snaps.length, updated_at: new Date().toISOString() };
        }
        if (!opts.dryRun) await sbUpsert(base, key, 'copper_monthly', [row], 'month');
        log.provisional = row;
      } else { log.provisional = 'kept-investing_csv (real candle wins)'; }
    } else { log.provisional = 'no-snapshots-yet'; }
  } catch (e) { log.provisional_error = e.message; }

  // Finalize: any PAST provisional month built from snapshots/partial → provisional=false (month is over).
  try {
    if (!opts.dryRun) await sbPatch(base, key, 'copper_monthly', `month=lt.${curMonth}&provisional=eq.true&source=in.(snapshot_ohlc,investing_csv_partial)`, { provisional: false, updated_at: new Date().toISOString() });
    log.finalized_past_provisional = true;
  } catch (e) { log.finalize_error = e.message; }

  return log;
}
