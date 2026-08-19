/**
 * End-to-end test of the /api/cron entrypoint against a running server.
 *
 *   BASE=http://localhost:3111 CRON_SECRET=... node scripts/test-cron-endpoint.mjs
 *
 * The unit tests in test-cron.mjs cover whether a cron expression matches a
 * given minute. This covers the part that can only be tested for real: that an
 * unauthenticated caller gets nothing, that an authenticated one reaches every
 * job, and that each job hands off to the endpoint it is supposed to drive.
 *
 * Nothing here asserts that a job SUCCEEDS — an ingest with no due source and
 * an export with no Apollo key are both legitimate outcomes. What is asserted
 * is that the job ran, answered, and reported honestly.
 */

const BASE = process.env.BASE ?? 'http://localhost:3111';
const SECRET = process.env.CRON_SECRET ?? '';

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const group = (n) => console.log(`\n${n}`);

async function call(job, { token = SECRET, method = 'POST' } = {}) {
  const headers = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}/api/cron${job ? `?job=${job}` : ''}`, { method, headers });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body is itself a finding */
  }
  return { status: res.status, body };
}

/*
  Reachable, or say so and stop.

  This file talks to a running server. Without one, the first `fetch` threw an
  uncaught ECONNREFUSED and the process died on a stack trace — which is why it
  was never wired into `npm test`: a suite cannot carry a test that crashes when
  its dependency is absent. Probing first turns "no server" into a skip, the same
  contract test-export-flag.mjs already uses, so the file can live in the suite
  and actually run wherever a server IS up.
*/
const reachable = await fetch(`${BASE}/api/cron`, { method: 'POST' }).then(
  () => true,
  () => false
);
if (!reachable) {
  console.log(`No server at ${BASE} — start it with \`npm run dev\` and pass BASE. Skipping.`);
  process.exit(0);
}

group('An unauthenticated scheduler gets nothing');
{
  const noHeader = await call('daily', { token: null });
  check('a missing Authorization header is rejected', noHeader.status === 401, `got ${noHeader.status}`);
  check('the rejection is JSON, not an HTML sign-in page', noHeader.body?.ok === false);

  const wrong = await call('daily', { token: 'not-the-secret' });
  check('a wrong token is rejected', wrong.status === 401, `got ${wrong.status}`);

  // A token of the right length exercises the constant-time compare rather
  // than the length short-circuit.
  const sameLength = await call('daily', { token: 'x'.repeat(SECRET.length) });
  check('a same-length wrong token is rejected', sameLength.status === 401, `got ${sameLength.status}`);

  const empty = await call('daily', { token: '' });
  check('an empty token is rejected', empty.status === 401, `got ${empty.status}`);
}

group('Job routing');
{
  const unknown = await call('nonsense');
  check('an unknown job is a 400, not a silent no-op', unknown.status === 400, `got ${unknown.status}`);
  check('the error names the valid jobs', /ingest/.test(unknown.body?.message ?? ''), unknown.body?.message);

  const noJob = await call(null);
  check('no job parameter defaults to daily', noJob.body?.job === 'daily', JSON.stringify(noJob.body?.job));

  const viaGet = await call('ingest', { method: 'GET' });
  check('GET is accepted — many schedulers cannot POST', viaGet.status === 200, `got ${viaGet.status}`);
}

group('Each job runs and reports');
for (const job of ['ingest', 'prioritise', 'export']) {
  const r = await call(job);
  check(`${job}: answers 200`, r.status === 200, `got ${r.status}`);
  check(`${job}: echoes the job name`, r.body?.job === job, JSON.stringify(r.body?.job));
  check(`${job}: returns exactly one result`, r.body?.results?.length === 1, JSON.stringify(r.body?.results?.length));
  check(`${job}: the result carries a message`, typeof r.body?.results?.[0]?.message === 'string');
  check(`${job}: reports a duration`, typeof r.body?.durationMs === 'number');
  console.log(`       -> ${r.body?.results?.[0]?.message}`);
}

group('daily runs all three in dependency order');
{
  const r = await call('daily');
  check('answers 200', r.status === 200, `got ${r.status}`);
  const jobs = (r.body?.results ?? []).map((x) => x.job);
  check('runs three steps', jobs.length === 3, JSON.stringify(jobs));
  check('ingest first', jobs[0] === 'ingest', jobs[0]);
  check('prioritise second', /prioritize/.test(jobs[1] ?? ''), jobs[1]);
  check('export last', /export/.test(jobs[2] ?? ''), jobs[2]);
  check('ok reflects every step', r.body?.ok === (r.body?.results ?? []).every((x) => x.ok));
  for (const x of r.body?.results ?? []) console.log(`       ${x.ok ? 'ok  ' : 'fail'} ${x.job}: ${x.message}`);
}

group('Internal hand-off is authenticated, not open');
{
  // The cron route reaches the work endpoints with x-cron-secret. Without it,
  // those endpoints must refuse — otherwise anyone could drive them directly.
  const direct = await fetch(`${BASE}/api/prioritize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  check('/api/prioritize refuses an anonymous caller', direct.status === 401, `got ${direct.status}`);

  const spoofed = await fetch(`${BASE}/api/prioritize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cron-secret': 'wrong' },
    body: '{}',
  });
  check('/api/prioritize refuses a wrong x-cron-secret', spoofed.status === 401, `got ${spoofed.status}`);

  const valid = await fetch(`${BASE}/api/prioritize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cron-secret': SECRET },
    body: '{}',
  });
  check('/api/prioritize accepts the real x-cron-secret', valid.status === 200, `got ${valid.status}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
