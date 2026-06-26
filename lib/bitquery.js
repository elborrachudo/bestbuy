// lib/bitquery.js — keyed on-chain activity via Bitquery, for chains that have no
// public keyless Blockscout. Starts with BSC (CAKE); Avalanche/Solana are added
// once this path is verified against a live cron.
//
// Auth: OAuth2 client-credentials. BITQUERY_CLIENT_ID + BITQUERY_CLIENT_SECRET are
// exchanged for a short-lived access token on each run (so the 7-day token rotation
// is handled automatically — nothing to refresh by hand).
//
// FULLY DEFENSIVE: every path resolves to null on any failure, so a reading is never
// dropped. NOTE: this could not be tested from the build sandbox (no outbound network)
// — expect to tune the GraphQL field names against the first live response.

const num = (v) => (v == null || isNaN(Number(v)) ? null : Number(v));

async function postJson(url, opts, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    return await res.json();
  } finally { clearTimeout(to); }
}

// client credentials → access token (null if creds unset or exchange fails).
async function getAccessToken() {
  const id = process.env.BITQUERY_CLIENT_ID, secret = process.env.BITQUERY_CLIENT_SECRET;
  if (!id || !secret) return null;
  const body = new URLSearchParams({
    grant_type: 'client_credentials', client_id: id, client_secret: secret, scope: 'api',
  }).toString();
  const j = await postJson('https://oauth2.bitquery.io/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  return j && j.access_token ? j.access_token : null;
}

async function gql(token, query) {
  const j = await postJson('https://streaming.bitquery.io/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query }),
  });
  return j && j.data ? j.data : null;
}

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

// EVM token (e.g. CAKE on BSC): unique holders + a recent transfer count. Each metric
// is fetched independently so one finicky query doesn't void the other.
async function evmTokenActivity(network, contract) {
  const token = await getAccessToken();
  if (!token) return null;
  let holders = null, transfers = null;
  try {
    const d = await gql(token, `{ EVM(network: ${network}, dataset: archive) {
      TokenHolders(date: "${ymd(Date.now())}", tokenSmartContract: "${contract}", limit: {count: 1}) {
        uniq(of: Holder_Address)
      } } }`);
    const th = d && d.EVM && d.EVM.TokenHolders;
    if (Array.isArray(th) && th.length) holders = num(th[0].uniq);
  } catch { /* holder query is the finickiest — tolerate failure */ }
  try {
    const since = ymd(Date.now() - 30 * 86400000);
    const d = await gql(token, `{ EVM(network: ${network}, dataset: combined) {
      Transfers(where: {Transfer: {Currency: {SmartContract: {is: "${contract}"}}}, Block: {Date: {since: "${since}"}}}) {
        count
      } } }`);
    const tr = d && d.EVM && d.EVM.Transfers;
    if (Array.isArray(tr) && tr.length) transfers = num(tr[0].count);
  } catch { /* */ }
  if (holders == null && transfers == null) return null;
  return { active_addresses: null, holder_count: holders, transfer_count: transfers };
}

// Public: keyed activity for a token, or null. Always resolves.
export async function fetchBitqueryActivity(token) {
  try {
    if (token.chain === 'bsc' && token.contract_address) return await evmTokenActivity('bsc', token.contract_address);
    // Avalanche (native) + Solana (native) handled after the BSC path is verified.
    return null;
  } catch {
    return null;
  }
}
