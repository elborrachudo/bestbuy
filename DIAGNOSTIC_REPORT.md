# BestBuy — DIAGNOSTIC_REPORT: flat scores / missing spot signals (VIRTUAL)

Diagnostic-only data collection. **No scoring logic was changed, nothing was deployed.**
Raw data only, no conclusions. Token under examination: **VIRTUAL**.

> **Terminology note (important — the brief's assumptions vs the actual implementation):**
> - There is **no `score_dist_low` sub-score**. The scored value/contrarian technical is
>   **`score_below_high`** = % below the trailing **1-YEAR (365d) high** (not a 90d window).
> - **`dist_from_low_pct`** *is* a stored raw column, but it is computed vs the trailing
>   **1-year LOW**, is **not used in any score**, and is **null for every backfill row**
>   (the column was added after the backfill ran). It is purely archival right now.
> - The live `final_score` comes from the **three-pillar blend** (`blendPillars`), not from
>   the legacy `computeFinalScore`/`WEIGHTS_FULL` (those are exported + unit-tested but are
>   **not** on the live path).

---

## 1. Exact scoring functions (verbatim from `lib/scoring.js`)

**Price vs MAs** (window: the MAs themselves — ma_50 / ma_200; relative to each MA):
```js
export function scorePriceVsMas(price, ma50, ma200) {
  if (price == null) return null;
  const comp = (ma) => (ma == null || ma <= 0) ? null : (clamp((price - ma) / ma, -1, 1) + 1) / 2;
  const parts = [comp(ma50), comp(ma200)].filter((v) => v != null);
  if (!parts.length) return null;
  const avg = parts.reduce((a, b) => a + b, 0) / parts.length;
  return clamp(avg * 10, 0, 10);
}
```

**Below trailing 1-year high** (the contrarian/"cheapness" axis; window = 365d high):
```js
export function scoreBelowHigh(price, high) {
  if (price == null || high == null || high <= 0) return null;
  return clamp(10 * (high - price) / high, 0, 10);   // at 1y high → 0, 50% below → 5, 90% below → 9
}
```

**RSI → 0-10** (14-day RSI on the daily close series; piecewise-linear):
```js
export function scoreRsi(rsiVal) {
  if (rsiVal == null) return null;
  const pts = [[0, 10], [30, 8], [50, 5], [70, 2], [100, 0]];   // thresholds
  const x = clamp(rsiVal, 0, 100);
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    if (x >= x0 && x <= x1) { const t = (x - x0) / (x1 - x0); return y0 + t * (y1 - y0); }
  }
  return 5;
}
```

**Technicals pillar** (the three above; internal weights 45 / 35 / 20):
```js
export const W_TECHNICALS = { priceMa: 45, belowHigh: 35, rsi: 20 };
export function scoreTechnicals(priceMa, belowHigh, rsi) {
  return weightedBlend({ priceMa, belowHigh, rsi }, W_TECHNICALS);
}
```

**Fundamentals pillar** (coverage factor + emissions-only cap):
```js
export const W_FUNDAMENTALS = { tvlRev: 60, emissions: 40 };
export function scoreFundamentals(tvlRev, emissions, supplyMechanism) {
  const em = applySupplyModifier(emissions, supplyMechanism);
  const present = [tvlRev, em].filter((v) => v != null).length;
  if (present === 0) return null;
  const raw = weightedBlend({ tvlRev, emissions: em }, W_FUNDAMENTALS);
  const coverage = present / 2;                       // 1 of 2 components → 0.5
  let adjusted = 5 + (raw - 5) * coverage;            // shrink toward neutral 5
  if (tvlRev == null) adjusted = Math.min(adjusted, 5.0);
  return adjusted;
}
```

**Final score = blend of the three pillars** (45 / 35 / 20; null pillars drop & renormalize):
```js
export const W_PILLARS = { fundamentals: 45, technicals: 35, activity: 20 };
export function blendPillars(fundamentals, technicals, activity) {
  return round1(weightedBlend({ fundamentals, technicals, activity }, W_PILLARS));
}
// generic weighted average used by every pillar/sub-score combine:
export function weightedBlend(values, weights) {
  let total = 0, wsum = 0;
  for (const k of Object.keys(weights)) {
    if (values[k] == null) continue;
    total += weights[k] * values[k]; wsum += weights[k];
  }
  return wsum === 0 ? null : total / wsum;
}
```

**Smoothing:** none is applied to the score itself. Each reading's score is computed
independently from that reading's inputs — there is **no moving average / EMA over the
score series**. The only smoothing anywhere is (a) the price MAs feeding `scorePriceVsMas`
(an indicator, not the score), and (b) the **chart line** uses Chart.js `tension: 0.4`
(visual only — it does not alter stored values). There is **no min-max re-normalization
over a moving window** in any sub-score.

---

## 2. VIRTUAL — last 10 readings (raw value beside the sub-score it produced)

| date | tier | price | rsi_14 | ma_50 | ma_200 | dist_from_low_pct | score_price_ma | score_below_high | score_rsi | **technicals** | **fundamentals** | activity | **FINAL** |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-06-26 | live | 0.5298 | **31.2** | 0.6825 | 0.7203 | 0.0216 | 3.8 | **7.3** | **7.8** | 5.8 | 4.5 | null | **5.1** |
| 2026-06-25 | backfill | 0.5160 | 33.9 | 0.6900 | 0.7218 | null | 3.7 | 7.3 | 7.4 | 5.7 | 4.9 | null | 5.2 |
| 2026-06-24 | backfill | 0.5745 | 51.2 | 0.7021 | 0.7248 | null | 4.0 | 7.0 | 4.8 | 5.2 | 4.4 | null | 4.7 |
| 2026-06-23 | backfill | 0.5857 | 51.2 | 0.7053 | 0.7262 | null | 4.1 | 7.0 | 4.8 | 5.2 | 4.2 | null | 4.7 |
| 2026-06-22 | backfill | 0.5843 | 51.9 | 0.7087 | 0.7279 | null | 4.1 | 7.0 | 4.7 | 5.2 | 4.2 | null | 4.7 |
| 2026-06-21 | backfill | 0.6079 | 63.5 | 0.7120 | 0.7299 | null | 4.2 | 6.8 | 3.0 | 4.9 | 4.0 | null | 4.4 |
| 2026-06-20 | backfill | 0.6123 | 61.8 | 0.7139 | 0.7314 | null | 4.2 | 6.8 | 3.2 | 4.9 | 4.0 | null | 4.4 |
| 2026-06-19 | backfill | 0.5977 | 44.3 | 0.7154 | 0.7326 | null | 4.1 | 6.9 | 5.9 | 5.4 | 4.1 | null | 4.7 |
| 2026-06-18 | backfill | 0.6055 | 35.0 | 0.7172 | 0.7342 | null | 4.2 | 6.9 | 7.2 | 5.7 | 4.1 | null | 4.8 |
| 2026-06-17 | backfill | 0.6249 | 40.9 | 0.7189 | 0.7358 | null | 4.3 | 6.8 | 6.4 | 5.6 | 4.0 | null | 4.7 |

Direct answers to the brief's two probes:
- **RSI ~31 (oversold) → `score_rsi` = 7.8** (2026-06-26); RSI 33.9 → 7.4 (2026-06-25). The RSI sub-score *did* respond strongly.
- **Price near its low → `score_below_high` = 7.3** (price 0.53 vs trailing-1y high ≈ 1.93). The contrarian sub-score *did* respond. (`dist_from_low_pct` is null in backfill and unscored — see the terminology note.)
- On the same day, `score_price_ma` = 3.8 (price ~22% below both MAs), `technicals` = 5.8, `final` = 5.1.

---

## 3. Amplitude vs flattening — min / max / avg / stddev across ALL VIRTUAL history (n≈366)

| layer | n | min | max | avg | **stddev** |
|---|---|---|---|---|---|
| **price** (raw) | 366 | 0.5160 | 1.9271 | 0.9588 | 0.3333  (max/min = **3.73×**) |
| score_price_ma | 317 | 2.8 | 8.4 | 4.46 | 0.85 |
| score_below_high | 366 | 0.0 | 7.3 | 4.94 | **1.92** |
| score_rsi | 352 | 1.0 | 9.3 | 5.48 | **2.17** |
| **score_technicals** (pillar) | 366 | 0.0 | 6.0 | 4.67 | 1.23 |
| score_tvl_rev (sub) | 366 | 0.0 | 1.6 | 0.04 | 0.19 |
| score_emissions (sub) | 365 | 7.1 | 10.0 | 9.90 | 0.23 |
| **score_fundamentals** (pillar) | 366 | 2.5 | 4.9 | 4.00 | 0.17 |
| **final_score** | 366 | 1.4 | 5.2 | 4.28 | **0.57** |

Raw readings of the table (no conclusions drawn):
- Price moved **3.73×**; `final_score` ranged 1.4–5.2 with **stddev 0.57**.
- Among technical sub-scores, `score_rsi` (sd 2.17) and `score_below_high` (sd 1.92) vary
  the most; `score_price_ma` (sd 0.85) varies least.
- The `technicals` pillar (sd 1.23) has lower spread than its two most-variable inputs.
- The `fundamentals` pillar is nearly constant (sd 0.17; range 2.5–4.9, mostly ≈4.0):
  `score_tvl_rev` sits ≈0 (sd 0.19) and `score_emissions` sits ≈9.9 (sd 0.23).
- `score_activity` is null for the entire VIRTUAL history (no two live snapshots yet).

---

## 4. Windows & scales

- **`dist_from_low_pct`** — window = trailing **365 days** (1 year), computed as
  `(price − low365) / low365`. It is **raw/archival and NOT fed into any score**, and it is
  **null on every backfill row** (added post-backfill). (The *scored* contrarian axis is
  `score_below_high`, window = trailing 365d HIGH.)
- **RSI → score thresholds:** `0→10, 30→8, 50→5, 70→2, 100→0` (piecewise-linear,
  14-day RSI on daily closes). Absolute mapping — not window-relative.
- **Price-vs-MA saturation:** for VIRTUAL it is **not pinned at an extreme** — it sits
  compressed in the ~3.7–4.3 band (recent rows) because price has been a moderate ~20–25%
  below both MAs for months. The term is `(clamp((price−ma)/ma, −1, 1)+1)/2`; only a move
  to ≥100% above (→1.0) or ≤100% below (→0.0) saturates it. ma_50/ma_200 lag the price.
- **Moving-window min-max normalization:** **none.** No sub-score re-scales itself to [0,10]
  within a rolling window. The only window-relative inputs are `score_below_high` (vs the
  365d high) and `score_price_ma` (vs the MAs); RSI and emissions are absolute mappings.

---

## 5. Signal-event test — discrete technical events vs `final_score` on that day

Events detected over VIRTUAL's full history (RSI crossing 30/70 using consecutive readings;
price touching its trailing-90d low/high). `final_on_event_day` is the `final_score` that day.

