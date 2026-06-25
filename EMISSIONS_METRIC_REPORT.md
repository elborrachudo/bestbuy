# Emissions metric — why it matters, how we fetch it, and why it's failing

_Project: "Compro o quê?!" (bestbuy). Report generated 2026-06-25._
_Scope: the 5th scoring axis, "Emissions vs supply (low inflation scores high)."_

---

## 0. TL;DR

- **Why we want it:** emissions/inflation is the one *supply-side* fundamental in the
  model. High new-supply issuance = structural sell pressure; low/fixed supply = scarcity.
  It's independent of price action and DeFi, available (in principle) for every token, and
  separates "sound-money" tokens from high-inflation farm tokens.
- **What's failing:** we don't actually measure *emissions* (a yearly **flow** of new
  supply). We measure **uncirculated supply fraction** — a one-time **stock** — and then
  feed it into a function that assumes it's an annual rate. So every token with meaningful
  locked supply reads as "extreme inflation" and scores **0**. The axis is effectively dead
  (constant 0) and just drags every final score down without differentiating anything.
- **Root cause:** a stock-vs-flow unit mismatch, plus the CoinGecko snapshot we use has no
  time dimension to derive a real rate from.

---

## 1. What the metric is meant to capture (why it's convenient)

Token emissions = the rate at which **new supply enters circulation** (staking rewards,
liquidity incentives, team/investor unlocks, block rewards). It matters because:

1. **Structural sell pressure.** New tokens issued each year are mostly sold (farmers,
   miners, unlocked insiders). A 50%/yr inflation token must attract 50% more buy-demand
   each year just to hold price flat. This is a first-order driver of long-term price.
2. **Scarcity / "sound money" premium.** Fixed- or low-supply tokens (BTC-like) are
   structurally scarce; this is a genuine fundamental that price/RSI/MA axes don't capture.
3. **Only pure supply-side signal in the model.** The other four axes are price-trend
   (MAs), value/contrarian (% below 1y high), momentum (RSI), and DeFi usage (TVL/revenue).
   Emissions is orthogonal to all of them — it adds real information.
4. **Cheap in principle.** Supply figures come from the same CoinGecko calls we already make
   for price/supply; no extra paid provider is strictly required.

That is why it's worth 15% of the full score (10% in the reweighted/market-only scheme).

---

## 2. Current implementation (exact)

**Score function** — `lib/scoring.js`:

```js
// 5. Emissions vs supply — low inflation scores high. 0% → 10, ≥30%/yr → ~0.
export function scoreEmissions(emissionsRate) {
  if (emissionsRate == null) return null;
  return clamp(10 * (1 - emissionsRate / 0.30), 0, 10);
}
```

So the scale is: **0% → 10, 15% → 5, ≥30% → 0.** The function is explicitly built around an
**annual rate** (the `/0.30` means "30% per year is the worst case").

**The input it's fed** — `lib/scoring.js`, `buildReading()`:

```js
const emissionsRate =
  (inputs.totalSupply != null && inputs.circSupply != null && inputs.circSupply > 0)
    ? Math.max(0, (inputs.totalSupply - inputs.circSupply) / inputs.circSupply)
    : null;
```

So `emissionsRate = (totalSupply − circulatingSupply) / circulatingSupply`.

**Where the numbers come from** — `lib/sources.js`, `getCoinGeckoSupply()`:

```js
// CoinGecko /coins/{id}?market_data=true
circSupply  = md.circulating_supply            // (now: ?? market_cap/price fallback)
totalSupply = md.total_supply ?? md.max_supply
```

That's it. One snapshot call, two numbers, a subtraction, a divide.

---

## 3. How we've tried to obtain it, step by step

| Attempt | What we did | Outcome |
|---|---|---|
| 1 | Pull `circulating_supply` + `total_supply`/`max_supply` from CoinGecko `/coins/{id}` | Works as a fetch, but see §4 — wrong quantity |
| 2 | Compute `(total − circ)/circ` as the "emissions rate" | Produces a **stock** (overhang), not a **flow** (annual rate) |
| 3 | Gate scoring behind a DeFi slug (original code) | Suppressed it entirely for market-only tokens (e.g. XRP) — fixed later by decoupling |
| 4 | CRV returned `circulating_supply = null` | Added `circ = market_cap / price` fallback so the input at least exists |
| 5 | Decouple emissions from DeFi + add to reweighted weights | Now every token *gets* a number — and that number is **0** for all of them |

---

## 4. Why it's failing (root causes)

### 4.1 Stock vs flow — the core bug
`(total − circ) / circ` is the **fraction of supply not yet circulating** — a one-time
**overhang**. `scoreEmissions` treats it as an **annual emission rate**. These are different
units:

- A token with 60% of supply still locked, unlocking linearly over 10 years, has a *real*
  annual inflation of ~6%/yr — which should score ~8/10.
- Our formula sees `rate = 0.60`, compares to the 30% cap, and scores **0/10**.

The metric conflates "how much is left to unlock, ever" with "how fast it unlocks per year."

### 4.2 Consequence — the axis is constant 0
Live snapshot (2026-06-25):

