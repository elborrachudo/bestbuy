// lib/gold.js — XAUUSD (gold) daily recording + official monthly re-sync.
//
// Hosted inside api/cron-fetch.js (which provably runs daily, 3×/day) as goldStep(),
// AFTER the host job's own writes and wrapped in its own try/catch so a gold failure
// NEVER fails, delays or alters the host job (critical invariant).
//
// Data model (public.gold_monthly / public.gold_daily, RLS on, read server-side via
// the service role through /api/btc-candles):
//   - gold_monthly: the authoritative monthly line. DataHub (World Gold Council /
//     Timothy Green 1833–1959, World Bank Pink Sheet monthly avg 1960–) rows are
//     source='datahub_wgc_wb', provisional=false. The current/unpublished months are
//     source='daily_avg', provisional=true, n_days=N (AVG of gold_daily, WB methodology).
//   - gold_daily: one recorded spot price per UTC day (source 'gold_api_spot' primary,
//     'coingecko_paxg_proxy' fallback). Honest gaps — never fabricate or carry forward.

import { sbSelectAll, sbUpsert, sbSelect } from './tokens.js';

const CSV_URL = 'https://raw.githubusercontent.com/datasets/gold-prices/main/data/monthly-processed.csv';
const SPOT_A  = 'https://api.gold-api.com/price/XAU';
const SPOT_B  = 'https://api.coingecko.com/api/v3/simple/price?ids=pax-gold&vs_currencies=usd';

const todayUTC = () => new Date().toISOString().slice(0, 10);          // 'YYYY-MM-DD'
const monthOf  = (d) => d.slice(0, 7) + '-01';                         // 'YYYY-MM-01'

// Spot sanity: finite, > 0, and within ±10% of the last known value.
export function saneSpot(val, ref) {
  if (val == null || !Number.isFinite(val) || val <= 0) return false;
  if (ref == null || !Number.isFinite(ref) || ref <= 0) return true;   // no reference yet → accept a positive finite value
  return Math.abs(val - ref) / ref <= 0.10;
}

// Parse the DataHub "Date,Price" CSV → [{ month:'YYYY-MM-01', price:Number }]
export function parseGoldCsv(text) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {                             // skip header
    const line = lines[i].trim();
    if (!line) continue;
    const c = line.split(',');
    const d = (c[0] || '').trim();
    const p = Number((c[1] || '').trim());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(p)) continue;
    out.push({ month: d.slice(0, 7) + '-01', price: p });
  }
  return out;
}

async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

// Fetch spot: candidate A (gold-api.com) → fallback B (CoinGecko PAXG proxy, labelled).
async function fetchSpot() {
  try {
    const j = await fetchJson(SPOT_A, { headers: { accept: 'application/json' } });
    const p = Number(j && j.price);
    if (Number.isFinite(p) && p > 0) return { price: p, source: 'gold_api_spot' };
  } catch (e) { /* fall through to B */ }
  try {
    const j = await fetchJson(SPOT_B, { headers: { accept: 'application/json' } });
    const p = Number(j && j['pax-gold'] && j['pax-gold'].usd);
    if (Number.isFinite(p) && p > 0) return { price: p, source: 'coingecko_paxg_proxy' };
  } catch (e) { /* both failed */ }
  return null;
}

