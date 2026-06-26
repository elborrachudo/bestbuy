# XRP / XRPL on-chain Activity — problem brief

A self-contained handoff for another engineer/AI to implement XRP's on-chain Activity
signal. Covers the data contract, the exact failing code, the observed failure, and
the blockers.

---

## 1. The goal (data contract)

BestBuy's **Activity pillar** (20% of the final score) needs, **per token, per cron run
(3×/day, ~every 8h)**, three raw values stored as a row in `score_readings`:

| Field | Meaning | How it's scored |
|---|---|---|
| `active_addresses` | active/total accounts (a **level**) | log-scaled level (40% of activity sub-score) |
| `holder_count` | holder/account count (a **level**) | **growth**: annualized Δ between consecutive snapshots (35%) |
| `transfer_count` | **cumulative** transfers/txns | **flow**: Δ/interval, as turnover (25%) |

It is **snapshot/delta-based and live-only** (no backfill — there's no honest way to
reconstruct on-chain flow historically). The exact consumer (pure function in
`lib/scoring.js`):

```js
export const W_ACTIVITY = { active: 40, holders: 35, transfers: 25 };
export function scoreActivity(prev, cur, intervalDays) {
  if (!cur || !(intervalDays > 0)) return null;
  let active = null, holders = null, transfers = null;
  if (cur.active_addresses != null)
    active = clamp((Math.log10(cur.active_addresses + 1) / 5) * 10, 0, 10);
  if (prev && prev.holder_count > 0 && cur.holder_count != null)            // GROWTH
    holders = clamp(5 + (((cur.holder_count - prev.holder_count) / prev.holder_count)
                         * (365 / intervalDays) / 0.5) * 5, 0, 10);
  if (prev && cur.transfer_count != null && prev.transfer_count != null && cur.holder_count > 0) // FLOW
    transfers = clamp((Math.max(0, cur.transfer_count - prev.transfer_count)
                       / intervalDays / cur.holder_count) * 10, 0, 10);
  return weightedBlend({ active, holders, transfers }, W_ACTIVITY);
}
```

**For XRP specifically:** XRP is the **native asset of the XRP Ledger (XRPL)**, not an
ERC-20 — there is no token contract and no "holder count" in the ERC-20 sense. The
meaningful signal is **chain-level**: number of **funded accounts** (and its growth) +
**transaction count** (flow).

> **Hard design rule:** this must be **XRPL chain activity (accounts, transactions)** —
> NOT the TVL/revenue of DeFi protocols built on XRPL (Ondo, OpenEden, XRPL DEX, …).
> That value belongs to those protocols, not to XRP.

## 2. What was tried (exact method)

A single keyless attempt in `lib/activity.js`:

```js
async function fetchXrplActivity() {
  const j = await fetchJson('https://api.xrpscan.com/api/v1/metrics');
  const active = num(j.account_count ?? j.accounts ?? j.activeAccounts ?? j.account_total);
  const tx     = num(j.tx_count ?? j.transactions ?? j.txCount ?? j.transaction_count);
  if (active == null && tx == null) return null;
  return { active_addresses: active, holder_count: null, transfer_count: tx };
}
// fetchJson = GET with {accept: 'application/json'}, 12s timeout, throws on non-200.
```

i.e. **one GET to `https://api.xrpscan.com/api/v1/metrics`**, then guess the JSON field
names with `??` fallbacks.

## 3. Result

**Failed — returned null in production.** The DB shows XRP with `holder_count`,
`transfer_count`, and `active_addresses` all null (0 activity snapshots), while 9 EVM
tokens populated fine via Blockscout. So either:

- **(a)** the endpoint returned **non-200** (wrong path / moved / rate-limited / blocks
  non-browser User-Agent) → throws → caught → null; **or**
- **(b)** it returned **200 with a JSON shape containing none of the guessed field
  names** → both values null → returns null.

It's **unknown which**, because of bottleneck #1.

## 4. Bottlenecks (the real blockers)

1. **The original author couldn't test the endpoint.** The build sandbox blocks *all*
   outbound network (egress proxy 403s every external host — CoinGecko, DefiLlama,
   Blockscout, xrpscan; even a generic web-fetch tool 403s). The code only truly runs on
   Vercel (open egress), where only the **end result (null)** is observable in the DB —
   not the HTTP status or raw JSON. `fetchActivityRaw` also swallows errors and returns
   null silently (no failure string is persisted for activity). Net effect: blind
   debugging on 8-hour cron cycles. **Anyone with normal network access can `curl` the
   candidate endpoints in seconds and read the real shape — that alone likely solves it.**
2. **No single canonical keyless XRPL "metrics" REST endpoint** cleanly returns
   `{funded_accounts, cumulative_transactions}`. The **funded-account count is the
   genuinely hard part** keyless (see candidates).
3. **Metric-semantics mismatch in the mapping.** The current code sets
   `holder_count: null` for XRP and puts accounts into `active_addresses`. But per
   `scoreActivity`, the **growth** (holders, 35%) and **flow** (transfers, 25%)
   components only fire when `holder_count > 0`. So even if `active_addresses` populates,
   XRP gets only the static log-level component → a weak, near-constant score.
   **Fix intent:** put the **funded-account count in `holder_count`** (so its growth is
   scored) and the **cumulative tx count in `transfer_count`** (so its flow is scored).
   Small mapping change once a source is confirmed.

## 5. Candidate sources to evaluate

- **XRPScan API** (`api.xrpscan.com`) — verify the correct path/shape: try
  `/api/v1/metrics`, `/api/v1/statistics`, `/api/v1/network`; check whether it needs a
  `User-Agent` header or a key.
- **XRPL Foundation data service** (`data.xrplf.org`) — has analytics/metrics endpoints;
  find the one giving daily/total account count + tx count.
- **Bithomp API** (`bithomp.com/api`) — likely **needs a free API key**, well-documented.
- **Direct XRPL JSON-RPC** (public nodes `https://xrplcluster.com/`,
  `https://s1.ripple.com:51234/`): `server_info` / `ledger` are easy, but **there is no
  cheap call that returns total funded accounts** — that needs a full ledger-state scan
  (disabled on public nodes) or an indexer. **Transaction counts are gettable; the
  account count is the constraint.** An indexer/explorer API (XRPScan / data.xrplf) is
  the realistic path for the account count.

## 6. Hard requirements for any solution

- Runs **server-side on Vercel (Node 24, global `fetch`)**, in a function with a
  few-second budget.
- **Defensive**: returns `null` on any failure (never throws — must not break the
  reading).
- Returns `{ active_addresses, holder_count, transfer_count }` where **`holder_count` =
  funded-account count** (level, for growth) and **`transfer_count` = cumulative tx
  count** (for flow). Keyless preferred; a free key is acceptable (set as a Vercel env
  var, read via `process.env`).

---

## Where this plugs in

- `lib/activity.js` → `fetchActivityRaw(token)` routes `token.chain === 'xrpl'` to
  `fetchXrplActivity()`. Replace/fix that function.
- `tracked_tokens` row for XRP: `chain = 'xrpl'`, `contract_address = null`,
  `chain_id = null`.
- The cron (`api/cron-fetch.js`) calls `fetchActivityRaw`, looks up the previous live
  snapshot, and calls `scoreActivity(prev, cur, intervalDays)`. No changes needed there
  if the raw fetch is fixed and the field mapping (#3) is applied.

**Highest-leverage next step:** `curl` the XRPScan and `data.xrplf.org` endpoints, read
the real JSON, and map `holder_count` / `transfer_count` to the right fields.
