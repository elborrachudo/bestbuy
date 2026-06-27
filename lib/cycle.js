// lib/cycle.js — GLOBAL market-cycle phase detector (Phase 2: robust, price-only).
//
// Four indicators, ALL computed from BTC daily price (no paid MVRV, no external source):
//   1. Mayer Multiple   = price / 200d MA           (over/under-valuation)
//   2. 200-week MA       = 1400d MA (Bull Market Support Band; `partial` if <1400d)
//   3. ATH drawdown      = (price − running ATH) / running ATH
//   4. Price percentile  = where today sits vs BTC history so far (point-in-time)
// Combined by CONSENSUS (not one indicator — the 2025 top printed Mayer 2.2, below the
// classic 2.4, so a single-indicator detector would miss it) with HYSTERESIS (a phase
// only flips after the new condition holds ≥3 consecutive days) and a 0–1 confidence.
// The phase is a probabilistic CONTEXT, never a calendar. GLOBAL (BTC), not per-asset.

import { sma } from './scoring.js';

const CG_BASE = 'https://api.coingecko.com/api/v3';
const HYSTERESIS_DAYS = 3;
const MAYER_HOT = 2.4, MAYER_COLD = 0.8;

// BTC daily price series (ascending) from CoinGecko. Server-side only (needs egress).
export async function getBtcDailySeries(days, apiKey) {
  const url = `${CG_BASE}/coins/bitcoin/market_chart?vs_currency=usd&days=${days}&interval=daily`;
  const headers = apiKey ? { 'x-cg-demo-api-key': apiKey } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`coingecko btc: ${res.status}`);
  const json = await res.json();
  return (json.prices || [])
    .filter((p) => typeof p[1] === 'number')
    .map((p) => ({ ts: p[0], price: p[1] }));
}

const round4 = (x) => (x == null ? null : Math.round(x * 10000) / 10000);

