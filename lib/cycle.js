// lib/cycle.js — GLOBAL market-cycle phase detector (Phase 1: price/MA placeholder).
//
// Classifies the whole market — via BTC, NOT per-asset — into 4 mechanical phases:
// accumulation, rise, euphoria, correction. This is a deterministic price/MA200
// placeholder; the reliable version (Phase 2) is MVRV Z-Score / NUPL. The phase is a
// probabilistic CONTEXT, never a calendar/certainty (see DECISIONS.md).

import { sma } from './scoring.js';

const CG_BASE = 'https://api.coingecko.com/api/v3';

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

// Classify the phase at index i of a BTC daily price array. Uses the long MA (200d
// where available, else the longest window so far), distance above/below it, and 30d
// momentum. Returns { phase, indicators }.
//   euphoria   — very extended above the long MA with strong momentum
//   rise       — at/above the long MA
//   correction — below the long MA and still falling (don't catch the knife)
//   accumulation — below the long MA but stabilizing/recovering
export const EUPHORIA_DIST = 0.40;   // >40% above the long MA …
export const EUPHORIA_MOM = 0.10;    // … with >10% 30d momentum → euphoria
export function classifyPhase(prices, i) {
  const period = Math.min(i + 1, 200);
  const ma = sma(prices, period, i);
  const price = prices[i];
  if (ma == null || !(ma > 0)) return { phase: 'accumulation', indicators: { ma: null, dist_pct: null, mom30d: null } };
  const dist = (price - ma) / ma;
  const back = Math.max(0, i - 30);
  const mom30 = prices[back] > 0 ? (price - prices[back]) / prices[back] : 0;
  let phase;
  if (dist > EUPHORIA_DIST && mom30 > EUPHORIA_MOM) phase = 'euphoria';
  else if (price >= ma) phase = 'rise';
  else if (mom30 < 0) phase = 'correction';
  else phase = 'accumulation';
  return { phase, indicators: { ma: ma, dist_pct: round4(dist), mom30d: round4(mom30) } };
}
const round4 = (x) => (x == null ? null : Math.round(x * 10000) / 10000);

// Phase → which signal sides are permitted (the conditioning rule, Phase 1.2):
//   accumulation → BUY only (suppress sells)
//   rise         → both (cautious)
//   euphoria     → SELL only (suppress buys)
//   correction   → SELL only (suppress buys — don't buy a falling market)
export function phaseAllowsBuy(phase) {
  return phase === 'accumulation' || phase === 'rise' || phase == null;
}
export function phaseAllowsSell(phase) {
  return phase === 'euphoria' || phase === 'correction' || phase === 'rise' || phase == null;
}

// Build a { 'YYYY-MM-DD': phase } map from a BTC series (for conditioning history).
export function phaseByDateFromBtc(series) {
  const prices = series.map((p) => p.price);
  const map = {};
  for (let i = 0; i < series.length; i++) {
    const day = new Date(series[i].ts).toISOString().slice(0, 10);
    map[day] = classifyPhase(prices, i).phase;
  }
  return map;
}
