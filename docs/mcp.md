# MCP access to the tool's data

An AI assistant can query this tool's pipeline directly, instead of somebody
opening a SQL client or re-deriving the export rules by hand.

Nine read-only tools, over stdio, using your own `.env.local`. No new service to
run and no new credential — if you can already run the scripts in this repo, you
can run this.

## Setup

Nothing to configure. `.mcp.json` at the repo root registers the server, so an
MCP-aware client in this directory picks it up on its own. The only requirement
is a populated `.env.local` (the same `SUPABASE_SERVICE_ROLE_KEY` the scripts
use); the server exits with a clear message if it is missing.

To check it works:

```bash
npm run test:mcp     # spawns the server, speaks the protocol, asserts against live data
npm run mcp          # run it by hand; it waits on stdin, which is correct
```

`test:mcp` is deliberately not part of `npm test` — it needs a live database,
and everything in `npm test` is pure and offline.

## The tools

| Tool | Answers |
| --- | --- |
| `search_projects` | "Show me P1 pre-construction jobs in the USA that Anas holds and we haven't sent yet" |
| `get_project` | Everything on one project, including the same call brief the export writes into Apollo |
| `get_handover_status` | Who received leads, who is ready on the next run, and the first blocking reason for the rest |
| `list_export_runs` | When we last sent to Apollo, what scope, and the created/existing/failed counts |
| `list_assignees` | The roster, quotas, and the scope that decides who gets what |
| `summarise_pipeline` | Counts across the whole table by phase, band, vertical, BU or party |
| `list_sources` | Where the data comes from — records contributed, completeness, last delivery, on/off |
| `list_ingestion_runs` | Pulls **from** sources, with the error when one failed (not the same as export runs) |
| `get_account` | One company and every project linked to it — "what else is this contractor doing" |

Filters on `search_projects` combine with AND. `phase` uses the normalised
eleven-value vocabulary from `src/lib/phase.ts`, not the 117 raw source spellings
— but each row returns `phaseRaw` too, so you can see what the feed actually said.

`buildingType` is a substring match, which is how you reach the NHS work:
`"Healthcare"` for all of it, `"Healthcare — refurbishment"` for one kind. See
[nhs-health-infrastructure.md](nhs-health-infrastructure.md).

Two run histories exist and they answer different questions. `list_ingestion_runs`
is what we fetched **from** a source; `list_export_runs` is what we sent **to**
Apollo. Reaching for the wrong one is the easiest mistake to make here.

## Paging, and knowing when you have everything

`search_projects` returns at most 200 rows. When more match, `truncated` is
true and `nextCursor` carries an opaque position — call again with that cursor and
**the same filters** to continue. The cursor is a keyset on
`(priority_score, id)`, not an offset: it resumes at a known row rather than
counting past one, so a project inserted mid-walk cannot shift the window and make
a page skip or repeat.

`truncated` is observed, not inferred. The query asks for one row more than it
returns, so a search that happens to match exactly its limit is not reported as
truncated.

**`phase` needs `20260818220000_phase_normalised.sql`.** Before that migration the
mapping exists only in TypeScript, so the tool falls back to scanning the top rows
by score and folding phase in memory — which cannot see a matching project below
the cutoff. That path attaches a `warning` saying so. After the migration the
filter is an indexed `WHERE` and the warning disappears. If you edit a rule in
`src/lib/phase.ts`, re-run `npm run gen:phase-sql` and ship the migration, or the
column and the code will quietly disagree; `npm run test:phase-parity` is what
catches it.

## Why it is read-only

Every tool is a SELECT. Nothing assigns, exports, writes to Apollo, or edits a
policy.

That is a deliberate boundary, not an unfinished one. Those operations already
exist as scripts with dry runs and `APPLY=1` gates, and the gates are the point:
they force a human to read what is about to change before it changes. Putting the
same operations behind a conversational interface would remove exactly that
friction, against a live CRM that other people also use.

Adding a mutating tool later means adding an explicit confirmation argument and
keeping the dry run — not relaxing this.

## Three things to know if you extend it

**Declare your annotations.** `McpTool.annotations` is required, not optional, and
the nine current tools spread a shared `READ_ONLY`. That is on purpose: a hosted
client's research mode calls connector tools with no per-call approval, and
`readOnlyHint` is how it knows these are safe to run unattended. A tool that is
not read-only has to say so, and the compiler will not let it stay silent.


**stdout is the protocol channel.** A single `console.log` anywhere in the import
graph corrupts the JSON-RPC stream, and the client disconnects with no useful
error. Diagnostics go to stderr; `scripts/mcp-server.mjs` defines a `log()` helper
that does this, and `test-mcp.mjs` asserts the channel stayed clean.

**Page every count.** PostgREST caps a response at 1000 rows, so an unpaged count
is a sample dressed as a total. This has already produced two wrong figures in
this project. `pageAll()` pages to exhaustion and *reports* if it hits its own
cap, and the test pins the total against an independent head-count — a cap that
silently stops short returns a plausible round number, which is precisely what
nobody questions.
