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
  // GraphQL errors come back as HTTP 200 with {errors:[...]} — surface them so a wrong
  // field name is visible in activity_error instead of silently nulling.
  if (j && j.errors) throw new Error('bitquery-gql: ' + JSON.stringify(j.errors).slice(0, 160));
  return j && j.data ? j.data : null;
}

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

// EVM token (e.g. CAKE on BSC): unique holders + a recent transfer count. Each metric
// is fetched independently so one finicky query doesn't void the other.
async function evmTokenActivity(network, contract) {
  const token = await getAccessToken();
  if (!token) throw new Error('bitquery: no access token (creds unset or auth failed)');
  let holders = null, transfers = null, lastErr = null;
  try {
    const d = await gql(token, `{ EVM(network: ${network}, dataset: archive) {
      TokenHolders(date: "${ymd(Date.now())}", tokenSmartContract: "${contract}", limit: {count: 1}) {
        uniq(of: Holder_Address)
      } } }`);
    const th = d && d.EVM && d.EVM.TokenHolders;
    if (Array.isArray(th) && th.length) holders = num(th[0].uniq);
  } catch (e) { lastErr = e; }
  try {
    const since = ymd(Date.now() - 30 * 86400000);
    const d = await gql(token, `{ EVM(network: ${network}, dataset: combined) {
      Transfers(where: {Transfer: {Currency: {SmartContract: {is: "${contract}"}}}, Block: {Date: {since: "${since}"}}}) {
        count
      } } }`);
    const tr = d && d.EVM && d.EVM.Transfers;
    if (Array.isArray(tr) && tr.length) transfers = num(tr[0].count);
  } catch (e) { lastErr = e; }
  // Surface the query error when nothing came back, so it lands in activity_error.
  if (holders == null && transfers == null) { if (lastErr) throw lastErr; return null; }
  return { active_addresses: null, holder_count: holders, transfer_count: transfers };
}

// EVM native chain (e.g. AVAX on Avalanche): chain-level tx flow + unique senders
// (carried as active_addresses) over a trailing window.
async function evmChainActivity(network) {
  const token = await getAccessToken();
  if (!token) throw new Error('bitquery: no access token (creds unset or auth failed)');
  const since = ymd(Date.now() - 30 * 86400000);
  const d = await gql(token, `{ EVM(network: ${network}, dataset: combined) {
    Transactions(where: {Block: {Date: {since: "${since}"}}}) {
      count
      uniq(of: Transaction_From)
    } } }`);
  const tx = d && d.EVM && d.EVM.Transactions;
  if (Array.isArray(tx) && tx.length) {
    const transfers = num(tx[0].count), active = num(tx[0].uniq);
    if (active != null || transfers != null) return { active_addresses: active, holder_count: null, transfer_count: transfers };
  }
  return null;
}

// Solana (separate schema): tx flow + unique signers (carried as active_addresses).
async function solanaChainActivity() {
  const token = await getAccessToken();
  if (!token) throw new Error('bitquery: no access token (creds unset or auth failed)');
  const since = ymd(Date.now() - 30 * 86400000);
  const d = await gql(token, `{ Solana {
    Transactions(where: {Block: {Date: {since: "${since}"}}}) {
      count
      uniq(of: Transaction_Signer)
    } } }`);
  const tx = d && d.Solana && d.Solana.Transactions;
  if (Array.isArray(tx) && tx.length) {
    const transfers = num(tx[0].count), active = num(tx[0].uniq);
    if (active != null || transfers != null) return { active_addresses: active, holder_count: null, transfer_count: transfers };
  }
  return null;
}

// Public: keyed activity for a token, or null. Errors propagate to fetchActivityRaw,
// which records them in activity_error (so blind GraphQL failures are diagnosable).
export async function fetchBitqueryActivity(token) {
  if (token.chain === 'bsc' && token.contract_address) return await evmTokenActivity('bsc', token.contract_address);
  if (token.chain === 'avalanche') return await evmChainActivity('avalanche');
  if (token.chain === 'solana') return await solanaChainActivity();
  return null;
}
