// lib/survivorship.js — per-asset survivorship filter (Phase 2.2).
//
// Protects the book from "ONDOs": an asset in a PROLONGED structural decline — price
// below its own long moving average while that average has itself been falling for
// months — should not be bought even when the global cycle says "accumulation". This
// is per-asset (unlike the GLOBAL BTC cycle gate); it only suppresses BUYs, never sells.

import { sma } from './scoring.js';

const LONG = 200;          // long MA window (capped to available history)
const SLOPE_LOOKBACK = 90; // the long MA must have been falling over ~this many days

// Per-day boolean: is the asset in a prolonged structural decline at index i?
// True when price < longMA AND longMA(now) < longMA(SLOPE_LOOKBACK days ago) — i.e. the
// trend MA is still sloping down and price sits beneath it. Honest false during warmup.
export function structuralDeclineSeries(prices, slopeLookback = SLOPE_LOOKBACK) {
  return prices.map((_, i) => {
    const ma = sma(prices, Math.min(i + 1, LONG), i);
    const j = i - slopeLookback;
    const maPast = j >= 0 ? sma(prices, Math.min(j + 1, LONG), j) : null;
    if (ma == null || maPast == null) return false;
    return prices[i] < ma && ma < maPast;
  });
}

// Convenience: structural-decline flag at the latest point of a price series.
export function structuralDeclineLatest(prices) {
  if (!prices || !prices.length) return false;
  const s = structuralDeclineSeries(prices);
  return s[s.length - 1];
}
