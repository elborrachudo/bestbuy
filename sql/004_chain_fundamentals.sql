-- 004_chain_fundamentals.sql — chain-level fundamentals for native L1 tokens.
-- A native L1 token (ETH/SOL/AVAX) has no DeFi *protocol* slug, but it captures its
-- chain's economic activity. `defillama_chain` points such tokens at DefiLlama's
-- chain endpoints (TVL + fees) so they get real Fundamentals instead of being
-- scored market-only. Distinct from `defillama_slug` (a single protocol) and from
-- `chain`/`contract_address` (which drive on-chain Activity, not fundamentals).

alter table public.tracked_tokens
  add column if not exists defillama_chain text;  -- DefiLlama chain name, e.g. 'Ethereum' | 'Solana' | 'Avalanche'

comment on column public.tracked_tokens.defillama_chain is
  'native L1 token → fundamentals from DefiLlama chain-level TVL/fees (set only when defillama_slug is null)';
