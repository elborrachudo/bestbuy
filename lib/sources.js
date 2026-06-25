// lib/sources.js — CoinGecko + DefiLlama fetch helpers. Serial requests with a
// short delay and a single 429 retry. Never throws past the per-source boundary
// in a way that would drop a whole reading — callers degrade gracefully.

const CG_BASE = 'https://api.coingecko.com/api/v3';
const LLAMA_BASE = 'https://api.llama.fi';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetch JSON with one retry on 429 / network error. Adds the CoinGecko demo key
// header when provided. Returns parsed JSON or throws.
async function fetchJson(url, { headers = {}, retries = 1, delayMs = 1200 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (res.status === 429 && attempt < retries) {
        await sleep(delayMs * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`${url} → ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt < retries) { await sleep(delayMs * (attempt + 1)); continue; }
      throw err;
    }
  }
}

function cgHeaders(apiKey) {
  return apiKey ? { 'x-cg-demo-api-key': apiKey } : {};
}

// ── CoinGecko ─────────────────────────────────────────────────────────────────

// Daily price series (ascending). Returns number[].
export async function getCoinGeckoPrices(coingeckoId, days, apiKey) {
  const url = `${CG_BASE}/coins/${coingeckoId}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
  const json = await fetchJson(url, { headers: cgHeaders(apiKey) });
  // json.prices: [[ms, price], ...]
  return (json.prices || []).map((p) => p[1]).filter((v) => typeof v === 'number');
}

// Daily price series WITH timestamps (ascending). Returns [{ ts(ms), price }].
// Used by backfill to stamp each historical row at that day's 00:00 UTC.
export async function getCoinGeckoPriceSeries(coingeckoId, days, apiKey) {
  const url = `${CG_BASE}/coins/${coingeckoId}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
  const json = await fetchJson(url, { headers: cgHeaders(apiKey) });
  return (json.prices || [])
    .filter((p) => typeof p[1] === 'number')
    .map((p) => ({ ts: p[0], price: p[1] }));
}

// Supply + current price. Returns { price, circSupply, totalSupply }.
export async function getCoinGeckoSupply(coingeckoId, apiKey) {
  const url = `${CG_BASE}/coins/${coingeckoId}` +
    `?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`;
  const json = await fetchJson(url, { headers: cgHeaders(apiKey) });
  const md = json.market_data || {};
  return {
    price: md.current_price?.usd ?? null,
    circSupply: md.circulating_supply ?? null,
    totalSupply: md.total_supply ?? md.max_supply ?? null,
  };
}

// ── DefiLlama ─────────────────────────────────────────────────────────────────

// TVL history for a protocol. Returns { series: [{ date(sec), tvl }], current }.
export async function getDefiLlamaTvl(slug) {
  const json = await fetchJson(`${LLAMA_BASE}/protocol/${slug}`);
  const raw = json.tvl || [];
  const series = raw
    .map((p) => ({ date: p.date, tvl: p.totalLiquidityUSD }))
    .filter((p) => typeof p.tvl === 'number');
  const current = series.length ? series[series.length - 1].tvl : null;
  return { series, current };
}

// Annualized holders revenue (USD/yr). Uses the most stable figure available.
export async function getDefiLlamaHoldersRevenueAnnual(slug) {
  const url = `${LLAMA_BASE}/summary/fees/${slug}?dataType=dailyHoldersRevenue`;
  const json = await fetchJson(url);
  // Prefer a 30d average annualized; fall back to total24h × 365.
  if (typeof json.total30d === 'number' && json.total30d > 0) return (json.total30d / 30) * 365;
  if (typeof json.total24h === 'number' && json.total24h > 0) return json.total24h * 365;
  if (typeof json.totalAllTime === 'number') {
    // last resort: spread all-time over its lifetime is too lossy → skip
    return null;
  }
  return null;
}

// Nearest TVL on/just-before a target unix-seconds timestamp (for backfill).
export function tvlAtDate(series, targetSec) {
  if (!series || !series.length) return null;
  let best = null;
  for (const p of series) {
    if (p.date <= targetSec) best = p.tvl; else break;
  }
  return best != null ? best : series[0].tvl;
}

// ── High-level: resolve the live inputs object for one token ──────────────────
// Returns the inputs shape expected by scoring.buildReading, plus raw fields the
// caller persists, plus `_failures` listing any source that failed.
export async function fetchTokenInputs(token, apiKey) {
  const out = {
    price: null, ma50: null, ma200: null, high90: null, low90: null, rsi14: null,
    tvlNow: null, tvl30dAgo: null, holdersRevenue: null,
    circSupply: null, totalSupply: null,
    hasDefiSlug: !!token.defillama_slug,
    _failures: [],
  };

  const { sma, highLow, rsi } = await import('./scoring.js');

  // CoinGecko price series → MAs / 90d band / RSI / current price.
  try {
    const prices = await getCoinGeckoPrices(token.coingecko_id, 200, apiKey);
    if (prices.length) {
      out.price = prices[prices.length - 1];
      out.ma50 = sma(prices, 50);
      out.ma200 = sma(prices, 200);
      out.rsi14 = rsi(prices, 14);
      const hl = highLow(prices, 90);
      out.high90 = hl.high; out.low90 = hl.low;
    }
  } catch (e) { out._failures.push(`coingecko_chart:${e.message}`); }

  await sleep(500);

  // CoinGecko supply → emissions inputs + authoritative current price.
  try {
    const sup = await getCoinGeckoSupply(token.coingecko_id, apiKey);
    if (sup.price != null) out.price = sup.price;
    out.circSupply = sup.circSupply;
    out.totalSupply = sup.totalSupply;
  } catch (e) { out._failures.push(`coingecko_coin:${e.message}`); }

  // DefiLlama fundamentals (only when a slug exists).
  if (token.defillama_slug) {
    await sleep(500);
    try {
      const { series, current } = await getDefiLlamaTvl(token.defillama_slug);
      out.tvlNow = current;
      const thirtyDaysAgoSec = Math.floor(Date.now() / 1000) - 30 * 86400;
      out.tvl30dAgo = tvlAtDate(series, thirtyDaysAgoSec);
    } catch (e) { out._failures.push(`defillama_tvl:${e.message}`); }

    await sleep(500);
    try {
      out.holdersRevenue = await getDefiLlamaHoldersRevenueAnnual(token.defillama_slug);
    } catch (e) { out._failures.push(`defillama_rev:${e.message}`); }
  }

  return out;
}
