-- 002_pillars.sql — three-pillar architecture.
-- Adds pillar score columns to readings and a supply-mechanism flag to tokens.
-- History is recomputed from the sub-scores already stored on each row (no refetch).

alter table public.score_readings
  add column if not exists score_fundamentals numeric(4,1),  -- TVL/rev 60 + emissions 40; null = market-only
  add column if not exists score_technicals  numeric(4,1),   -- priceMA 45 + below-1y-high 35 + RSI 20
  add column if not exists score_sentiment   numeric(4,1);   -- stubbed (null until a feed is added)

alter table public.tracked_tokens
  add column if not exists supply_mechanism text not null default 'none';

alter table public.tracked_tokens drop constraint if exists supply_mechanism_chk;
alter table public.tracked_tokens
  add constraint supply_mechanism_chk check (supply_mechanism in ('ve-lock','burn','none'));

-- ve-lock / burn nudge the emissions sub-score up (×1.15) inside Fundamentals.
update public.tracked_tokens set supply_mechanism = 've-lock' where symbol in ('AERO','CRV');
update public.tracked_tokens set supply_mechanism = 'none'   where symbol in ('XRP','ONDO');

-- Final score is now Fundamentals 45 / Technicals 35 / Sentiment 20, with any null
-- pillar dropped and its weight redistributed. Recompute is done from stored
-- sub-scores (see api/recompute-emissions.js or the one-shot SQL in the upgrade).
