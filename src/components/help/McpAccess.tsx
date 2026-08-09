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

/**
 * A block somebody is going to copy.
 *
 * Scrolls inside itself rather than widening the page: these lines are long, and
 * a config that forces the whole article sideways on a laptop is worse than one
 * that scrolls in place.
 */
function Snippet({ children }: { children: string }) {
  return (
    <pre className="border-border-base bg-surface-raised text-body mt-2 overflow-x-auto rounded-lg border px-3 py-2 text-[11px] leading-relaxed">
      <code>{children}</code>
    </pre>
  );
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

        <HelpToggle question="How do I set it up?">
          <p>
            Two ways in, and which you want depends on whether you have the code checked out.
          </p>

          <p className="mt-2">
            <Term>1 — From this app, with a token.</Term> Nothing to install; works from anywhere.
          </p>
          <ol className="mt-1 space-y-1 pl-4" style={{ listStyle: 'decimal' }}>
            <li>
              Open <em>Settings → MCP access tokens</em>. You need the <Term>Manage credentials</Term> permission.
            </li>
            <li>
              Give it a name you will recognise later (“Claude Desktop”, “reporting script”) and pick the{' '}
              <Term>role</Term> it should read as. Start with the narrowest role that answers your questions.
            </li>
            <li>
              Copy the token immediately. It is shown once and stored only as a hash — nobody, including an admin, can
              read it back.
            </li>
            <li>
              Point your client at the endpoint below, sending the token as a bearer header.
            </li>
          </ol>
          <Snippet>{`POST https://<your-app>/api/mcp
Authorization: Bearer gtm_…
Content-Type: application/json

{"jsonrpc":"2.0","id":1,"method":"tools/list"}`}</Snippet>
          <p>
            That is the whole protocol: JSON-RPC 2.0 over POST, one request and one response. Any MCP client that speaks
            it will work, and so will <code className="text-[11px]">curl</code> if you just want to check something once.
          </p>

          <p className="mt-3">
            <Term>2 — From a checkout, with no token at all.</Term> The repository already registers a local server in{' '}
            <code className="text-[11px]">.mcp.json</code>, so an agent working inside the project picks it up on its
            own. It reads your own <code className="text-[11px]">.env.local</code>, so there is no second credential to
            create or leak.
          </p>
          <Snippet>{`{
  "mcpServers": {
    "gtm-radar": {
      "command": "node",
      "args": ["--env-file=.env.local", "--experimental-transform-types",
               "--no-warnings", "--import", "./scripts/lib/register-alias.mjs",
               "scripts/mcp-server.mjs"]
    }
  }
}`}</Snippet>
          <p>
            To check it by hand: <code className="text-[11px]">npm run mcp</code> starts it and it waits on standard
            input, which looks like nothing happening and is correct.{' '}
            <code className="text-[11px]">npm run test:mcp</code> drives it end to end and tells you what it found.
          </p>
        </HelpToggle>

        <HelpToggle question="It will not connect. What should I check?">
          <ul className="space-y-1">
            <li>
              <Term>401, “send an Authorization: Bearer token”</Term> — the header is missing or malformed. It must read{' '}
              <code className="text-[11px]">Bearer gtm_…</code>, with the word Bearer.
            </li>
            <li>
              <Term>401, “not valid, or has been revoked”</Term> — the token was revoked, or is from another workspace.
              Tokens cannot be recovered; issue a new one.
            </li>
            <li>
              <Term>The client connects but lists no tools</Term> — the token’s role holds none of the permissions the
              tools need. Widen the role, or issue the token against a broader one.
            </li>
            <li>
              <Term>A tool answers “forbidden”</Term> — that specific tool needs a permission the role lacks; the error
              names which one.
            </li>
            <li>
              <Term>The client waits forever after connecting</Term> — it is expecting a server-initiated event stream.
              This server has none, and answers <code className="text-[11px]">405</code> to that request, which a
              conformant client treats as “no stream, carry on”.
            </li>
            <li>
              <Term>The local server exits immediately</Term> — it was started without{' '}
              <code className="text-[11px]">--env-file=.env.local</code>, so it has no database credentials. It says so
              on standard error.
            </li>
          </ul>
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
