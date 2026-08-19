/**
 * The HTTP transport — the one a hosted connector actually speaks.
 *
 *   node --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-mcp-http.mjs
 *
 * `test-mcp.mjs` drives the STDIO server, and for a long time that was the only
 * transport under test. The two share their tools, so the tool behaviour was
 * covered — but everything that is specifically HTTP was not: version
 * negotiation, the 401 challenge that is the entire OAuth discovery mechanism,
 * CORS pre-flight, and the 405 on a stream this server does not offer.
 *
 * That gap matters more than it looks. None of those fail loudly. A client whose
 * protocol revision is contradicted refuses the session; a 401 without the
 * `WWW-Authenticate` header leaves a client guessing that this origin is also the
 * authorization server and probing it. Both present as "the connector does not
 * work", with nothing in a log to say why.
 *
 * NO CREDENTIAL IS MINTED. Everything past the handshake needs one, and creating
 * a token would mean this test writes to the live database on every run. So the
 * two decisions worth asserting past that line — which tools a caller is shown,
 * and what each entry carries — are exported as pure functions from the route and
 * checked directly. Offline: nothing here touches the network or the database.
 */

import { NextRequest } from 'next/server';

import {
  GET,
  OPTIONS,
  POST,
  SUPPORTED_PROTOCOL_VERSIONS,
  negotiateProtocolVersion,
  listToolsFor,
} from '@/app/api/mcp/route';
import { MCP_TOOLS } from '@/lib/mcp/tools';
import { PROTECTED_RESOURCE_METADATA_PATH } from '@/lib/auth/oauth/metadata';

let passed = 0,
  failed = 0;
const check = (n, c, d) => {
  if (c) {
    passed++;
    console.log(`  PASS ${n}`);
  } else {
    failed++;
    console.log(`  FAIL ${n}${d ? ' — ' + d : ''}`);
  }
};

const ORIGIN = 'https://example.test';
const req = (init = {}) =>
  new NextRequest(`${ORIGIN}/api/mcp`, {
    method: init.method ?? 'POST',
    headers: init.headers ?? {},
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });

/* -------------------------------------------------------------------------- */

console.log('Protocol version negotiation');
{
  /*
    The newest we speak is the fallback, and it is asserted as "the last entry of
    the supported list" rather than as a literal. Hard-coding the string here
    would let the list and the default drift apart while both tests still pass —
    which is exactly the shape of the bug this replaced.
  */
  const newest = SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];

  for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
    check(`a client asking for ${v} is answered in ${v}`, negotiateProtocolVersion(v) === v);
  }

  check('an unknown future revision gets our newest, not our oldest', negotiateProtocolVersion('2099-01-01') === newest);
  check('a client that names no revision gets our newest', negotiateProtocolVersion(undefined) === newest);
  check('so does one that sends a non-string', negotiateProtocolVersion(42) === newest);
  check('and one that sends an empty string', negotiateProtocolVersion('') === newest);

  /*
    The regression this guards. The default used to be the FIRST entry, so every
    unrecognised client was pushed to the oldest revision on the list rather than
    offered the best we have.
  */
  check(
    'the fallback is the newest supported, never the oldest',
    negotiateProtocolVersion('nonsense') !== SUPPORTED_PROTOCOL_VERSIONS[0] || SUPPORTED_PROTOCOL_VERSIONS.length === 1,
    `fell back to ${negotiateProtocolVersion('nonsense')}`
  );
  check('the supported list is ordered oldest to newest', [...SUPPORTED_PROTOCOL_VERSIONS].sort().join() === SUPPORTED_PROTOCOL_VERSIONS.join());
}

console.log('\ntools/list is shaped for a client, and gated');
{
  const all = MCP_TOOLS.map((t) => t.permission);
  const everything = listToolsFor([...new Set(all)]);
  check('a caller holding every permission sees every tool', everything.length === MCP_TOOLS.length, `${everything.length} of ${MCP_TOOLS.length}`);

  check(
    'every entry carries its annotations',
    everything.every((t) => t.annotations?.readOnlyHint === true),
    everything.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name).join(', ')
  );
  check(
    'every entry carries an inputSchema a client can build a form from',
    everything.every((t) => t.inputSchema && typeof t.inputSchema === 'object' && t.inputSchema.type === 'object')
  );
  check('and a description worth choosing on', everything.every((t) => (t.description ?? '').length > 40));

  /*
    Permission filtering, asserted as "fewer, and only the allowed ones".

    Listing everything and failing on call would be worse than hiding: an agent
    plans against the list it is given, so advertising a tool it cannot use buys
    a confident plan that dies halfway through.
  */
  const one = MCP_TOOLS[0].permission;
  const limited = listToolsFor([one]);
  check('a caller holding one permission sees fewer tools', limited.length < MCP_TOOLS.length, `${limited.length} of ${MCP_TOOLS.length}`);
  check(
    'and is shown nothing it could not call',
    limited.every((t) => MCP_TOOLS.find((m) => m.name === t.name).permission === one)
  );
  check('a caller holding nothing is shown nothing', listToolsFor([]).length === 0);
}

