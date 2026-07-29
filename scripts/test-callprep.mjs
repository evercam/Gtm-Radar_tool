/**
 * Call-prep parsing checks.
 *
 * The model's output is the untrusted input here: it may fence the JSON, omit
 * the fence, wrap it in prose, return the wrong types, or return nothing
 * usable. Every one of those must degrade to "no brief" rather than storing
 * junk or throwing inside an enrichment run.
 *
 *   node scripts/test-callprep.mjs
 */

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  if (!candidate?.trim()) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function coerce(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw;
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    company_summary: str(o.company_summary),
    key_contact: str(o.key_contact),
    business_context: str(o.business_context),
    suggested_angle: str(o.suggested_angle),
    objections_anticipated: Array.isArray(o.objections_anticipated)
      ? o.objections_anticipated.filter((x) => typeof x === 'string' && x.trim().length > 0)
      : [],
    next_best_action: str(o.next_best_action),
  };
}

const hasContent = (i) => Boolean(i && (i.company_summary || i.suggested_angle || i.business_context));
const parse = (text) => {
  const i = coerce(extractJson(text));
  return hasContent(i) ? i : null;
};

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

const good = {
  company_summary: 'A UK contractor.',
  key_contact: 'Ops director.',
  business_context: 'Breaking ground in Q3.',
  suggested_angle: 'Progress evidence for disputes.',
  objections_anticipated: ['Cost', 'Existing CCTV'],
  next_best_action: 'Book a 15-minute demo.',
};

console.log('Well-formed output');
t('parses a fenced ```json block', parse('```json\n' + JSON.stringify(good) + '\n```')?.company_summary === 'A UK contractor.');
t('parses a bare ``` fence', parse('```\n' + JSON.stringify(good) + '\n```')?.suggested_angle === 'Progress evidence for disputes.');
t('parses unfenced JSON', parse(JSON.stringify(good))?.key_contact === 'Ops director.');
t('parses JSON wrapped in prose', parse('Here you go:\n' + JSON.stringify(good) + '\nHope that helps.')?.next_best_action === 'Book a 15-minute demo.');
t('keeps the objections array', parse(JSON.stringify(good))?.objections_anticipated.length === 2);

console.log('\nMalformed output degrades to no brief');
t('truncated JSON', parse('```json\n{"company_summary": "abc"') === null);
t('prose only, no JSON', parse('I could not find enough information.') === null);
t('empty string', parse('') === null);
t('empty object', parse('{}') === null);
t('JSON array instead of object', parse('[1,2,3]') === null);
t('all fields null', parse(JSON.stringify({ company_summary: null, suggested_angle: null, business_context: null })) === null);
t('all fields blank strings', parse(JSON.stringify({ company_summary: '   ', suggested_angle: '', business_context: '' })) === null);

console.log('\nWrong types are coerced, not trusted');
t('numeric field becomes null', parse(JSON.stringify({ ...good, key_contact: 42 }))?.key_contact === null);
t('objections as a string becomes []', parse(JSON.stringify({ ...good, objections_anticipated: 'Cost' }))?.objections_anticipated.length === 0);
t('non-string objection entries are dropped', parse(JSON.stringify({ ...good, objections_anticipated: ['Cost', 7, null, 'CCTV'] }))?.objections_anticipated.length === 2);
t('a partial brief with one real field is kept', parse(JSON.stringify({ company_summary: 'A contractor.' }))?.company_summary === 'A contractor.');
t('whitespace is trimmed', parse(JSON.stringify({ company_summary: '  padded  ' }))?.company_summary === 'padded');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
