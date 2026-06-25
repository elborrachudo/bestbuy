-- BestBuy — initial schema
-- Run this once in the Supabase SQL Editor (https://supabase.com/dashboard → your project → SQL Editor → New query).
-- Creates the two tables, indexes, RLS, public read-only policies, and seeds the four starting tokens.

-- ── Extensions ───────────────────────────────────────────────────────────────
create extension if not exists "pgcrypto";  -- for gen_random_uuid()

-- ── tracked_tokens ───────────────────────────────────────────────────────────
-- Dropdown source + per-token config. Toggling `active` stops tracking without
-- deleting history.
create table if not exists public.tracked_tokens (
  id              uuid primary key default gen_random_uuid(),
  symbol          text not null,
  name            text not null,
  coingecko_id    text not null,
  defillama_slug  text,                       -- NULL → market-only reweight
  color           text not null,              -- hex, e.g. '#22d3ee'
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

-- ── score_readings ───────────────────────────────────────────────────────────
-- One row per token per fetch.
create table if not exists public.score_readings (
  id                uuid primary key default gen_random_uuid(),
  token_id          uuid not null references public.tracked_tokens(id) on delete cascade,
  fetched_at        timestamptz not null,
  final_score       numeric(4,1) not null,
  score_price_ma    numeric(4,1),
  score_dist_low    numeric(4,1),
  score_rsi         numeric(4,1),
  score_tvl_rev     numeric(4,1),             -- null when reweighted
  score_emissions   numeric(4,1),             -- null when reweighted
  price             numeric,
  ma_50             numeric,
  ma_200            numeric,
  rsi_14            numeric,
  tvl               numeric,                  -- null when no defillama_slug
  holders_revenue   numeric,                  -- null when no defillama_slug
  circ_supply       numeric,
  emissions_rate    numeric,                  -- annualized inflation fraction, e.g. 0.20
  reweighted        boolean not null default false,  -- true = market-only score
  is_backfill       boolean not null default false   -- true = daily historical seed
);

-- ── Indexes ──────────────────────────────────────────────────────────────────
create index if not exists score_readings_token_time_idx
  on public.score_readings (token_id, fetched_at desc);   -- chart queries
create index if not exists score_readings_time_idx
  on public.score_readings (fetched_at);                  -- global recency

-- ── Row Level Security ───────────────────────────────────────────────────────
-- Public anon key can read everything; only the service role can write.
alter table public.tracked_tokens  enable row level security;
alter table public.score_readings  enable row level security;

drop policy if exists "tracked_tokens public read" on public.tracked_tokens;
create policy "tracked_tokens public read"
  on public.tracked_tokens for select
  to anon, authenticated
  using (true);

drop policy if exists "score_readings public read" on public.score_readings;
create policy "score_readings public read"
  on public.score_readings for select
  to anon, authenticated
  using (true);

-- NOTE: the frontend also inserts into tracked_tokens when the operator adds a
-- token via the "+ add" button (anon key). Allow anon INSERT on tracked_tokens
-- only. score_readings remains writable by the service role exclusively (no
-- anon write policy → RLS denies it; the service-role key bypasses RLS).
drop policy if exists "tracked_tokens anon insert" on public.tracked_tokens;
create policy "tracked_tokens anon insert"
  on public.tracked_tokens for insert
  to anon, authenticated
  with check (true);

-- Allow the operator to flip `active` off from the dropdown (remove = deactivate).
drop policy if exists "tracked_tokens anon update active" on public.tracked_tokens;
create policy "tracked_tokens anon update active"
  on public.tracked_tokens for update
  to anon, authenticated
  using (true)
  with check (true);

-- ── Seed: four starting tokens ───────────────────────────────────────────────
insert into public.tracked_tokens (symbol, name, coingecko_id, defillama_slug, color)
values
  ('AERO', 'Aerodrome', 'aerodrome-finance', 'aerodrome',      '#22d3ee'),
  ('XRP',  'Ripple',    'ripple',            null,             '#2563eb'),
  ('CRV',  'Curve',     'curve-dao-token',   'curve-finance',  '#f59e0b'),
  ('ONDO', 'Ondo',      'ondo-finance',      'ondo-finance',   '#f4f4f5')
on conflict do nothing;
