-- 003_activity.sql — Activity pillar + raw-data archive (Etapas 2 & 3).
-- The third pillar slot (old stubbed "Sentiment") becomes on-chain "Activity".
-- score_readings grows into an append-only archive that stores, per reading, the
-- RAW values behind every score plus a backfill/live provenance flag and the
-- time-aligned price — so the full time series can be analysed (e.g. activity-vs-
-- price correlation) months from now. Rows remain immutable; only the one-shot
-- recompute touches past rows.

-- ── score_readings: provenance + raw archive ─────────────────────────────────
-- Rename the always-null Sentiment pillar to Activity (kept its data: all null).
alter table public.score_readings rename column score_sentiment to score_activity;

alter table public.score_readings
  add column if not exists source_tier      text,        -- 'live' | 'backfill'
  add column if not exists dist_from_low_pct numeric,    -- raw: % above trailing 1y low
  add column if not exists active_addresses  numeric,    -- raw on-chain (live only)
  add column if not exists holder_count      numeric,    -- raw on-chain (live only)
  add column if not exists transfer_count    numeric;    -- raw on-chain cumulative (live only)

comment on column public.score_readings.score_activity is 'pillar: on-chain adoption (active addr + holder growth + transfer flow); null in backfill and until two live snapshots exist';
comment on column public.score_readings.source_tier is 'backfill = reconstructed history; live = collected at the time';
comment on column public.score_readings.active_addresses is 'RAW cumulative/active on-chain addresses; NEVER backfilled (null before first live row)';

-- Stamp provenance on every existing row from the flag we already keep.
update public.score_readings set source_tier = case when is_backfill then 'backfill' else 'live' end
  where source_tier is null;

-- ── tracked_tokens: chain identity for on-chain activity ─────────────────────
alter table public.tracked_tokens
  add column if not exists chain            text,    -- 'base' | 'ethereum' | 'xrpl'
  add column if not exists chain_id         integer, -- EVM chainid (8453, 1); null for XRPL
  add column if not exists contract_address text;    -- token contract (EVM); null for native XRP

-- Canonical token contracts. XRP is the native asset of the XRP Ledger (no contract);
-- its activity is measured from XRPL chain metrics, NOT from XRPL DeFi protocols.
update public.tracked_tokens set chain='base',     chain_id=8453, contract_address='0x940181a94A35A4569E4529A3CDfB74e38FD98631' where symbol='AERO';
update public.tracked_tokens set chain='ethereum', chain_id=1,    contract_address='0xD533a949740bb3306d119CC777fa900bA034cd52' where symbol='CRV';
update public.tracked_tokens set chain='ethereum', chain_id=1,    contract_address='0xfAbA6f8e4a5E8Ab82F62fe7C39859FA577269BE3' where symbol='ONDO';
update public.tracked_tokens set chain='base',     chain_id=8453, contract_address='0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b' where symbol='VIRTUAL';
update public.tracked_tokens set chain='xrpl',     chain_id=null, contract_address=null where symbol='XRP';
