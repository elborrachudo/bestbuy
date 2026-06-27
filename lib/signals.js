// lib/signals.js — graded BUY/SELL signals by confluence. PURE; no I/O.
//
// The RSI is the TRIGGER (decides IF and HOW MANY signals — ~5/yr, validated). The
// other indicators are CONFIRMERS: they only raise a signal's confidence (0–10),
// never create or block one. This layer is independent of the continuous score and
// the three pillars — it neither reads into them nor changes them.

import { clamp, round1 } from './scoring.js';
import { phaseAllowsBuy, phaseAllowsSell } from './cycle.js';

export const RSI_BUY = 22;          // base trigger thresholds (validated ~5/yr)
export const RSI_SELL = 78;
export const COOLDOWN_DAYS = 30;    // per side, independent BUY/SELL
const DAY_MS = 86400000;

// §5 — fundamentals nudge the threshold a little (never penalize, never dominate):
// strong fundamentals → BUY a touch more permissive (23) / SELL (77). Hard caps so
// it only tilts by at most 1 point. Weak/absent fundamentals → base 22/78.
const FUND_STRONG = 6.5;
export function thresholds(scoreFundamentals) {
  const strong = scoreFundamentals != null && scoreFundamentals >= FUND_STRONG;
  return { buy: strong ? 23 : 22, sell: strong ? 77 : 78 };
}

// ── Confirmer alignment (same-direction checks; need the previous reading) ──────

// StochRSI aligned with the signal: it sits in the matching extreme zone (≤20 for a
// BUY / ≥80 for a SELL) — which IS "perto do cruzamento" per the brief — or it has
// just crossed out of that zone in the signal's direction. So a deeply oversold
// StochRSI confirms a BUY trigger (and overbought confirms a SELL).
export function stochAligned(cur, prev, side) {
  const s = cur.stochrsi_14, p = prev ? prev.stochrsi_14 : null;
  if (s == null) return false;
  if (side === 'BUY')  return s <= 20 || (p != null && p <= 20 && s > 20);
  /* SELL */           return s >= 80 || (p != null && p >= 80 && s < 80);
}

// MACD aligned: a same-direction histogram cross, or about to (histogram on the
// correct side of zero and moving toward the cross).
export function macdAligned(cur, prev, side) {
  const h = cur.macd_histogram, ph = prev ? prev.macd_histogram : null;
  if (h == null) return false;
  if (side === 'BUY')  return (ph != null && ph <= 0 && h > 0) || (h < 0 && ph != null && h > ph);
  /* SELL */           return (ph != null && ph >= 0 && h < 0) || (h > 0 && ph != null && h < ph);
}

// below-high aligned: BUY wants price deep below its 1y high (score_below_high high,
// i.e. near the low); SELL wants it near the high (score_below_high low).
export function belowHighAligned(cur, side) {
  const b = cur.score_below_high;
  if (b == null) return false;
  return side === 'BUY' ? b >= 6 : b <= 4;
}

// ── Confidence (0–10) — the grading ────────────────────────────────────────────
// base RSI trigger 4.0; StochRSI +2; MACD +2 (the two main lifters); below-high +1;
// fundamentals +0.5 (minimum); on-chain activity +1 (HARD cap — lowest weight).
// Missing confirmers contribute 0 (no penalty). Clamped to [0,10].
export function signalConfidence(cur, prev, side) {
  const confirmers = ['RSI'];
  let c = 4.0;
  if (stochAligned(cur, prev, side))   { c += 2.0; confirmers.push('StochRSI'); }
  if (macdAligned(cur, prev, side))    { c += 2.0; confirmers.push('MACD'); }
  if (belowHighAligned(cur, side))     { c += 1.0; confirmers.push('below-high'); }
  if (cur.score_fundamentals != null && cur.score_fundamentals >= FUND_STRONG) {
    c += 0.5; confirmers.push('fundamentals');
  }
  if (cur.score_activity != null && cur.score_activity >= 6.5) {
    c += 1.0; confirmers.push('activity');   // hard ceiling: at most +1
  }
  return { confidence: round1(clamp(c, 0, 10)), confirmers };
}

export function strengthBand(confidence) {
  if (confidence == null) return null;
  if (confidence >= 8) return 'forte';
  if (confidence >= 6) return 'médio';
  return 'fraco';
}

// §2.3 — phase-based sizing / partial realization, expressed as a multiplier:
//   BUY  → allocation multiplier (bigger at the cycle bottom, smaller on the way up):
//          accumulation 1.5× · rise 1.0× (euphoria/correction buys are suppressed anyway).
//   SELL → realization FRACTION (partial, non-binary, in euphoria): euphoria 0.5 · else 1.0.
// The signal generator/state-machine is unaffected; this is what the backtest sizes with.
export function phaseSizeMult(phase, side) {
  if (side === 'BUY') return phase === 'accumulation' ? 1.5 : 1.0;
  return phase === 'euphoria' ? 0.5 : 1.0;   // SELL realization fraction
}