| Token | circ supply | implied total | `(total−circ)/circ` | scoreEmissions |
|---|---|---|---|---|
| **XRP**  | 62.05 B | ~100 B | **0.61** | **0.0** |
| **AERO** | 0.958 B | ~1.93 B | **1.01** | **0.0** |
| **ONDO** | 4.87 B | ~10.0 B | **1.05** | **0.0** |
| **CRV**  | (was null) | — | — | null → now ~? after fallback |

Every token clamps to 0. A sub-score that is identical for all assets adds **zero
differentiating power** and simply subtracts a fixed amount from every final score
(weighted 10–15%). It actively makes the dashboard worse, not better.

### 4.3 No time dimension in the source
CoinGecko's `/coins/{id}` snapshot gives supply *today*, not a supply *history*. A true
emission rate is a derivative over time (Δsupply / Δt). You cannot derive a rate from a
single snapshot — hence the temptation to misuse the overhang as a proxy.

### 4.4 `total_supply` vs `max_supply` ambiguity
`total_supply ?? max_supply` is inconsistent across tokens:
- Some report `total_supply == circulating` (no overhang) → rate 0 → score **10** ("great"),
  even for tokens that are actually inflating.
- Some report a huge `max_supply` → rate huge → score **0**.
The same formula therefore means different things per token.

### 4.5 Reliability gaps
`circulating_supply` occasionally returns null (observed on CRV across all 366 rows). Patched
with a `market_cap / price` fallback, but that's a band-aid on top of the wrong quantity.

---

## 5. What a *correct* emissions metric needs

A real "annual inflation / emissions" signal needs **supply at two points in time**:

```
annual_inflation = (circ_supply_now − circ_supply_1yr_ago) / circ_supply_1yr_ago
```

That is a genuine yearly flow, exactly what `scoreEmissions` already expects as input. The
question is only **where to get circulating-supply history**.

---

## 6. Candidate fixes (for you to sort)

### Option A — Reinterpret as "dilution overhang" (cheapest, no new data)
Keep the snapshot, change the *meaning and scale*: cap at 100% remaining instead of 30%.
```js
// overhang: 0% locked → 10 (fully circulating), 100%+ locked → 0
scoreEmissions = clamp(10 * (1 - min(overhang, 1)), 0, 10)
```
- XRP 0.61 → **3.9**, AERO 1.01 → **0**, ONDO 1.05 → **0**.
- Pros: one-line change, uses data we already have, at least differentiates XRP.
- Cons: still a stock not a flow; doesn't distinguish "unlocks over 1 year" vs "over 10".
- Honesty: rename the axis "Supply overhang", not "Emissions".

### Option B — Real annual inflation from market-cap history (free, recommended)
CoinGecko `market_chart` already returns `prices[]` **and** `market_caps[]`. We can derive a
**circulating-supply series**: `circ_t ≈ market_cap_t / price_t`. Then:
```
inflation = (circ_today − circ_365d_ago) / circ_365d_ago
```
- Pros: a *true* annual emission rate; uses the same endpoint we already call for the price
  series (just keep the `market_caps` array we currently discard); backfillable per-day like
  the other price sub-scores; no paid API.
- Cons: `market_cap/price` is an approximation (CoinGecko's circ vs reported MC can drift);
  needs ~1y of history for the lookback (new tokens get it only after data accrues — same as
  the % -below-1y-high axis, which already handles short windows).
- Effort: modify `getCoinGeckoPriceSeries`/`getCoinGeckoPrices` to also return `market_caps`,
  compute the circ series, add an `inflation` input to `buildReading`. Medium.

### Option C — Dedicated fundamentals provider (most accurate, paid/keyed)
Token Terminal, Messari, or Artemis expose "supply inflation" / "emissions" directly.
- Pros: authoritative, already-annualized, handles unlock schedules.
- Cons: API key, likely paid tier, another integration + rate limits.

### Option D — Per-token manual emission rate
Add an `annual_emissions` column to `tracked_tokens`, filled by hand from each project's
tokenomics/docs.
- Pros: accurate, zero API.
- Cons: manual upkeep; stale as schedules change.

---

## 7. Recommendation

**Option B** is the best free path: it turns the dead axis into a real annual-inflation
signal using data we already fetch, and it's backfillable so history stays consistent. If
you want something shippable in minutes as a stopgap, **Option A** at least stops the axis
being a constant 0 — but rename it "Supply overhang" so it's honest.

Until one of these lands, the most defensible move is arguably to **drop emissions from the
weighting** entirely (so it stops dragging every score down), and reintroduce it once it
measures something real.

---

## 8. File/line references

- `lib/scoring.js` — `scoreEmissions()` (the 0→10 scale, `/0.30` cap)
- `lib/scoring.js` — `buildReading()` (`emissionsRate = (total − circ)/circ`)
- `lib/sources.js` — `getCoinGeckoSupply()` (snapshot fetch + market_cap/price fallback)
- `lib/sources.js` — `getCoinGeckoPriceSeries()` / `getCoinGeckoPrices()` (where `market_caps[]`
  would be added for Option B)
- `lib/seed.js`, `api/cron-fetch.js` — call sites that build the inputs object
- Weights: `WEIGHTS_FULL.emissions = 15`, `WEIGHTS_REWEIGHTED.emissions = 10`