| date | price | rsi | event | final |
|---|---|---|---|---|
| 2025-07-22 | 1.9236 | 76.8 | RSI crossed >70 (SELL) | 2.3 |
| 2025-07-31 | 1.3400 | 28.3 | RSI crossed <30 (BUY) | 4.3 |
| 2025-08-03 | 1.1540 | 20.4 | price = 90d LOW | 4.7 |
| 2025-09-19 | 1.3600 | 74.8 | RSI crossed >70 (SELL) | 3.9 |
| 2025-09-26 | 0.9974 | 29.9 | RSI crossed <30 (BUY) | 4.5 |
| 2025-10-17 | 0.7662 | 29.5 | RSI crossed <30 (BUY) | 4.5 |
| 2025-10-23 | 0.7391 | 25.9 | RSI crossed <30 (BUY) | 4.6 |
| 2025-10-25 | 0.9915 | 71.0 | RSI crossed >70 (SELL) | 4.1 |
| 2025-10-27 | 1.5341 | 83.4 | price = 90d HIGH | 4.1 |
| 2025-11-01 | 1.3605 | 71.5 | RSI crossed >70 (SELL) | 4.1 |
| 2025-11-16 | 1.1578 | 28.0 | RSI crossed <30 (BUY) | 4.5 |
| 2025-11-22 | 0.9146 | 17.7 | RSI crossed <30 (BUY) | 4.6 |
| 2025-12-17 | 0.7224 | 29.3 | RSI crossed <30 (BUY) | 4.6 |
| 2025-12-18 | 0.6795 | 16.2 | price = 90d LOW | 4.6 |
| 2025-12-24 | 0.7015 | 24.9 | RSI crossed <30 (BUY) | 4.7 |
| 2026-01-05 | 0.9050 | 74.4 | RSI crossed >70 (SELL) | 4.3 |
| 2026-01-20 | 0.8738 | 26.9 | RSI crossed <30 (BUY) | 4.7 |
| 2026-01-28 | 0.8304 | 24.2 | RSI crossed <30 (BUY) | 4.7 |
| 2026-01-30 | 0.7431 | 24.9 | RSI crossed <30 (BUY) | 4.7 |
| 2026-02-06 | 0.5186 | 21.5 | price = 90d LOW | 5.1 |
| 2026-02-10 | 0.5705 | 28.9 | RSI crossed <30 (BUY) | 4.8 |
| 2026-03-31 | 0.6412 | 23.7 | RSI crossed <30 (BUY) | 4.8 |
| 2026-05-04 | 0.7542 | 76.2 | RSI crossed >70 (SELL) | 4.3 |
| 2026-05-06 | 0.8045 | 78.2 | RSI crossed >70 (SELL) | 4.3 |
| 2026-05-09 | 0.9352 | 85.7 | price = 90d HIGH | 4.3 |
| 2026-05-22 | 0.7511 | 27.9 | RSI crossed <30 (BUY) | 4.8 |
| 2026-06-07 | 0.5431 | 25.0 | RSI crossed <30 (BUY) | 5.1 |
| 2026-06-11 | 0.5421 | 23.8 | price = 90d LOW | 5.2 |
| 2026-06-25 | 0.5160 | 33.9 | price = 90d LOW | 5.2 |

