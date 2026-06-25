// lib/activity.js — on-chain Activity snapshots (the third pillar's raw inputs).
//
// KEYLESS + DEFENSIVE: every call resolves (never throws) and degrades to nulls on
// any failure, so a reading is never dropped for lack of activity data. EVM tokens
// use Blockscout's public v2 token counters (no API key); XRP uses public XRPL
// chain metrics.
//
// HONESTY: Activity is a FLOW reconstructed from the delta between two live
// snapshots — there is NO honest backfill. The raw values returned here begin
// accumulating only from the first live call; the Activity score stays null until
// two live snapshots exist. We measure XRP's CHAIN activity (accounts, transactions)
// — never the TVL/revenue of DeFi protocols built on the XRPL, which is not XRP's.

const num = (v) => (v == null || isNaN(Number(v)) ? null : Number(v));

async function fetchJson(url, { timeoutMs = 12000 } = {}) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    return await res.json();
  } finally { clearTimeout(to); }
}

// chain → Blockscout host. Add a row here to support a new EVM chain.
const BLOCKSCOUT_HOST = { base: 'base.blockscout.com', ethereum: 'eth.blockscout.com' };

// EVM: Blockscout v2 token counters (keyless). Cumulative holders + transfers.
// active_addresses isn't exposed per-token by Blockscout → left null (honest gap).
async function fetchEvmActivity(chain, contract) {
  const host = BLOCKSCOUT_HOST[chain];
  if (!host || !contract) return null;
  const j = await fetchJson(`https://${host}/api/v2/tokens/${contract}/counters`);
  const holders = num(j.token_holders_count);
  const transfers = num(j.transfers_count);
  if (holders == null && transfers == null) return null;
  return { active_addresses: null, holder_count: holders, transfer_count: transfers };
}

// XRPL (XRP is the native asset — no token contract). Best-effort public network
// metrics. Field names are explorer-specific; we read the first that fits and null
// the rest. This is CHAIN activity, not XRPL-DeFi value.
async function fetchXrplActivity() {
  const j = await fetchJson('https://api.xrpscan.com/api/v1/metrics');
  const active = num(j.account_count ?? j.accounts ?? j.activeAccounts ?? j.account_total);
  const tx = num(j.tx_count ?? j.transactions ?? j.txCount ?? j.transaction_count);
  if (active == null && tx == null) return null;
  // No distinct "holder" concept for the native asset → holder_count stays null;
  // active_addresses carries chain accounts, transfer_count carries transactions.
  return { active_addresses: active, holder_count: null, transfer_count: tx };
}

// Public: one raw activity snapshot for a token, or null. Always resolves.
// Returns { active_addresses, holder_count, transfer_count } (any field may be null).
export async function fetchActivityRaw(token) {
  try {
    if (token.chain === 'xrpl') return await fetchXrplActivity();
    if (token.chain && token.contract_address) return await fetchEvmActivity(token.chain, token.contract_address);
    return null;
  } catch {
    return null;
  }
}