// Build one signal object from a triggering reading (+ previous for crossovers).
// `phase` is the global market-cycle phase that day (stamped for audit).
export function buildSignal(cur, prev, side, phase = null) {
  const { confidence, confirmers } = signalConfidence(cur, prev, side);
  return {
    signal_date: cur.fetched_at,
    side,
    confidence,
    strength: strengthBand(confidence),
    rsi_at_signal: cur.rsi_14 == null ? null : round1(cur.rsi_14),
    stochrsi_at_signal: cur.stochrsi_14 == null ? null : round1(cur.stochrsi_14),
    macd_hist_at_signal: cur.macd_histogram,
    price_at_signal: cur.price,
    confirmers: confirmers.join('+'),
    cycle_phase: phase,
    size_mult: phaseSizeMult(phase, side),
  };
}

// Generate the full signal list for one token's chronological readings.
//
// Three gates decide whether a triggered candidate becomes a signal:
//   1) RSI trigger (≤22 BUY / ≥78 SELL) + 30d per-side cooldown — the COUNT driver.
//   2) Cycle-phase conditioning (Phase 1.2): buys suppressed in euphoria/correction,
//      sells suppressed in accumulation (phaseByDate maps 'YYYY-MM-DD' → phase).
//   3) Position state machine (Phase 1.3): a SELL only fires when a position is OPEN
//      (a prior BUY not yet closed) — no orphan sells; a BUY opens/holds a position.
// Confluence only GRADES confidence; it never creates/blocks. Cooldown/position only
// advance on EMITTED signals (a suppressed candidate doesn't reset them).
// `readings` ascending; carries fetched_at, rsi_14, stochrsi_14, macd_histogram,
// score_below_high, score_fundamentals, score_activity, price.
export function generateSignals(readings, phaseByDate = null) {
  const out = [];
  let lastBuy = null, lastSell = null, positionOpen = false;
  for (let i = 0; i < readings.length; i++) {
    const cur = readings[i];
    if (cur.rsi_14 == null) continue;
    const th = thresholds(cur.score_fundamentals);
    let side = null;
    if (cur.rsi_14 <= th.buy) side = 'BUY';
    else if (cur.rsi_14 >= th.sell) side = 'SELL';
    if (!side) continue;

    const day = String(cur.fetched_at).slice(0, 10);
    const phase = phaseByDate ? (phaseByDate[day] || null) : null;
    const t = new Date(cur.fetched_at).getTime();

    if (side === 'BUY') {
      if (phaseByDate && !phaseAllowsBuy(phase)) continue;           // global cycle gate
      if (cur.structural_decline) continue;                          // §2.2 survivorship: skip ONDOs
      if (lastBuy != null && (t - lastBuy) / DAY_MS < COOLDOWN_DAYS) continue;
      out.push(buildSignal(cur, i > 0 ? readings[i - 1] : null, side, phase));
      lastBuy = t; positionOpen = true;
    } else { // SELL
      if (!positionOpen) continue;                                   // no orphan sells
      if (phaseByDate && !phaseAllowsSell(phase)) continue;
      if (lastSell != null && (t - lastSell) / DAY_MS < COOLDOWN_DAYS) continue;
      out.push(buildSignal(cur, i > 0 ? readings[i - 1] : null, side, phase));
      lastSell = t; positionOpen = false;
    }
  }
  return out;
}

// Live single-step: does the newest reading fire? `phase` is today's market phase;
// position state is derived from the last BUY/SELL dates (open if the last BUY is more
// recent than the last SELL). Returns a signal object or null.
export function detectLiveSignal(cur, prev, lastBuyDate, lastSellDate, nowIso, phase = null) {
  if (cur.rsi_14 == null) return null;
  const th = thresholds(cur.score_fundamentals);
  let side = null;
  if (cur.rsi_14 <= th.buy) side = 'BUY';
  else if (cur.rsi_14 >= th.sell) side = 'SELL';
  if (!side) return null;

  const t = new Date(nowIso).getTime();
  if (side === 'BUY') {
    if (phase != null && !phaseAllowsBuy(phase)) return null;
    if (cur.structural_decline) return null;                         // §2.2 survivorship
    if (lastBuyDate != null && (t - new Date(lastBuyDate).getTime()) / DAY_MS < COOLDOWN_DAYS) return null;
  } else {
    const positionOpen = lastBuyDate != null &&
      (lastSellDate == null || new Date(lastBuyDate).getTime() > new Date(lastSellDate).getTime());
    if (!positionOpen) return null;                                  // no orphan sell
    if (phase != null && !phaseAllowsSell(phase)) return null;
    if (lastSellDate != null && (t - new Date(lastSellDate).getTime()) / DAY_MS < COOLDOWN_DAYS) return null;
  }
  return buildSignal({ ...cur, fetched_at: nowIso }, prev, side, phase);
}
