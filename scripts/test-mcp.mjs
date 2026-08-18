/**
 * Drives the MCP server over real stdio JSON-RPC.
 *
 *   node --env-file=.env.local --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-mcp.mjs
 *
 * Spawns the server as a child process and speaks the protocol to it, because the
 * failure this guards against is invisible to a unit test: stdout is the protocol
 * channel, so a single stray console.log anywhere in the import graph corrupts the
 * stream and the client disconnects with no useful error. Only an end-to-end
 * handshake proves the channel is clean.
 *
 * Read-only, like the server. Nothing here writes.
 */

import { spawn } from 'node:child_process';

import { getServiceSupabase } from '@/lib/supabase/server';

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

const child = spawn(
  process.execPath,
  [
    '--env-file=.env.local',
    '--experimental-transform-types',
    '--no-warnings',
    '--import',
    './scripts/lib/register-alias.mjs',
    'scripts/mcp-server.mjs',
  ],
  { stdio: ['pipe', 'pipe', 'pipe'] }
);

let stdout = '';
let stderr = '';
child.stdout.on('data', (d) => (stdout += d.toString()));
child.stderr.on('data', (d) => (stderr += d.toString()));

let nextId = 1;
const pending = new Map();

function pump() {
  // Line-delimited JSON-RPC. Anything that is not JSON is a corrupted stream.
  let nl;
  while ((nl = stdout.indexOf('\n')) !== -1) {
    const line = stdout.slice(0, nl).trim();
    stdout = stdout.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch {
      const resolve = pending.values().next().value;
      if (resolve) resolve({ error: { message: `non-JSON on stdout: ${line.slice(0, 120)}` } });
    }
  }
}

function send(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve) => {
    pending.set(id, resolve);
    const timer = setInterval(pump, 30);
    const done = (m) => {
      clearInterval(timer);
      resolve(m);
    };
    pending.set(id, done);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        clearInterval(timer);
        resolve({ error: { message: 'timed out after 60s' } });
      }
    }, 60_000);
  });
}

/*
  Reads `structuredContent`, the machine-readable half of a tool result.

  The text block is markdown now — a table meant to be read — so parsing it back
  into objects would assert against the PRESENTATION, and a column reorder would
  fail these pipeline tests for no reason.
*/
const payload = (res) => res?.result?.structuredContent ?? null;

console.log('Handshake');
{
  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-mcp', version: '1.0.0' },
  });
  check('server responds to initialize', Boolean(init?.result), JSON.stringify(init?.error ?? init).slice(0, 160));
  check('it identifies itself', init?.result?.serverInfo?.name === 'gtm-radar', JSON.stringify(init?.result?.serverInfo));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
}

console.log('\nThe tool contract');
{
  const list = await send('tools/list', {});
  const tools = list?.result?.tools ?? [];
  const names = tools.map((t) => t.name).sort();
  check('nine tools are advertised', tools.length === 9, names.join(', '));
  check(
    'every tool is verb-first',
    tools.every((t) => /^(search|get|list|summarise)_/.test(t.name)),
    names.join(', ')
  );
  check(
    'every tool has a description an agent can choose on',
    tools.every((t) => (t.description ?? '').length > 40),
    tools.filter((t) => (t.description ?? '').length <= 40).map((t) => t.name).join(', ')
  );
  check('names are unique', new Set(names).size === names.length);
  /*
    The safety boundary: this server is read-only by design.

    Anchored on the leading verb rather than matched anywhere in the name, because
    a substring test flags `list_export_runs` — which only READS export history.
  */
  check(
    'no tool leads with a mutating verb',
    !tools.some((t) => /^(create|update|delete|remove|export|assign|send|write|set|run|trigger|sync)_/.test(t.name)),
    names.join(', ')
  );
  check(
    'and every tool leads with a reading verb',
    tools.every((t) => /^(search|get|list|summarise)_/.test(t.name)),
    names.join(', ')
  );
}

