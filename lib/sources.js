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

// Daily price series WITH timestamps + market cap (ascending).
// Returns [{ ts(ms), price, marketCap }]. market_chart returns prices[] and
// market_caps[] aligned by index; we keep both so circulating supply can be
// reconstructed (circ ≈ market_cap / price) for the emissions/inflation axis.
export async function getCoinGeckoPriceSeries(coingeckoId, days, apiKey) {
  const url = `${CG_BASE}/coins/${coingeckoId}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
  const json = await fetchJson(url, { headers: cgHeaders(apiKey) });
  const caps = json.market_caps || [];
  return (json.prices || [])
    .filter((p) => typeof p[1] === 'number')
    .map((p, i) => ({
      ts: p[0],
      price: p[1],
      marketCap: (caps[i] && typeof caps[i][1] === 'number') ? caps[i][1] : null,
    }));
}

// Reconstruct a circulating-supply series from a price/market-cap series:
// circ_t ≈ market_cap_t / price_t. Drops points with no usable price/cap.
// Shape: [{ t(ms), circ }] oldest→newest. Used by the emissions/inflation axis.
export function buildCircSeries(series) {
  return (series || [])
    .filter((p) => p.price > 0 && p.marketCap != null && p.marketCap > 0)
    .map((p) => ({ t: p.ts, circ: p.marketCap / p.price }));
}

// Supply + current price. Returns { price, circSupply, totalSupply }.
export async function getCoinGeckoSupply(coingeckoId, apiKey) {
  const url = `${CG_BASE}/coins/${coingeckoId}` +
    `?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false&sparkline=false`;
  const json = await fetchJson(url, { headers: cgHeaders(apiKey) });
  const md = json.market_data || {};
  const price = md.current_price?.usd ?? null;
  let circSupply = md.circulating_supply ?? null;
  // Fallback: derive circulating supply from market cap ÷ price when the
  // circulating_supply field is missing (seen on some tokens, e.g. CRV).
  if (circSupply == null && md.market_cap?.usd != null && price != null && price > 0) {
    circSupply = md.market_cap.usd / price;
  }
  return {
    price,
    circSupply,
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

// Annualized revenue (USD/yr) for one fee dataType. 30d-avg annualized preferred,
// else total24h × 365. Returns null when this dataType has no usable figure.
async function feesAnnual(slug, dataType) {
  const url = `${LLAMA_BASE}/summary/fees/${slug}?dataType=${dataType}`;
  const json = await fetchJson(url);
  if (typeof json.total30d === 'number' && json.total30d > 0) return (json.total30d / 30) * 365;
  if (typeof json.total24h === 'number' && json.total24h > 0) return json.total24h * 365;
  return null;
}

// Annualized revenue (USD/yr). Prefers holders revenue, then protocol revenue,
// then total fees — so tokens that report fees/revenue but no holders cut
// (e.g. ONDO) still get a value instead of an empty fundamentals slot.
export async function getDefiLlamaRevenueAnnual(slug) {
  for (const dt of ['dailyHoldersRevenue', 'dailyRevenue', 'dailyFees']) {
    try {
      const v = await feesAnnual(slug, dt);
      if (v != null) return v;
    } catch { /* try the next dataType */ }
  }
  return null;
}

// ── DefiLlama chain-level (for native L1 tokens with no protocol slug) ─────────
// A native token (ETH/SOL/AVAX) captures its chain's economic activity, so its
// fundamentals come from CHAIN TVL + CHAIN fees rather than a protocol slug. This
// is distinct from attributing a third-party protocol's value to the token.

// Chain TVL history. Returns { series:[{date(sec),tvl}], current }. Same shape as
// the protocol TVL helper so the per-day backfill path is unchanged.
export async function getDefiLlamaChainTvl(chain) {
  const json = await fetchJson(`${LLAMA_BASE}/v2/historicalChainTvl/${encodeURIComponent(chain)}`);
  const series = (json || [])
    .map((p) => ({ date: p.date, tvl: p.tvl }))
    .filter((p) => typeof p.tvl === 'number');
  const current = series.length ? series[series.length - 1].tvl : null;
  return { series, current };
}

// Chain-level annualized fees (USD/yr) as the native token's revenue proxy.
// Defensive: returns null on any failure so fundamentals fall back to TVL alone.
export async function getDefiLlamaChainFeesAnnual(chain) {
  try {
    const j = await fetchJson(
      `${LLAMA_BASE}/overview/fees/${encodeURIComponent(chain)}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`
    );
    if (typeof j.total30d === 'number' && j.total30d > 0) return (j.total30d / 30) * 365;
    if (typeof j.total24h === 'number' && j.total24h > 0) return j.total24h * 365;
  } catch { /* no chain fees → TVL-only fundamentals */ }
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
    price: null, ma50: null, ma200: null, high365: null, low365: null, rsi14: null,
    circSeries: null,
    tvlNow: null, tvl30dAgo: null, holdersRevenue: null,
    circSupply: null, totalSupply: null,
    hasDefiSlug: !!token.defillama_slug,
    hasDefiChain: !!token.defillama_chain,
    supplyMechanism: token.supply_mechanism || 'none',
    category: token.category || 'defi',
    _failures: [],
  };

  const { sma, highLow, rsi } = await import('./scoring.js');

  // CoinGecko price series → MAs / 1-year high / RSI / current price / circ series.
  // 365 days covers ma200, the trailing-year high, and the 1-year inflation lookback.
  try {
    const series = await getCoinGeckoPriceSeries(token.coingecko_id, 365, apiKey);
    if (series.length) {
      const prices = series.map((p) => p.price);
      out.price = prices[prices.length - 1];
      out.ma50 = sma(prices, 50);
      out.ma200 = sma(prices, 200);
      out.rsi14 = rsi(prices, 14);
      const hl = highLow(prices, 365);
      out.high365 = hl.high;
      out.low365 = hl.low;
      out.circSeries = buildCircSeries(series);
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
      out.holdersRevenue = await getDefiLlamaRevenueAnnual(token.defillama_slug);
    } catch (e) { out._failures.push(`defillama_rev:${e.message}`); }
  } else if (token.defillama_chain) {
    // Native L1 token → chain-level TVL + chain fees as the fundamentals source.
    await sleep(500);
    try {
      const { series, current } = await getDefiLlamaChainTvl(token.defillama_chain);
      out.tvlNow = current;
      const thirtyDaysAgoSec = Math.floor(Date.now() / 1000) - 30 * 86400;
      out.tvl30dAgo = tvlAtDate(series, thirtyDaysAgoSec);
    } catch (e) { out._failures.push(`llama_chain_tvl:${e.message}`); }

    await sleep(500);
    try {
      out.holdersRevenue = await getDefiLlamaChainFeesAnnual(token.defillama_chain);
    } catch (e) { out._failures.push(`llama_chain_fees:${e.message}`); }
  }

  return out;
}
