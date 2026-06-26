# BestBuy — FUNDAMENTALS_COVERAGE_AUDIT

Data collection / audit only. **No scoring logic changed, nothing deployed.** Raw data, no conclusions.

## Methodology & provenance (read first)

Direct DefiLlama API calls are **not possible from this build environment** (outbound egress is
blocked — `api.llama.fi` returns 403/blocked to every fetch tool here). So each cell is sourced
one of two ways, and the provenance is marked:

- **[DB]** — Group A (your tracked tokens). Values are the **actual DefiLlama responses already
  captured by the live backfill/cron running on Vercel**, read back from the production
  `score_readings` table. Authoritative for what the system currently sees.
  - For **protocol** tokens, `revenue` = the resolved annualized figure from the existing fallback
    chain `dailyHoldersRevenue → dailyRevenue → dailyFees` (the system stores the *resolved* value,
    not the three split out — so this audit cannot separate fees vs revenue vs holders-revenue for
    Group A; it reports the single resolved revenue number).
  - For **chain-level** tokens (ETH/SOL/AVAX/XRP), `TVL` = DefiLlama chain TVL and `revenue` =
    DefiLlama chain fees annualized.
- **[R]** — Group B (untracked category samples) + any cross-checks. From DefiLlama public pages
  via web research (the API couldn't be probed live). Figures are approximate / as-reported.

This means the **fees / revenue / holders-revenue split (separate columns) requested in §2 could
not be probed live** — see §5 for the failure reasons. The matrix below uses the columns that are
actually obtainable (TVL, resolved annual revenue, and the yes/no "non-trivial metric" verdict).

---

## §1. Tokens audited

**Group A — tracked (confirmed against `tracked_tokens`, 13 active):**
AERO, CRV, CAKE, VIRTUAL, XRP, LINK, ONDO, CVX, AVAX, SOL, ETH, HYPE, TRAC.

**Group B — category samples (NOT added to the system; coverage audited only):**

| token | proposed `coingecko_id` | proposed `defillama_slug` / chain | category |
|---|---|---|---|
| UNI | `uniswap` | `uniswap` (protocol) | DEX |
| AAVE | `aave` | `aave` (protocol) | Lending |
| AIXBT | `aixbt-by-virtuals` | *(no protocol page — see §4)* | AI agent |
| XLM | `stellar` | chain `Stellar` | Payment L1 |
| GRT | `the-graph` | `the-graph` (protocol) | Infra / oracle / data |
| ADA | `cardano` | chain `Cardano` | L1 |
| ENA | `ethena` | `ethena` (protocol) | RWA / synthetic-dollar |
| LDO | `lido-dao` | `lido` (protocol) | LST / staking |

---

## §3. THE MATRIX (main deliverable)

`TVL` and `Revenue(ann)` in USD. "Non-trivial value metric?" = does at least one real, non-null
economic-value metric exist, and which.

### Group A — from the production DB [DB]

| token | category | slug / chain | TVL | Revenue (ann, resolved) | non-trivial metric? (which) |
|---|---|---|---|---|---|
| ETH | L1 | chain `Ethereum` | $36.92B | $3.64B (chain fees) | **YES** — chain fees + chain TVL |
| HYPE | L1 / perp-DEX | protocol `hyperliquid` | $5.79B | $776M | **YES** — TVL + revenue |
| SOL | L1 | chain `Solana` | $4.72B | $2.44B (chain fees) | **YES** — chain fees + chain TVL |
| ONDO | RWA | protocol `ondo-finance` | $3.55B | $59.5M | **YES** — TVL (tokenized RWA) + revenue |
| CAKE | DEX | protocol `pancakeswap` | $2.06B | $27.8M | **YES** — TVL + revenue |
| CRV | DEX | protocol `curve-finance` | $1.23B | $9.9M | **YES** — TVL + revenue |
| CVX | Yield / gov | protocol `convex-finance` | $468M | $10.7M | **YES** — TVL + revenue (bribes/staking *do* resolve as revenue) |
| AVAX | L1 | chain `Avalanche` | $460M | $82.1M (chain fees) | **YES** — chain fees + chain TVL |
| AERO | DEX | protocol `aerodrome` | $296M | $62.2M | **YES** — TVL + revenue |
| XRP | Payment L1 | chain `XRPL` | $35.9M | $5.68M (chain fees) | **weak** — chain TVL/fees exist but tiny vs scale (real value = settlement volume, off-DefiLlama) |
| VIRTUAL | AI agent | protocol `virtuals-protocol` | **$0** | **$3.86M** | **YES — but REVENUE only** (TVL is genuinely ~0; value is agent revenue) |
| LINK | Infra / oracle | *(no slug)* | n/a | n/a | **NO DefiLlama metric** — value = CCIP/service revenue (off-DefiLlama) |
| TRAC | DePIN / data | *(no slug)* | n/a | n/a | **NO DefiLlama metric** — DePIN/knowledge-graph value (off-DefiLlama) |

### Group B — from research [R] (approximate / as-reported)

| token | category | slug / chain | TVL | Revenue (ann) | non-trivial metric? (which) |
|---|---|---|---|---|---|
| UNI | DEX | `uniswap` | ~$4–5B | swap fees large; protocol revenue historically ~low | **YES** — TVL + fees |
| AAVE | Lending | `aave` | ~$20B+ | substantial (borrow interest, liquidation, flashloan) | **YES** — TVL + revenue |
| ENA | RWA / synth-$ | `ethena` | ~$4.8B | substantial (mint fees, staking; P/F ≈ 3.8×) | **YES** — TVL + revenue |
| LDO | LST / staking | `lido` | ~$20B+ (staked ETH) | ~$100M+ (staking fee cut) | **YES** — TVL + revenue |
| GRT | Infra / data | `the-graph` | staking TVL | **small** (~$0.5M/yr query fees + burn) | **YES but small** — fees/revenue exist, tiny |
| XLM | Payment L1 | chain `Stellar` | ~$200M | ~$6.5M (chain fees) | **weak** — small chain fees; settlement volume off-DefiLlama |
| ADA | L1 | chain `Cardano` | ~$135M | **very small** (~$0.5–0.8M; 24h fees ~$1–2k) | **weak** — chain fees near-trivial; chain TVL small |
| AIXBT | AI agent | *(no protocol page)* | n/a | agent revenue exists off-DefiLlama (Virtuals agents lifetime ~$39M) | **YES but off-DefiLlama** — no standalone slug |

---

## §4. Case observations (raw, no conclusions)

- **VIRTUAL** — confirmed: **TVL = $0** (real, not a fetch failure — the protocol page returns 0),
  while **resolved annual revenue = $3.86M** (non-null). So a real economic-value metric (revenue)
  exists; the TVL-based components of the current sub-score (TVL-trend, MC/TVL) are structurally
  dead for it (TVL=0), and only MC/Revenue contributes (and it scored low: `score_tvl_rev` = 1.0,
  because MC ÷ $3.86M revenue is a high multiple).
- **XRP** — does have a DefiLlama presence via `defillama_chain = XRPL`: chain TVL ≈ $35.9M, chain
  fees ≈ $5.68M/yr. Both non-null but **very small relative to XRP's market cap** (tens of billions).
  The economically meaningful metric for a payment asset (settlement / payment volume) is **not in
  DefiLlama** — it's the XRPL ledger activity already handled in the Activity pillar.
- **L1s (SOL / ETH / AVAX / HYPE)** — chain fees/revenue are available and **non-trivial** for ETH
  ($3.64B), SOL ($2.44B), AVAX ($82M); HYPE uses a protocol slug ($776M). The L1 "TVL" (sum of all
  DeFi on the chain) is third-party capital, not the token's own — recorded here as data; both
  chain-TVL and chain-fees are present for these four.
- **ONDO (RWA)** — TVL = $3.55B represents **tokenized real-world assets** (a different nature from a
  DEX's liquidity TVL); resolved revenue = $59.5M. Both present.
- **TRAC (OriginTrail)** — category DePIN / decentralized knowledge graph. **No DefiLlama slug or
  chain** → no TVL/fees/revenue available there. Recorded as "category without DefiLlama coverage."
- **CVX** — the question (do bribes/staking show up as holders-revenue?) — **yes**: DefiLlama returns
  a non-null resolved revenue of $10.7M for `convex-finance`, captured by the system.

---

## §5. Failure reasons / why a cell is empty (distinguishing "no metric" from "call failed")

- **All §2 live HTTP probes — NOT PERFORMED.** Reason: this environment has **no outbound network**
  (egress proxy blocks `api.llama.fi`; confirmed across curl, WebFetch, and the agent fetch tool, all
  403/blocked). The §2 granular endpoints (`/summary/fees/{slug}` for `dailyFees`, `dailyRevenue`,
  `dailyHoldersRevenue` separately) therefore could not be hit live. Group A coverage was recovered
  from the production DB instead (real prior DefiLlama responses); Group B from research.
- **LINK — n/a (no slug):** Chainlink has no DefiLlama *protocol* slug configured and no chain; the
  system stores `tvl = null`, `revenue = null`. This is "no DefiLlama metric configured," not a failed
  call. Candidate off-DefiLlama metric: CCIP / oracle service revenue.
- **TRAC — n/a (no slug):** OriginTrail has no DefiLlama slug/chain; `tvl/revenue = null`. "No coverage."
- **VIRTUAL — TVL = 0 is a real value, not a failure:** the protocol page returns 0 TVL; revenue is
  non-null ($3.86M).
- **AIXBT (Group B) — no standalone DefiLlama protocol page:** revenue exists but is reported at the
  Virtuals-ecosystem level / off-DefiLlama, not as a queryable slug.
- **Fees/revenue/holders-revenue split (Group A) — not separable from the DB:** the system persists
  only the single *resolved* annual revenue (fallback `holdersRevenue → revenue → fees`), so this audit
  cannot break it into the three separate columns without a live API probe (blocked).

---

*End of audit. No scoring logic changed; nothing deployed. To fill the §2 granular fee/revenue/
holders-revenue split (and Group B exact figures) authoritatively, a live DefiLlama probe is needed —
which requires running server-side on Vercel (open egress), not this sandbox.*