(Earlier 2025-06/07 rows with `rsi = null` omitted from this table — RSI needs 14 days of
history, so the first ~2 weeks have no RSI. Full row set was pulled; the above are the
events with a defined RSI plus the price-extreme touches.)

Raw reading: across **every** RSI<30 "BUY" event in the table, `final_on_event_day` falls
in **4.3–5.2** (NEUTRAL band, which is 4.5–6.5 / WEAK below). Across **every** RSI>70 "SELL"
event, `final` falls in **2.3–4.3**. The largest single move at any event is ≈2.4 points
(the 2025-07 overbought spike, when fundamentals/activity history was still thin); the
2025-12 → 2026-06 events all sit within a ~1-point band (4.3–5.2).

---

## 6. Inventory — what exists vs what's missing

**Technical indicators computed & stored per reading:**
- `rsi_14` (14-day RSI), `ma_50`, `ma_200` (raw), `score_price_ma`, `score_below_high`
  (vs trailing 365d high), `score_rsi`, `dist_from_low_pct` (raw, unscored, null in backfill).
- Fundamentals raw: `tvl`, `holders_revenue`, `emissions_rate`, `circ_supply`.
- Activity raw (live-only): `active_addresses`, `holder_count`, `transfer_count`.

**Not present anywhere:** MACD, Bollinger Bands, volume, ATR, or any oscillator beyond RSI.
The trailing-1y **high** is used (for `score_below_high`); the trailing-1y **low** is stored
raw (`dist_from_low_pct`) but unused.

**Series sufficiency for crosses:** yes — readings are a continuous time series (1/day
backfill + 3/day live), so each row has a defined predecessor. Cross detection (e.g. RSI
crossing 30/70) is computable from the stored series — Section 5 above was produced purely
from stored `rsi_14` + `price` with `lag()` / rolling windows. No extra data is needed to
detect crosses.

**Discrete "signal/event" concept:** none. Everything is a **continuous score**. There is
no event table, no per-reading boolean/flag for "oversold cross" / "new 90d low" / etc. The
only discretization that exists is the **verdict band** thresholds applied to the continuous
`final_score` for display (`≥8 STRONG BUY, ≥6.5 BUY, ≥4.5 NEUTRAL, ≥3 WEAK, else AVOID`) —
i.e. labels on the smoothed score, not events emitted from the raw technical series.

---

*End of diagnostic. No scoring logic changed; nothing deployed.*