// The step. opts: { spotOverride } for dry-run testing (fake spot value, no network),
// { dryRun } to compute+log without writing. Returns a summary (never throws out — the
// caller wraps it, but we also guard here so partial failures still return a summary).
export async function goldStep(base, key, opts = {}) {
  const log = {};
  const today = todayUTC();
  const curMonth = monthOf(today);

  // Gate: once per UTC day. If a spot row already landed today → nothing to do.
  try {
    const existing = await sbSelectAll(base, key, `gold_daily?select=date&date=eq.${today}&order=date.asc`);
    if (existing.length && !opts.force) return { skipped: 'already-ran-today', date: today };
  } catch (e) { log.gate_error = e.message; }

  // (b-first) Official monthly re-sync — also the seed. Fetch the 42 KB CSV and upsert
  // every month as datahub_wgc_wb (always wins over provisional). Doing this before the
  // spot guarantees a reference value exists on the very first run.
  let datahubMax = null;
  try {
    const csv = await (await fetch(CSV_URL)).text();
    const rows = parseGoldCsv(csv);
    if (rows.length) {
      const payload = rows.map((r) => ({ month: r.month, price: r.price, source: 'datahub_wgc_wb', provisional: false, n_days: null, updated_at: new Date().toISOString() }));
      if (!opts.dryRun) {
        for (let i = 0; i < payload.length; i += 500) await sbUpsert(base, key, 'gold_monthly', payload.slice(i, i + 500), 'month');
      }
      datahubMax = rows.reduce((m, r) => (r.month > m ? r.month : m), rows[0].month);
      log.monthly_sync = { rows: rows.length, last: datahubMax };
    }
  } catch (e) { log.monthly_error = e.message; }

  // Reference for the ±10% band: latest gold_daily, else latest gold_monthly. Use sbSelect (NOT
  // sbSelectAll) for these single-row (limit=1) reads — sbSelectAll appends its own &limit=1000,
  // which would send a DUPLICATE limit to PostgREST and could null out ref (disabling the guard).
  let ref = null, refDate = null, refSource = null;
  try {
    const gd = await sbSelect(base, key, 'gold_daily?select=date,price&order=date.desc&limit=1');
    if (gd.length) { ref = Number(gd[0].price); refDate = gd[0].date; refSource = 'daily'; }
    if (ref == null) { const gm = await sbSelect(base, key, 'gold_monthly?select=month,price&order=month.desc&limit=1'); if (gm.length) { ref = Number(gm[0].price); refDate = gm[0].month; refSource = 'monthly'; } }
  } catch (e) { log.ref_error = e.message; }

  // (a) Spot — record today's price. Out-of-band or both-sources-down → write nothing.
  try {
    const spot = (opts.spotOverride != null)
      ? { price: Number(opts.spotOverride), source: opts.spotSource || 'gold_api_spot' }
      : await fetchSpot();
    if (!spot) { log.spot = 'no-source'; }
    else if (!saneSpot(spot.price, ref)) {
      log.spot_rejected = { value: spot.price, ref, reason: 'out-of-band ±10%' };   // logged, NOT written
      // Deadlock guard: if gold_daily hasn't updated in ≥5 days (≈5 consecutive rejections), the ref
      // may be stale (e.g. a real >10% crash). Surface it — but STILL write nothing.
      if (refSource === 'daily' && refDate) { const daysStale = Math.round((Date.parse(today) - Date.parse(refDate)) / 86400000);
        if (daysStale >= 5) log.gold_stale_ref = { ref, refDate, daysStale, lastSpot: spot.price, note: 'reference ≥5 days old — possible real move > ±10%; not written, review needed' }; }
    }
    else {
      if (!opts.dryRun) await sbUpsert(base, key, 'gold_daily', [{ date: today, price: spot.price, source: spot.source, fetched_at: new Date().toISOString() }], 'date');
      log.spot = { date: today, price: spot.price, source: spot.source };
    }
  } catch (e) { log.spot_error = e.message; }

  // (c) Provisional months — current month and any later month DataHub hasn't published,
  // as AVG(gold_daily) for that month. Never overwrites a datahub row (only months >
  // the latest datahub month). WB methodology (a monthly average), so the line stays consistent.
  try {
    if (!datahubMax) { const gm = await sbSelect(base, key, 'gold_monthly?select=month&source=eq.datahub_wgc_wb&order=month.desc&limit=1'); datahubMax = gm.length ? gm[0].month : null; }
    const firstProv = datahubMax ? monthAfter(datahubMax) : curMonth;
    const months = monthsFromTo(firstProv, curMonth);                  // e.g. ['2026-10-01']
    for (const m of months) {
      const lo = m, hi = monthAfter(m);
      const days = await sbSelectAll(base, key, `gold_daily?select=price&date=gte.${lo}&date=lt.${hi}&order=date.asc`);
      const vals = days.map((d) => Number(d.price)).filter(Number.isFinite);
      if (!vals.length) continue;                                      // honest gap — no row without recorded days
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const row = { month: m, price: Math.round(avg * 1000) / 1000, source: 'daily_avg', provisional: true, n_days: vals.length, updated_at: new Date().toISOString() };
      if (!opts.dryRun) await sbUpsert(base, key, 'gold_monthly', [row], 'month');
      log.provisional = row;
    }
  } catch (e) { log.provisional_error = e.message; }

  return log;
}

// 'YYYY-MM-01' → next month 'YYYY-MM-01'
function monthAfter(m) { const d = new Date(m + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 10).slice(0, 7) + '-01'; }
// inclusive list of 'YYYY-MM-01' from a→b (empty if a > b)
function monthsFromTo(a, b) { const out = []; let c = a; let guard = 0; while (c <= b && guard++ < 36) { out.push(c); c = monthAfter(c); } return out; }
