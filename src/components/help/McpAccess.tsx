import HelpToggle from '@/components/help/HelpToggle';
import { MCP_TOOLS } from '@/lib/mcp/tools';
import { PERMISSION_LABELS } from '@/lib/auth/roles';

/**
 * Asking the tool questions in plain language.
 *
 * The rest of this page explains what the machine decides. This explains how to
 * interrogate it without opening a SQL client — which is the thing people
 * actually wanted whenever they asked somebody else to "just check how many".
 *
 * The tool list is rendered from MCP_TOOLS rather than typed out, so the page
 * cannot drift from what the server actually serves. A help page that lists a
 * tool nobody can call is worse than no list, because somebody will plan around
 * it.
 */

function Term({ children }: { children: React.ReactNode }) {
  return <span className="text-foreground font-semibold">{children}</span>;
}

/** Plain-language questions, in the order somebody would think of them. */
const ASKS: [string, string][] = [
  ['search_projects', '“P1 pre-construction jobs in the USA that Anas holds and we haven’t sent yet”'],
  ['get_project', '“Everything on UK-PROC-GB-FA028C0C, including the call brief”'],
  ['get_account', '“What else is this contractor doing?”'],
  ['get_handover_status', '“Who has leads, who is ready to send, and what is stuck”'],
  ['list_export_runs', '“When did we last send to Apollo, and what happened?”'],
  ['list_ingestion_runs', '“Did the Find a Tender pull run, and what did it bring back?”'],
  ['list_sources', '“Why do we have no leads in X?”'],
  ['list_assignees', '“Who can receive leads, and what covers what?”'],
  ['summarise_pipeline', '“How much is in each phase, band or vertical?”'],
];

export default function McpAccess() {
  const byName = new Map(MCP_TOOLS.map((t) => [t.name, t]));

  return (
    <section className="mt-12">
      <h2 className="text-foreground text-lg font-bold">Asking the tool questions directly</h2>
      <p className="text-body mt-2 text-sm">
        An AI assistant can query this pipeline itself, in plain language, instead of somebody opening a SQL client or
        working the export rules out by hand. It uses the same eligibility gates, the same phase vocabulary and the same
        handover rules as the pages here — they are one implementation, not a copy — so the answer it gives is the answer
        this app would give.
      </p>

      <div className="mt-4 space-y-2">
        <HelpToggle question="What can it answer?">
          <p>Nine tools. The question each one exists to answer:</p>
          <ul className="mt-1 space-y-1">
            {ASKS.filter(([name]) => byName.has(name)).map(([name, ask]) => (
              <li key={name}>
                <code className="text-foreground text-[11px] font-semibold">{name}</code>
                <span className="text-muted"> — {ask}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2">
            Filters combine, so “healthcare refurbishments in the UK worth over £500k that nobody has been sent yet” is a
            single question rather than four.
          </p>
        </HelpToggle>

        <HelpToggle question="How do I connect?">
          <p>
            <Term>From this app, over the internet.</Term> Create a token in <em>Settings → MCP access tokens</em>, then
            point any MCP client — Claude Desktop, an agent, a script — at{' '}
            <code className="text-[11px]">POST /api/mcp</code> with{' '}
            <code className="text-[11px]">Authorization: Bearer &lt;token&gt;</code>. Nothing to install.
          </p>
          <p>
            <Term>From a checkout, on your own machine.</Term> The repository registers a local server in{' '}
            <code className="text-[11px]">.mcp.json</code>, so an agent working in the project picks it up with no token
            and no configuration — it uses your own <code className="text-[11px]">.env.local</code>.
          </p>
        </HelpToggle>

        <HelpToggle question="What can a token see?">
          <p>
            A token carries a <Term>role</Term>, not its own list of powers. It reads exactly what somebody with that
            role can read, so narrowing a role narrows every token issued against it, and there is one place to look when
            asking what something may see.
          </p>
          <ul className="mt-1 space-y-1">
            {[...new Set(MCP_TOOLS.map((t) => t.permission))].map((p) => (
              <li key={p}>
                <span className="text-foreground font-semibold">{PERMISSION_LABELS[p] ?? p}</span>
                <span className="text-muted">
                  {' '}
                  — {MCP_TOOLS.filter((t) => t.permission === p).map((t) => t.name).join(', ')}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2">
            A client is only shown the tools its role may actually call. Listing everything and refusing on use would be
            worse: an assistant plans against the list it is given, so an unusable tool produces a confident plan that
            fails halfway.
          </p>
          <p>
            One consequence worth knowing: a role that can only see its <em>own</em> leads currently gets no tools at
            all, because every tool here reads across the pipeline. Tokens are for manager and admin roles until that
            changes.
          </p>
        </HelpToggle>

        <HelpToggle question="Can it change anything?">
          <p>
            <Term>No. Every tool is a read.</Term> Nothing assigns, exports, enriches, or edits a policy — over either
            connection, with any token.
          </p>
          <p>
            That is a deliberate boundary rather than an unfinished one. Those operations exist as scripts that show you
            what they would do and require a second, explicit command to do it, and that pause is the point: it makes a
            person read the change before it happens, against systems other people also use. Asking for something in
            conversation should not be able to skip it.
          </p>
        </HelpToggle>

        <HelpToggle question="If a token leaks, what then?">
          <p>
            Revoke it in <em>Settings</em>; it stops working on the next request. Tokens are stored as a one-way hash and
            shown exactly once when created — there is no way to reveal one afterwards, which is also why a lost token is
            replaced rather than recovered. Each row records when it was last used, so an unfamiliar token is easy to
            spot.
          </p>
        </HelpToggle>
      </div>
    </section>
  );
}
