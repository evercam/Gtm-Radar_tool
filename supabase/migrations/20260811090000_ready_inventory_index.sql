-- Make the ready-inventory read survive the table getting big.
--
-- `readyInventory()` in lib/enrich/demand.ts asks for every enriched, reachable,
-- unexported lead so it can work out how much stock each person's scope covers.
-- None of those four predicates was indexed, so Postgres walked the primary key
-- and filtered as it went — and once canonical_projects passed 88,000 rows that
-- meant scanning almost all of them to find roughly 570 matches. The first page
-- alone hit the statement timeout.
--
-- The failure was quiet, which is the worse part: the read logged a warning and
-- returned an empty list, so every person's covered count was zero, every desk
-- looked maximally short, and the enrichment planner has been splitting its slots
-- against a measurement that was not taken.
--
-- A PARTIAL index, because the predicate is the selective part. The index holds
-- only the rows that are actually ready — a few hundred out of tens of thousands —
-- so it stays small as the table grows, and it grows only with unsold stock.
--
-- Columns in the index are the ones the scope match reads, so the count can be
-- answered from the index without touching the heap.

create index if not exists idx_projects_ready_inventory
  on canonical_projects (id, bu, vertical, country)
  where enriched_at is not null
    and contact_email is not null
    and apollo_exported_at is null
    and do_not_contact = false;

-- The same shape without `enriched_at`, for the assignment queue, which asks for
-- reachable-and-unassigned rather than reachable-and-enriched. It was scanning
-- for the same reason.
create index if not exists idx_projects_assignable
  on canonical_projects (id, bu, vertical, priority_score)
  where assignee_id is null
    and apollo_exported_at is null
    and do_not_contact = false;
