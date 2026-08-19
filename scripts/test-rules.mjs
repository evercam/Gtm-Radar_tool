const inList=(v,l)=>!l||l.length===0||(v!=null&&l.includes(v));
function matches(r,rule,now=Date.now()){
  const c=rule.conditions||{};
  if(!inList(r.bu,c.bu))return false;
  if(!inList(r.vertical,c.vertical))return false;
  if(!inList(r.country,c.region))return false;
  if(!inList(r.record_type,c.recordTypes))return false;
  if(!inList(r.priority_band,c.bands))return false;
  if(c.minPriorityScore!==undefined&&(r.priority_score??0)<c.minPriorityScore)return false;
  if(c.minValue!==undefined&&(r.estimated_value??0)<c.minValue)return false;
  if(c.hasEmail!==undefined&&Boolean(r.contact_email)!==c.hasEmail)return false;
  if(c.recencyDays!==undefined&&r.created_at){
    const age=(now-new Date(r.created_at).getTime())/86400000;
    if(Number.isFinite(age)&&age>c.recencyDays)return false;
  }
  return true;
}
function select(records,rules,globalCap,now=Date.now()){
  const ordered=rules.filter(r=>r.enabled).sort((a,b)=>a.priority-b.priority);
  const claimed=new Set(); const selections=[]; let deferred=0;
  const cands=[...records].sort((a,b)=>(b.priority_score??0)-(a.priority_score??0));
  for(const rule of ordered){
    const rem=globalCap-claimed.size;
    if(rem<=0){deferred+=cands.filter(r=>!claimed.has(r.id)&&matches(r,rule,now)).length;continue;}
    const m=cands.filter(r=>!claimed.has(r.id)&&matches(r,rule,now));
    const taken=m.slice(0,Math.min(rule.volume.dailyLimit,rem));
    const overflow=m.length-taken.length;
    for(const r of taken)claimed.add(r.id);
    deferred+=overflow;
    if(taken.length||overflow)selections.push({ruleId:rule.id,count:taken.length,overflow});
  }
  const any=new Set();
  for(const rule of ordered)for(const r of cands)if(matches(r,rule,now))any.add(r.id);
  return{selections,selectedIds:[...claimed],deferred,unmatched:cands.filter(r=>!any.has(r.id)).length};
}

const rec=(id,o={})=>({id,bu:'uk',vertical:'data_center',country:'GB',record_type:'project',
  priority_score:50,priority_band:'P2',estimated_value:null,contact_email:null,
  created_at:new Date().toISOString(),status:'RAW',...o});

let pass=0,fail=0; const t=(n,c)=>{if(c){pass++;console.log('  PASS',n);}else{fail++;console.log('  FAIL',n);}};

console.log('Rule selection');
const R=(id,priority,cond,limit)=>({id,name:id,priority,enabled:true,conditions:cond,
  volume:{dailyLimit:limit},action:{enrich:true,autoAssign:false,generateDescription:false,contactPriority:'email'}});

// priority ordering
let recs=[rec('a',{priority_band:'P1',priority_score:90}),rec('b',{priority_band:'P2',priority_score:60})];
let out=select(recs,[R('r2',2,{bands:['P2']},10),R('r1',1,{bands:['P1']},10)],100);
t('rules run in priority order', out.selections[0].ruleId==='r1');

// a record is claimed once
recs=[rec('a',{priority_band:'P1'})];
out=select(recs,[R('r1',1,{},10),R('r2',2,{},10)],100);
t('a record is claimed by one rule only', out.selectedIds.length===1 && out.selections[1]===undefined);

// per-rule daily limit
recs=Array.from({length:20},(_,i)=>rec('r'+i));
out=select(recs,[R('r1',1,{},5)],100);
t('per-rule daily limit is respected', out.selections[0].count===5);
t('records over the limit are deferred, not lost', out.deferred===15);

// global cap beats per-rule limits
recs=Array.from({length:50},(_,i)=>rec('r'+i));
out=select(recs,[R('r1',1,{},40),R('r2',2,{},40)],10);
t('global cap caps the total', out.selectedIds.length===10);
t('cap satisfies the highest-priority rule first', out.selections[0].ruleId==='r1'&&out.selections[0].count===10);

// best-first within a rule
recs=[rec('lo',{priority_score:10}),rec('hi',{priority_score:95}),rec('mid',{priority_score:50})];
out=select(recs,[R('r1',1,{},1)],100);
t('highest-scoring record is taken first', out.selectedIds[0]==='hi');

// conditions
recs=[rec('a',{contact_email:'x@y.com'}),rec('b',{contact_email:null})];
out=select(recs,[R('r1',1,{hasEmail:false},10)],100);
t('hasEmail:false selects only records without an email', out.selectedIds.length===1&&out.selectedIds[0]==='b');

recs=[rec('old',{created_at:new Date(Date.now()-400*86400000).toISOString()}),rec('new')];
out=select(recs,[R('r1',1,{recencyDays:180},10)],100);
t('recencyDays excludes stale records', out.selectedIds.length===1&&out.selectedIds[0]==='new');

recs=[rec('small',{estimated_value:1000}),rec('big',{estimated_value:50_000_000})];
out=select(recs,[R('r1',1,{minValue:10_000_000},10)],100);
t('minValue filters by deal size', out.selectedIds.length===1&&out.selectedIds[0]==='big');

// disabled rules and unmatched
recs=[rec('a')];
out=select(recs,[{...R('r1',1,{},10),enabled:false}],100);
t('disabled rules select nothing', out.selectedIds.length===0);
t('records matching no rule are counted as unmatched', out.unmatched===1);

// exhausted budget
recs=Array.from({length:5},(_,i)=>rec('r'+i));
out=select(recs,[R('r1',1,{},10)],0);
t('zero budget defers everything', out.selectedIds.length===0&&out.deferred===5);

t('no duplicate ids in the selection', (()=>{
  const rs=Array.from({length:30},(_,i)=>rec('r'+i));
  const o=select(rs,[R('a',1,{},10),R('b',2,{},10),R('c',3,{},10)],25);
  return new Set(o.selectedIds).size===o.selectedIds.length;
})());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
