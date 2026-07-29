/**
 * Assignment engine checks.
 *
 * Distribution is where unfairness hides: a subtle bug hands one person every
 * lead, or quietly exceeds someone's quota, or gives a lead to somebody whose
 * scope doesn't cover it.
 *
 *   node scripts/test-assignment.mjs
 */

const inList = (v, l) => !l || l.length === 0 || (v != null && l.includes(v));

function matches(lead, rule) {
  const c = rule.conditions ?? {};
  if (!inList(lead.bu, c.bu)) return false;
  if (!inList(lead.vertical, c.vertical)) return false;
  if (!inList(lead.country, c.region)) return false;
  if (!inList(lead.priority_band, c.bands)) return false;
  if (!inList(lead.stage, c.stage)) return false;
  if (c.minPriorityScore !== undefined && (lead.priority_score ?? 0) < c.minPriorityScore) return false;
  if (c.minValue !== undefined && (lead.estimated_value ?? 0) < c.minValue) return false;
  if (c.requiresContact && lead.contact_status !== 'has_contact') return false;
  return true;
}

function covers(user, lead) {
  if (!user.isActive) return false;
  if (user.bu.length > 0 && (!lead.bu || !user.bu.includes(lead.bu))) return false;
  if (user.verticals.length > 0 && (!lead.vertical || !user.verticals.includes(lead.vertical))) return false;
  if (user.regions.length > 0 && (!lead.country || !user.regions.includes(lead.country))) return false;
  return true;
}

function pickLeastLoaded(cands) {
  const free = cands.filter((u) => u.assignedToday < u.dailyQuota);
  if (free.length === 0) return null;
  return free.sort((a, b) => {
    const ha = a.dailyQuota - a.assignedToday;
    const hb = b.dailyQuota - b.assignedToday;
    if (hb !== ha) return hb - ha;
    if (b.dailyQuota !== a.dailyQuota) return b.dailyQuota - a.dailyQuota;
    return a.id.localeCompare(b.id);
  })[0];
}

function assign(leads, rules, users) {
  const ordered = rules.filter((r) => r.enabled).sort((a, b) => a.priority - b.priority);
  const pool = users.map((u) => ({ ...u }));
  const byId = new Map(pool.map((u) => [u.id, u]));
  const assignments = [];
  let atCapacity = 0;
  let unassigned = 0;

  const queue = [...leads].filter((l) => !l.owner_user_id).sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0));

  for (const lead of queue) {
    const rule = ordered.find((r) => matches(lead, r));
    if (!rule) {
      unassigned += 1;
      continue;
    }
    let target = null;
    if (rule.toUserId) {
      const u = byId.get(rule.toUserId);
      target = u && u.isActive && covers(u, lead) && u.assignedToday < u.dailyQuota ? u : null;
    } else if (rule.toRole) {
      target = pickLeastLoaded(pool.filter((u) => u.role === rule.toRole && covers(u, lead)));
    }
    if (!target) {
      atCapacity += 1;
      continue;
    }
    target.assignedToday += 1;
    assignments.push({ leadId: lead.id, userId: target.id, ruleId: rule.id });
  }
  return { assignments, atCapacity, unassigned };
}

const lead = (id, o = {}) => ({
  id,
  bu: 'uk',
  vertical: 'data_center',
  country: 'GB',
  priority_band: 'P2',
  priority_score: 50,
  estimated_value: null,
  stage: 'act_now',
  contact_status: 'has_contact',
  owner_user_id: null,
  ...o,
});
const user = (id, o = {}) => ({
  id,
  role: 'sdr',
  bu: [],
  verticals: [],
  regions: [],
  dailyQuota: 10,
  assignedToday: 0,
  isActive: true,
  ...o,
});
const rule = (id, priority, conditions, target) => ({ id, name: id, priority, enabled: true, conditions, ...target });

let pass = 0;
let fail = 0;
const t = (name, cond) => {
  if (cond) {
    pass += 1;
    console.log('  PASS', name);
  } else {
    fail += 1;
    console.log('  FAIL', name);
  }
};

console.log('Load balancing');
{
  const leads = Array.from({ length: 9 }, (_, i) => lead('l' + i));
  const users = [user('a'), user('b'), user('c')];
  const out = assign(leads, [rule('r', 1, {}, { toRole: 'sdr' })], users);
  const counts = {};
  for (const a of out.assignments) counts[a.userId] = (counts[a.userId] ?? 0) + 1;
  t('spreads evenly across equal owners', counts.a === 3 && counts.b === 3 && counts.c === 3);
}
{
  const leads = Array.from({ length: 6 }, (_, i) => lead('l' + i));
  const users = [user('busy', { assignedToday: 5 }), user('free', { assignedToday: 0 })];
  const out = assign(leads, [rule('r', 1, {}, { toRole: 'sdr' })], users);
  const free = out.assignments.filter((a) => a.userId === 'free').length;
  t('favours the owner with more headroom', free > out.assignments.length - free);
}

