# Emissions / inflation axis — what the numbers mean & how each token rates

_Project: "Compro o quê?!" (bestbuy). Updated 2026-06-25, after the Option-B fix._
_Scope: the 5th scoring axis — now a real annual-inflation signal._

---

## 0. TL;DR

The emissions axis used to be broken (it scored a one-time supply *overhang* as if it
were a yearly rate, so every token clamped to 0). It now measures the **real annual
inflation of circulating supply** and produces a live, differentiating signal:

| Token | Inflation (now) | Emissions score | Plain reading |
|---|---|---|---|
| **XRP**  | **5.1 %/yr**  | **8.3 / 10** | Slow, steady supply growth — best profile |
| **CRV**  | **11.8 %/yr** | **6.1 / 10** | Moderate, easing |
| **AERO** | **13.3 %/yr** | **5.6 / 10** | High — emissions-heavy DEX |
| **ONDO** | **54.1 %/yr** | **0.0 / 10** | Very high — heavy unlocks, max penalty |

---

## 1. What the inflation number *is*

It's the **percentage by which a token's circulating supply grew over the last 12 months**.

```
inflation = (circulating_supply_now − circulating_supply_one_year_ago) / circulating_supply_one_year_ago
```

So "5 %/yr" means there are ~5 % more coins in circulation today than a year ago. Those new
coins come from staking rewards, liquidity incentives, block rewards, and team/investor
unlocks — and they are mostly **sold**, which is a structural headwind on price. Lower is
better: a scarce, slowly-inflating token has less built-in sell pressure than one minting
half its supply again each year.

This is the only purely **supply-side** fundamental in the model — independent of price
action (the MA / 1-year-high / RSI axes) and of DeFi usage (the TVL/revenue axis).

---

## 2. How it's measured

CoinGecko doesn't hand us circulating-supply *history* directly, so we reconstruct it from
two numbers it *does* return for every day in `market_chart`:

```
circulating_supply_t  ≈  market_cap_t / price_t
```

Then we take the trailing-year change (formula above). Details:

- **Short history** (young tokens, or the oldest backfilled days): if a full year isn't
  available, we use the oldest point we have and annualize the partial-window change
  (`× 365 / days_in_window`) — same approach the "% below 1-year high" axis uses.
- **Burns** (supply shrinks): negative inflation is floored at 0 % → scores a perfect 10.
- **No data**: if we can't reconstruct ≥2 points, the score is left null and the weighting
  redistributes to the other axes (never a 0-by-failure).

---

## 3. How inflation maps to the 0–10 score

Straight line: **0 % → 10**, **15 % → 5**, **30 %+ → 0**.

| Annual inflation | Emissions score |
|---|---|
| 0 % (or net burn) | 10.0 |
| 5 % | 8.3 |
| 10 % | 6.7 |
| 15 % | 5.0 |
| 20 % | 3.3 |
| 25 % | 1.7 |
| 30 % and above | 0.0 |

Weight in the final score: **15 %** for full tokens, **10 %** for market-only tokens.

---

## 4. How each token rates

Figures: latest reading, plus the range/average across the last ~12 months.

### XRP — 5.1 %/yr → **8.3 / 10** (best)
- 12-month range: **0–6.4 %**, averaging **4.9 %**; score steady at ~8.3 all year.
- XRP's supply expands slowly as Ripple releases tokens from escrow in measured amounts.
  It's the closest of the four to "sound money," and this axis is a big reason XRP tops the
  overall board.

### CRV — 11.8 %/yr → **6.1 / 10** (moderate)
- 12-month range: **5.3–46.9 %** (avg **12.3 %**); the high end is early-window noise (§5).
- Curve still mints CRV as liquidity incentives, but the rate has been easing. Mid-pack:
  not scarce, not egregious.

### AERO — 13.3 %/yr → **5.6 / 10** (high)
- 12-month range: **11.3–225 %** (avg **20.8 %**); the 225 % is an early-backfill artifact (§5).
- Aerodrome is an emissions-heavy ve(3,3) DEX — it continuously mints AERO as voting
  incentives/bribes. Even after cooling to ~13 %, it's a persistent drag on AERO's score.

### ONDO — 54.1 %/yr → **0.0 / 10** (worst)
- 12-month range: **0–95.7 %** (avg **31.2 %**); currently elevated and rising.
- Ondo is young and still unlocking large team/investor/ecosystem allocations, so its
  circulating supply is growing fast. Above the 30 % cap, so it takes the maximum emissions
  penalty — its single weakest axis and the main reason it sits last overall.

**Net:** on emissions alone the ranking is **XRP ≫ CRV ≈ AERO ≫ ONDO**, which mirrors how
"inflationary" each project actually is.

---

## 5. Caveats (read before trusting a single figure)

1. **`market_cap / price` is an approximation.** CoinGecko's reported market cap vs its
   circulating-supply field can drift, so treat exact percentages as **± a few points**,
   especially for fast-moving names like ONDO.
2. **Early-backfill spikes.** The big maxima (AERO 225 %, ONDO 96 %, CRV 47 %) come from the
   **oldest** backfilled days, where less than a year of history existed and the short-window
   annualization amplifies a small change. They sit at the far-left of the chart and converge
   as real daily history accrues. **The recent/latest values are the reliable ones.**
3. **It's a trailing measure.** A token that just finished a big unlock cliff will read high
   for ~a year afterward even if future emissions slow — and vice-versa.
4. **Cap at 30 %.** Anything above 30 %/yr scores 0; the axis doesn't distinguish 35 % from
   80 % (both are "very dilutive"). Fine for ranking, but ONDO's 54 % and a hypothetical 35 %
   token would tie on this axis.

---

## 6. File references

- `lib/sources.js` — `getCoinGeckoPriceSeries()` (keeps `market_caps[]`), `buildCircSeries()`
- `lib/scoring.js` — `annualInflation()` / `annualInflationAt()` (the rate), `scoreEmissions()` (the 0–10 scale)
- `lib/seed.js`, `api/cron-fetch.js` — build the circ-series for backfill / live
- `api/recompute-emissions.js` — one-shot history realignment (already run)
- Weights: `WEIGHTS_FULL.emissions = 15`, `WEIGHTS_REWEIGHTED.emissions = 10`
