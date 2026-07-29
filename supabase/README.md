# Supabase — schema & migrations

One universal table, `canonical_projects`, ingests every source. Adapters map each
source into its typed columns; the original record is kept verbatim in `raw_data`
(JSONB), so any source shape lands without a schema change. No seed, no lookup tables.

```
supabase/
  config.toml                         minimal CLI config
  seed.sql                            intentionally empty
  migrations/
    20260725133256_init_canonical_projects.sql   the table + indexes + updated_at trigger
    20260725133257_enable_rls.sql                RLS + access policies
```

## Apply it — two ways

### A. SQL editor (no CLI)
Paste the root [`../supabase_setup.sql`](../supabase_setup.sql) into the Supabase
**SQL Editor** and Run. It is the two migrations concatenated, kept in sync.

### B. Supabase CLI
```bash
supabase link --project-ref <your-project-ref>   # once
supabase db push                                  # applies migrations/ in order
```
Local stack instead: `supabase start` then `supabase db reset` (runs migrations + seed).

## Access control (migration 2)

| Role | Access | How it's used |
|------|--------|----------------|
| `service_role` | full, **bypasses RLS** | server ingestion (`SUPABASE_SERVICE_ROLE_KEY`) |
| `authenticated` | full CRUD | signed-in users |
| `anon` | read-only | public `NEXT_PUBLIC_SUPABASE_ANON_KEY` |

To make the tool fully private, drop the `canonical_projects_anon_read` policy. To
scope rows per user/tenant, add a `WHERE` clause to the `authenticated` policy and a
matching owner column.

## Adding a new migration
```bash
supabase migration new <name>     # creates migrations/<timestamp>_<name>.sql
```
Write forward-only SQL, then `supabase db push`. After changing the schema, mirror it
into `../supabase_setup.sql` so the no-CLI path stays current.
