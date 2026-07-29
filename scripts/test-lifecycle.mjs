const LEAD_STATUSES=['RAW','PENDING_ENRICHMENT','ENRICHING','ENRICHED','PREPARED','ASSIGNED','CONTACTED','CONVERTED','LOST'];
const ALLOWED={
 RAW:['PENDING_ENRICHMENT','LOST'],
 PENDING_ENRICHMENT:['ENRICHING','RAW','LOST'],
 ENRICHING:['ENRICHED','PENDING_ENRICHMENT','LOST'],
 ENRICHED:['PREPARED','ASSIGNED','PENDING_ENRICHMENT','LOST'],
 PREPARED:['ASSIGNED','PENDING_ENRICHMENT','LOST'],
 ASSIGNED:['CONTACTED','PREPARED','CONVERTED','LOST'],
 CONTACTED:['CONVERTED','LOST','ASSIGNED'],
 CONVERTED:['LOST'],
 LOST:['RAW'],
};
const can=(f,t)=>f===t||(ALLOWED[f]||[]).includes(t);
const MAP={ingested:'RAW',normalized:'RAW',scored:'RAW',routed:'RAW',enriching:'ENRICHING',enriched:'ENRICHED',qualified:'ASSIGNED',failed:'LOST',duplicate:'LOST'};
const req=s=>s==='act_now'?'phone':s==='nurture'?'email':s==='qualify'?'both':'none';

let pass=0,fail=0;
const t=(n,c)=>{c?(pass++,console.log('  PASS',n)):(fail++,console.log('  FAIL',n));};

console.log('Lifecycle state machine');
t('every status is reachable from RAW', (()=>{
  const seen=new Set(['RAW']); const q=['RAW'];
  while(q.length){ for(const n of ALLOWED[q.pop()]||[]) if(!seen.has(n)){seen.add(n);q.push(n);} }
  return LEAD_STATUSES.every(s=>seen.has(s));
})());
t('happy path RAW→CONVERTED walks',
  ['RAW','PENDING_ENRICHMENT','ENRICHING','ENRICHED','PREPARED','ASSIGNED','CONTACTED','CONVERTED']
    .every((s,i,a)=>i===0||can(a[i-1],s)));
t('cannot skip enrichment (RAW→ASSIGNED blocked)', !can('RAW','ASSIGNED'));
t('cannot un-contact into ENRICHING', !can('CONTACTED','ENRICHING'));
t('LOST reachable from every working stage',
  ['RAW','PENDING_ENRICHMENT','ENRICHING','ENRICHED','PREPARED','ASSIGNED','CONTACTED'].every(s=>can(s,'LOST')));
t('failed enrichment can requeue', can('ENRICHING','PENDING_ENRICHMENT'));
t('stale record can be re-enriched', can('ENRICHED','PENDING_ENRICHMENT') && can('PREPARED','PENDING_ENRICHMENT'));
t('ENRICHED may skip PREPARED when Claude is off', can('ENRICHED','ASSIGNED'));
t('self-transition is a no-op, not an error', LEAD_STATUSES.every(s=>can(s,s)));
t('no transition targets an unknown status',
  Object.values(ALLOWED).flat().every(s=>LEAD_STATUSES.includes(s)));
t('every status has a transition entry', LEAD_STATUSES.every(s=>Array.isArray(ALLOWED[s])));

console.log('\nprocessing_status backfill');
t('scored/routed map to RAW (nothing spent yet)', MAP.scored==='RAW'&&MAP.routed==='RAW');
t('failed and duplicate map to LOST', MAP.failed==='LOST'&&MAP.duplicate==='LOST');
t('every legacy value maps to a real status',
  Object.values(MAP).every(s=>LEAD_STATUSES.includes(s)));

console.log('\nChannel requirements');
t('act_now requires phone', req('act_now')==='phone');
t('nurture requires email', req('nurture')==='email');
t('qualify requires both', req('qualify')==='both');
t('hold requires nothing', req('hold')==='none');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