console.log('\nThe 401 is the whole OAuth discovery mechanism');
{
  /*
    A bogus bearer rather than no credential at all: the no-credential path falls
    through to a cookie session, and reading cookies outside a request scope
    throws. This is also the more relevant case — a stale token is what a
    returning client presents.

    DELIBERATELY SHORTER THAN 20 CHARACTERS. verifyToken rejects on length before
    it consults config or the database, so this stays offline in every
    environment. A longer bogus token still yields 401, but by way of a real
    query when the service role happens to be configured — and `npm test` is
    supposed to be pure.
  */
  const res = await POST(
    req({ headers: { authorization: 'Bearer gtm_bogus', 'content-type': 'application/json' }, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } })
  );

  check('an unusable credential is refused', res.status === 401, `status ${res.status}`);

  const challenge = res.headers.get('www-authenticate') ?? '';
  check('the refusal carries a WWW-Authenticate challenge', challenge.startsWith('Bearer'), challenge.slice(0, 80));
  check(
    'which points at the protected-resource document',
    challenge.includes(`resource_metadata="${ORIGIN}${PROTECTED_RESOURCE_METADATA_PATH}"`),
    challenge.slice(0, 160)
  );
  check('and says the token was the problem', /error="invalid_token"/.test(challenge), challenge.slice(0, 160));

  /*
    Without this the browser hides the header from the client, and the client
    cannot find the document it points at — a silent dead end that looks
    identical to a server that simply does not support OAuth.
  */
  check(
    'the challenge is readable cross-origin',
    (res.headers.get('access-control-expose-headers') ?? '').includes('WWW-Authenticate')
  );

  const body = await res.json();
  check('the body is still JSON-RPC, not an HTML error page', body?.jsonrpc === '2.0' && Boolean(body?.error?.message));

  /*
    Authentication comes BEFORE the handshake, and that ordering is load-bearing.
    A client that gets 200 on initialize concludes the server needs no auth at
    all, proceeds to tools/list, and reports a broken server rather than starting
    an authorization flow. The 401 has to land on the FIRST request.
  */
  check('initialize itself is gated, not just the calls after it', res.status === 401);
}

console.log('\nNotifications, pre-flight, and the stream this server does not have');
{
  const note = await POST(req({ headers: { 'content-type': 'application/json' }, body: { jsonrpc: '2.0', method: 'notifications/initialized' } }));
  check('a notification is accepted with no body', note.status === 202, `status ${note.status}`);
  check('and is not gated behind auth', note.status !== 401);

  const pre = await OPTIONS();
  check('pre-flight succeeds', pre.status === 204, `status ${pre.status}`);
  check('and allows the Authorization header', (pre.headers.get('access-control-allow-headers') ?? '').includes('Authorization'));

  /*
    A client opening GET with Accept: text/event-stream is subscribing to
    server-initiated messages. This server has none, and the spec says a server
    that does not offer that stream must answer 405 — returning 200 with a JSON
    body leaves the client waiting for events that will never arrive.
  */
  const sse = await GET(new NextRequest(`${ORIGIN}/api/mcp`, { headers: { accept: 'text/event-stream' } }));
  check('an SSE subscription is refused rather than left hanging', sse.status === 405, `status ${sse.status}`);
  check('with an Allow header naming what to do instead', sse.headers.get('allow') === 'POST');

  const descriptor = await GET(new NextRequest(`${ORIGIN}/api/mcp`));
  check('a browser gets a descriptor', descriptor.status === 200);
  const d = await descriptor.json();
  check('naming the newest revision it speaks', d.protocolVersion === SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1], d.protocolVersion);
  check('listing every revision it accepts', Array.isArray(d.supportedProtocolVersions) && d.supportedProtocolVersions.length === SUPPORTED_PROTOCOL_VERSIONS.length);
  check('declaring itself read-only', d.readOnly === true);
  check('listing its tools', Array.isArray(d.tools) && d.tools.length === MCP_TOOLS.length);
  check('and pointing at the OAuth document for somebody whose connector failed', typeof d.auth?.oauth === 'string' && d.auth.oauth.includes(PROTECTED_RESOURCE_METADATA_PATH));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