console.log('\nQuota is never exceeded');
{
  const leads = Array.from({ length: 20 }, (_, i) => lead('l' + i));
  const users = [user('a', { dailyQuota: 3 }), user('b', { dailyQuota: 2 })];
  const out = assign(leads, [rule('r', 1, {}, { toRole: 'sdr' })], users);
  const counts = {};
  for (const a of out.assignments) counts[a.userId] = (counts[a.userId] ?? 0) + 1;
  t('respects each owner’s quota', counts.a === 3 && counts.b === 2);
  t('assigns no more than total capacity', out.assignments.length === 5);
  t('the rest are reported at capacity', out.atCapacity === 15);
}
{
  const leads = Array.from({ length: 5 }, (_, i) => lead('l' + i));
  const users = [user('a', { assignedToday: 10, dailyQuota: 10 })];
  const out = assign(leads, [rule('r', 1, {}, { toRole: 'sdr' })], users);
  t('an owner already at quota receives nothing', out.assignments.length === 0 && out.atCapacity === 5);
}

console.log('\nScope is respected');
{
  const leads = [lead('uk', { bu: 'uk' }), lead('usa', { bu: 'usa' })];
  const users = [user('ukOnly', { bu: ['uk'] })];
  const out = assign(leads, [rule('r', 1, {}, { toRole: 'sdr' })], users);
  t('a scoped owner only gets leads in their BU', out.assignments.length === 1 && out.assignments[0].leadId === 'uk');
}
{
  const out = assign([lead('l')], [rule('r', 1, {}, { toRole: 'sdr' })], [user('a', { bu: [], verticals: [], regions: [] })]);
  t('an empty scope means no restriction, not no leads', out.assignments.length === 1);
}
{
  const out = assign([lead('l')], [rule('r', 1, {}, { toRole: 'sdr' })], [user('a', { isActive: false })]);
  t('an inactive owner receives nothing', out.assignments.length === 0);
}

console.log('\nRule ordering and targeting');
{
  const leads = [lead('l', { stage: 'act_now' })];
  const rules = [rule('low', 2, {}, { toRole: 'bdr' }), rule('high', 1, { stage: ['act_now'] }, { toRole: 'sdr' })];
  const out = assign(leads, rules, [user('s', { role: 'sdr' }), user('b', { role: 'bdr' })]);
  t('the highest-priority matching rule wins', out.assignments[0].ruleId === 'high');
}
{
  const out = assign([lead('l')], [rule('r', 1, {}, { toUserId: 'named' })], [user('named'), user('other')]);
  t('a named target receives the lead', out.assignments[0].userId === 'named');
}
{
  const out = assign([lead('l', { bu: 'usa' })], [rule('r', 1, {}, { toUserId: 'named' })], [user('named', { bu: ['uk'] })]);
  t('a named target outside scope is skipped, not forced', out.assignments.length === 0 && out.atCapacity === 1);
}

console.log('\nPriority and eligibility');
{
  const leads = [lead('weak', { priority_score: 10 }), lead('strong', { priority_score: 95 })];
  const out = assign(leads, [rule('r', 1, {}, { toRole: 'sdr' })], [user('a', { dailyQuota: 1 })]);
  t('the strongest lead is placed when capacity is scarce', out.assignments[0].leadId === 'strong');
}
{
  const leads = [lead('no', { contact_status: 'needs_enrichment' }), lead('yes')];
  const out = assign(leads, [rule('r', 1, { requiresContact: true }, { toRole: 'sdr' })], [user('a')]);
  t('requiresContact excludes unenriched leads', out.assignments.length === 1 && out.assignments[0].leadId === 'yes');
}
{
  const out = assign([lead('l', { owner_user_id: 'someone' })], [rule('r', 1, {}, { toRole: 'sdr' })], [user('a')]);
  t('an already-owned lead is never reassigned', out.assignments.length === 0);
}
{
  const out = assign([lead('l')], [{ ...rule('r', 1, {}, { toRole: 'sdr' }), enabled: false }], [user('a')]);
  t('disabled rules assign nothing', out.assignments.length === 0 && out.unassigned === 1);
}
{
  const users = [user('a'), user('b')];
  const before = JSON.stringify(users);
  assign(Array.from({ length: 5 }, (_, i) => lead('l' + i)), [rule('r', 1, {}, { toRole: 'sdr' })], users);
  t('the caller’s user objects are not mutated', JSON.stringify(users) === before);
}
{
  const out = assign(
    Array.from({ length: 30 }, (_, i) => lead('l' + i)),
    [rule('a', 1, {}, { toRole: 'sdr' }), rule('b', 2, {}, { toRole: 'bdr' })],
    [user('s', { role: 'sdr' }), user('d', { role: 'bdr' })]
  );
  const ids = out.assignments.map((a) => a.leadId);
  t('no lead is assigned twice', new Set(ids).size === ids.length);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
