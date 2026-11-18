-- New booking flow (owner, 2026-11-18): a booking is the uploaded ticket, the supplier and the prices. Sectors, PNR,
-- hotel name and the like are no longer typed in, so a booking without them is complete and the client sees it on
-- the portal. Older bookings keep whatever details they have. Additive.
create or replace function private.line_incomplete(svc text, d jsonb) returns boolean
language sql immutable as $$
  select false
$$;
