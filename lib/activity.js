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

import { fetchBitqueryActivity } from './bitquery.js';

const num = (v) => (v == null || isNaN(Number(v)) ? null : Number(v));

async function fetchJson(url, { timeoutMs = 12000 } = {}) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json', 'user-agent': 'bestbuy/1.0 (+activity-pillar)' },
    });
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    return await res.json();
  } finally { clearTimeout(to); }
}

// chain → keyless Blockscout host. Add a row here to support a new chain (must be a
// real, public Blockscout instance — Etherscan-family explorers e.g. BscScan/Snowtrace
// need a key and won't work here).
const BLOCKSCOUT_HOST = {
  base: 'base.blockscout.com',
  ethereum: 'eth.blockscout.com',
  hyperliquid: 'hyperscan.com',   // HyperEVM Blockscout (HYPE)
};

// EVM token: Blockscout v2 token counters (keyless). Cumulative holders + transfers.
// active_addresses isn't exposed per-token by Blockscout → left null (honest gap).
async function fetchEvmTokenActivity(host, contract) {
  const j = await fetchJson(`https://${host}/api/v2/tokens/${contract}/counters`);
  const holders = num(j.token_holders_count);
  const transfers = num(j.transfers_count);
  if (holders == null && transfers == null) return null;
  return { active_addresses: null, holder_count: holders, transfer_count: transfers };
}

// Native asset (no token contract, e.g. ETH/HYPE): use the chain's Blockscout
// network stats. total_addresses → network adoption (carried as holder_count so its
// growth feeds the score), total_transactions → on-chain transfer flow.
async function fetchChainStatsActivity(host) {
  const j = await fetchJson(`https://${host}/api/v2/stats`);
  const addrs = num(j.total_addresses);
  const txs = num(j.total_transactions);
  if (addrs == null && txs == null) return null;
  return { active_addresses: null, holder_count: addrs, transfer_count: txs };
}

// XRPL (XRP is the native asset — no token contract). XRPScan aggregate ledger
// metrics: GET /api/v1/metrics/metric → daily array since 2013 of
// { date, metric: { accounts_created, transaction_count, payments_count, ... } }.
// Keyless. We accumulate the daily series into running totals so the score's GROWTH
// (holder_count) and FLOW (transfer_count) components fire — not just the static
// level. This is XRPL CHAIN activity, never XRPL-DeFi value.
async function fetchXrplActivity() {
  const arr = await fetchJson('https://api.xrpscan.com/api/v1/metrics/metric');
  if (!Array.isArray(arr) || !arr.length) return null;
  arr.sort((a, b) => new Date(a.date) - new Date(b.date));
  let cumAccounts = 0, cumTx = 0;
  for (const p of arr) {
    const m = p.metric || {};
    cumAccounts += Number(m.accounts_created) || 0;
    cumTx += Number(m.transaction_count) || 0;
  }
  const last = arr[arr.length - 1].metric || {};
  if (!cumAccounts && !cumTx) return null;
  return {
    active_addresses: num(last.accounts_created),  // recent daily new accounts (level)
    holder_count: cumAccounts || null,             // cumulative funded accounts → growth fires
    transfer_count: cumTx || null,                 // cumulative transactions → flow fires
  };
}

// Public: one raw activity snapshot for a token. Always resolves to
// { raw, error } where raw is { active_addresses, holder_count, transfer_count } or
// null, and error is a short diagnostic string (HTTP status / exception / graphql
// error / 'no-data') or null on success — so a silent null can be diagnosed from the
// DB instead of guessing across 8-hour cron cycles.
export async function fetchActivityRaw(token) {
  try {
    let raw;
    if (token.chain === 'xrpl') {
      raw = await fetchXrplActivity();
    } else {
      const host = BLOCKSCOUT_HOST[token.chain];
      if (host) {
        raw = token.contract_address
          ? await fetchEvmTokenActivity(host, token.contract_address)
          : await fetchChainStatsActivity(host);               // native asset → chain-level stats
      } else {
        raw = await fetchBitqueryActivity(token);               // keyed Bitquery fallback (BSC/AVAX/SOL)
      }
    }
    return { raw, error: raw ? null : 'no-data' };
  } catch (e) {
    return { raw: null, error: String((e && e.message) || e).slice(0, 200) };
  }
}