// ── M2 liquidity confirmer (Phase 2.1, optional) ──────────────────────────────
// US M2 money supply (FRED series M2SL) as the global-liquidity proxy — the dominant
// crypto-liquidity driver. Monthly, slow-moving. Used ONLY as a displayed CONFIRMER
// (expanding M2 = tailwind for dip-buys; contracting = headwind); it does NOT change the
// phase gate. Server-side only (needs egress). KEYLESS — no API key, no paid source.
//
// FRED's own fredgraph.csv blocks cloud/datacenter IPs at the network level (the fetch
// fails to even connect from Vercel serverless), so the PRIMARY source is DBnomics, a
// keyless academic mirror that serves the identical FRED/M2SL series as JSON and does not
// block datacenters. FRED's CSV is kept as a fallback for environments that can reach it.
const M2_UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json,text/csv,text/plain,*/*',
};
export async function getM2Monthly() {
  // Primary: DBnomics keyless JSON mirror of FRED/M2SL.
  try {
    const res = await fetch('https://api.db.nomics.world/v22/series/FRED/M2SL?observations=1', { headers: M2_UA });
    if (res.ok) {
      const j = await res.json();
      const doc = j && j.series && j.series.docs && j.series.docs[0];
      if (doc && Array.isArray(doc.period) && Array.isArray(doc.value)) {
        const days = Array.isArray(doc.period_start_day) ? doc.period_start_day : null;
        const out = doc.period.map((p, i) => {
          let date = (days && days[i]) || p;           // prefer the YYYY-MM-DD start day
          if (/^\d{4}-\d{2}$/.test(date)) date += '-01';
          return { date, value: parseFloat(doc.value[i]) };
        }).filter((r) => r.date && isFinite(r.value));
        if (out.length) { console.log(`m2: dbnomics ${out.length} obs`); return out; }
      }
    } else { console.warn(`m2 dbnomics: ${res.status}`); }
  } catch (e) { console.warn('m2 dbnomics failed:', e.message); }

  // Fallback: FRED keyless CSV (works only where the datacenter isn't blocked).
  const res = await fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=M2SL&cosd=2022-01-01', { headers: M2_UA });
  if (!res.ok) throw new Error(`fred m2: ${res.status}`);
  const text = await res.text();
  const out = text.trim().split('\n').slice(1)
    .map((l) => { const [date, v] = l.split(','); return { date, value: parseFloat(v) }; })
    .filter((r) => isFinite(r.value));
  console.log(`m2: fred ${out.length} obs`);
  return out;
}

// M2 metrics as-of a date (no lookahead): latest monthly value ≤ asOf, its YoY % change,
// and whether it's expanding over the trailing 3 months. null when no data yet.
export function m2MetricsAsOf(series, asOf) {
  if (!series || !series.length) return null;
  let cur = null; for (const r of series) { if (r.date <= asOf) cur = r; else break; }
  if (!cur) return null;
  const at = (d) => { let p = null; for (const r of series) { if (r.date <= d) p = r; else break; } return p; };
  const shift = (iso, m) => { const d = new Date(iso); d.setMonth(d.getMonth() - m); return d.toISOString().slice(0, 10); };
  const past = at(shift(cur.date, 12));
  const yoy = (past && past.value > 0) ? (cur.value - past.value) / past.value * 100 : null;
  const p3 = at(shift(cur.date, 3));
  const expanding = p3 ? cur.value > p3.value : (yoy != null ? yoy > 0 : null);
  return { m2_value: cur.value, m2_yoy_pct: round4(yoy), m2_expanding: expanding };
}

// Per-day indicator bundle at index i (point-in-time — no lookahead).
function indicatorsAt(prices, i) {
  const price = prices[i];
  const ma200 = sma(prices, Math.min(i + 1, 200), i);
  const ma200w = sma(prices, Math.min(i + 1, 1400), i);
  const mayer = (ma200 != null && ma200 > 0) ? price / ma200 : null;
  let ath = -Infinity; for (let j = 0; j <= i; j++) if (prices[j] > ath) ath = prices[j];
  const dd = ath > 0 ? (price - ath) / ath : null;
  // expanding-window price percentile (count ≤ price over [0..i])
  let le = 0; for (let j = 0; j <= i; j++) if (prices[j] <= price) le++;
  const pct = i === 0 ? 50 : ((le - 1) / i) * 100;
  const back = Math.max(0, i - 30);
  const mom30 = prices[back] > 0 ? (price - prices[back]) / prices[back] : 0;
  return { price, mayer, ma200w, ma200w_partial: (i + 1) < 1400, drawdown: dd, price_pct: pct, mom30 };
}

// Raw (pre-hysteresis) phase from the four-indicator consensus. `recentMaxMayer` = the
// highest Mayer over the trailing ~90d (used by the correction rule: fell from a hot top).
function rawPhase(d, recentMaxMayer) {
  const { price, mayer, ma200w, drawdown: dd, price_pct: pct, mom30 } = d;
  if (mayer != null && mayer > MAYER_HOT) return 'euphoria';
  if (pct != null && pct > 90 && dd != null && dd > -0.05) return 'euphoria';
  if (ma200w != null && price > ma200w && mayer != null && mayer >= 1.0 && mayer <= MAYER_HOT && dd != null && dd > -0.25) return 'rise';
  // Correction = a deep drawdown that either fell from a hot Mayer (>1.5, the full-history
  // signature) OR is still actively falling (30d momentum < 0). The momentum clause makes
  // correction reachable when only short history exists (the 200d-MA — hence Mayer — is
  // partial and understated), so an ongoing decline is treated as "don't buy the knife"
  // rather than as cheap accumulation. A deep but STABILIZING price (mom30 ≥ 0) falls
  // through to accumulation below.
  if (dd != null && dd < -0.20 && ((recentMaxMayer != null && recentMaxMayer > 1.5) || (d.mom30 != null && d.mom30 < 0))) return 'correction';
  if ((mayer != null && mayer < MAYER_COLD) || (pct != null && pct < 15) ||
      (ma200w != null && price <= ma200w && mom30 != null && mom30 >= 0)) return 'accumulation';
  return null;   // nothing clear → hysteresis holds the previous phase
}

function confidenceOf(mayer) {
  if (mayer == null) return 0.3;
  if (mayer < MAYER_COLD) return Math.min(1, (MAYER_COLD - mayer) / 0.3);
  if (mayer > MAYER_HOT)  return Math.min(1, (mayer - MAYER_HOT) / 0.6);
  return 0.3;
}

// Classify the WHOLE series with hysteresis. Returns per-day
// { phase, confidence, indicators }. Hysteresis: a new raw phase must persist
// ≥HYSTERESIS_DAYS consecutive days before it replaces the current phase.
export function classifySeries(prices) {
  const out = [];
  let cur = 'accumulation', cand = null, candCount = 0;
  for (let i = 0; i < prices.length; i++) {
    const d = indicatorsAt(prices, i);
    let recentMaxMayer = null;
    for (let j = Math.max(0, i - 89); j <= i; j++) {
      const ma = sma(prices, Math.min(j + 1, 200), j);
      const m = (ma != null && ma > 0) ? prices[j] / ma : null;
      if (m != null && (recentMaxMayer == null || m > recentMaxMayer)) recentMaxMayer = m;
    }
    const raw = rawPhase(d, recentMaxMayer);
    if (i === 0 && raw) cur = raw;
    else if (raw == null || raw === cur) { cand = null; candCount = 0; }
    else { if (raw === cand) candCount++; else { cand = raw; candCount = 1; }
      if (candCount >= HYSTERESIS_DAYS) { cur = raw; cand = null; candCount = 0; } }
    out.push({
      phase: cur,
      confidence: round4(confidenceOf(d.mayer)),
      indicators: {
        mayer: round4(d.mayer), ma200w: d.ma200w, ma200w_partial: d.ma200w_partial,
        drawdown: round4(d.drawdown), price_pct: round4(d.price_pct),
        phase_confidence: round4(confidenceOf(d.mayer)), raw_phase: raw,
      },
    });
  }
  return out;
}

// Convenience: phase + indicators at the latest point of a series.
export function classifyLatest(prices) {
  const s = classifySeries(prices);
  return s.length ? s[s.length - 1] : { phase: 'accumulation', confidence: 0.3, indicators: {} };
}

// Phase → which signal sides are permitted (Phase-1 gate, unchanged):
//   accumulation → BUY only · rise → both · euphoria → SELL only · correction → SELL only.
export function phaseAllowsBuy(phase) {
  return phase === 'accumulation' || phase === 'rise' || phase == null;
}
export function phaseAllowsSell(phase) {
  return phase === 'euphoria' || phase === 'correction' || phase === 'rise' || phase == null;
}

// { 'YYYY-MM-DD': phase } map from a BTC series (for conditioning history).
export function phaseByDateFromBtc(series) {
  const cls = classifySeries(series.map((p) => p.price));
  const map = {};
  for (let i = 0; i < series.length; i++) map[new Date(series[i].ts).toISOString().slice(0, 10)] = cls[i].phase;
  return map;
}