console.log('\nReading real data');
{
  const sum = payload(await send('tools/call', { name: 'summarise_pipeline', arguments: { groupBy: 'phase' } }));
  check('summarise_pipeline returns totals', typeof sum?.records === 'number' && sum.records > 0, JSON.stringify(sum)?.slice(0, 140));
  check('grouped by normalised phase', Array.isArray(sum?.groups) && sum.groups.length > 0 && sum.groups.length <= 12, `${sum?.groups?.length} groups`);

  /*
    The total must be the whole table, checked against a head-count taken
    independently of the paging loop.

    This is the assertion that matters most in the file. A page cap that quietly
    stops short returns a plausible round number, and a plausible round number is
    exactly what nobody questions — this project has already shipped two wrong
    figures that way (a 26% that was really 4.4%, and a 1000-row "total").
  */
  const { count, error } = await getServiceSupabase()
    .from('canonical_projects')
    .select('id', { count: 'exact', head: true });
  check('a head-count is available to compare against', !error && typeof count === 'number', error?.message);
  if (typeof count === 'number') {
    check(`records equals the table count (${count})`, sum?.records === count, `tool said ${sum?.records}`);
    check('the group totals add up to it', sum?.groups?.reduce((a, g) => a + g.total, 0) === count);
    check('and no truncation was reported', !sum?.truncated, JSON.stringify(sum?.warning));
  }

  const roster = payload(await send('tools/call', { name: 'list_assignees', arguments: {} }));
  check('list_assignees returns people', Array.isArray(roster?.people), JSON.stringify(roster)?.slice(0, 120));

  const hand = payload(await send('tools/call', { name: 'get_handover_status', arguments: {} }));
  check('get_handover_status reports per person', Array.isArray(hand?.people), JSON.stringify(hand)?.slice(0, 120));

  const runs = payload(await send('tools/call', { name: 'list_export_runs', arguments: { limit: 3 } }));
  check('list_export_runs returns history', Array.isArray(runs?.runs), JSON.stringify(runs)?.slice(0, 120));

  const found = payload(await send('tools/call', { name: 'search_projects', arguments: { limit: 3 } }));
  check('search_projects returns projects', Array.isArray(found?.projects) && found.projects.length > 0, JSON.stringify(found)?.slice(0, 140));
  check(
    'each row carries the normalised phase',
    (found?.projects ?? []).every((p) => 'phase' in p && 'phaseRaw' in p)
  );

  if (found?.projects?.[0]?.ref) {
    const one = payload(await send('tools/call', { name: 'get_project', arguments: { ref: found.projects[0].ref } }));
    check('get_project resolves by ref', one?.ref === found.projects[0].ref, JSON.stringify(one)?.slice(0, 140));
    check('and includes the rendered brief', typeof one?.brief === 'string' && one.brief.length > 40);
  }
}

console.log('\nFilters actually filter');
{
  const p1 = payload(await send('tools/call', { name: 'search_projects', arguments: { band: 'P1', limit: 5 } }));
  check('band filter holds', (p1?.projects ?? []).every((p) => p.band === 'P1'), JSON.stringify(p1?.projects?.map((p) => p.band)));

  const op = payload(await send('tools/call', { name: 'search_projects', arguments: { phase: 'Operating', limit: 5 } }));
  check('normalised phase filter holds', (op?.projects ?? []).every((p) => p.phase === 'Operating'), JSON.stringify(op?.projects?.map((p) => p.phase)));

  const sent = payload(await send('tools/call', { name: 'search_projects', arguments: { exported: true, limit: 5 } }));
  check('exported filter holds', (sent?.projects ?? []).every((p) => Boolean(p.exportedAt)));
}

console.log('\nWhere the data comes from');
{
  const src = payload(await send('tools/call', { name: 'list_sources', arguments: { withRecordsOnly: true } }));
  check('list_sources returns contributing sources', Array.isArray(src?.sources) && src.sources.length > 0, JSON.stringify(src)?.slice(0, 140));
  check('withRecordsOnly means what it says', (src?.sources ?? []).every((x) => x.records > 0));
  check('and the total matches the rows', src?.totalRecords === (src?.sources ?? []).reduce((n, x) => n + x.records, 0));

  const ing = payload(await send('tools/call', { name: 'list_ingestion_runs', arguments: { limit: 5 } }));
  check('list_ingestion_runs returns pulls', Array.isArray(ing?.runs), JSON.stringify(ing)?.slice(0, 140));
  /*
    Ingestion runs are fetches FROM a source; export runs are sends TO Apollo.
    They are different tables and different questions, and conflating them is the
    reason this needed its own tool rather than a flag on the other one.
  */
  check('they are not the export runs', ing?.runs !== undefined && !('created' in (ing?.runs?.[0] ?? {})));
}

console.log('\nThe NHS construction leads are reachable');
{
  const nhs = payload(await send('tools/call', { name: 'search_projects', arguments: { buildingType: 'Healthcare', limit: 50 } }));
  check('buildingType finds them', Array.isArray(nhs?.projects), JSON.stringify(nhs)?.slice(0, 140));
  check(
    'and every hit really is one',
    (nhs?.projects ?? []).every((p) => /Healthcare/i.test(p.buildingType ?? '')),
    JSON.stringify((nhs?.projects ?? []).map((p) => p.buildingType).slice(0, 4))
  );
  // The advisory kinds were deliberately excluded from the queue.
  check(
    'no surveys or maintenance among them',
    !(nhs?.projects ?? []).some((p) => /survey|maintenance/i.test(p.buildingType ?? '')),
    JSON.stringify((nhs?.projects ?? []).map((p) => p.buildingType).filter((b) => /survey|maintenance/i.test(b ?? '')))
  );

  const bySource = payload(await send('tools/call', { name: 'search_projects', arguments: { source: 'find_a_tender_uk', limit: 5 } }));
  check('source filter holds', (bySource?.projects ?? []).every((p) => p.source === 'find_a_tender_uk'));

  const rich = payload(await send('tools/call', { name: 'search_projects', arguments: { minValue: 1_000_000, limit: 5 } }));
  check('minValue filter holds', (rich?.projects ?? []).every((p) => (p.value ?? 0) >= 1_000_000));
}

console.log('\nErrors are structured, not opaque');
{
  const bad = await send('tools/call', { name: 'get_project', arguments: {} });
  const body = payload(bad);
  check('a missing argument is reported with a code', body?.code === 'missing_argument', JSON.stringify(body));
  const ghost = payload(await send('tools/call', { name: 'get_project', arguments: { ref: 'NOPE-000' } }));
  check('an unknown ref says not_found', ghost?.code === 'not_found', JSON.stringify(ghost));
  const who = payload(await send('tools/call', { name: 'search_projects', arguments: { assignee: 'Nobody McGhost' } }));
  check('an unknown assignee lists the real ones', who?.code === 'assignee_not_found' && Array.isArray(who?.details?.available), JSON.stringify(who)?.slice(0, 160));
  const acct = payload(await send('tools/call', { name: 'get_account', arguments: { accountKey: 'no-such-account-key' } }));
  check('an unknown account says not_found', acct?.code === 'not_found', JSON.stringify(acct)?.slice(0, 140));
}

console.log('\nEvery tool is reachable from another tool');
{
  /*
    get_account takes an accountKey, and for a while nothing in this server ever
    RETURNED one — so an agent could see the tool, read its schema, and have no
    way to obtain a valid argument for it. A tool nobody can call is not a tool.

    This asserts the handle round-trips: search hands out an accountKey, and
    get_account accepts it.
  */
  const withKey = payload(
    await send('tools/call', { name: 'search_projects', arguments: { hasContact: true, limit: 60 } })
  );
  const key = (withKey?.projects ?? []).map((p) => p.accountKey).find(Boolean);
  check('search_projects hands out an accountKey', Boolean(key), 'no project in the sample carried one');
  if (key) {
    const linked = payload(await send('tools/call', { name: 'get_account', arguments: { accountKey: key } }));
    check('and get_account accepts it', linked?.accountKey === key, JSON.stringify(linked)?.slice(0, 160));
    check('returning that account’s projects', Array.isArray(linked?.projects), JSON.stringify(linked)?.slice(0, 140));
  }
}

console.log('\nThe protocol channel stayed clean');
{
  check('nothing non-JSON leaked onto stdout', !/non-JSON on stdout/.test(JSON.stringify([...pending.keys()])) && stdout.trim() === '', JSON.stringify(stdout.slice(0, 160)));
  check('diagnostics went to stderr instead', /gtm-radar MCP server ready/.test(stderr), stderr.slice(0, 200));
}

child.kill();
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
