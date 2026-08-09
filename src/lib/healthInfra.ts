/**
 * Finding the NHS contracts that are actually BUILDING something.
 *
 * An NHS trust buys nurse rotas, hip implants, Microsoft licences, interpreting
 * services and taxis. Somewhere in that stream sits a hospital redevelopment. Over
 * a 180-day window on Find a Tender and Contracts Finder, 188 notices came from a
 * health buyer and roughly thirty were building work — so a filter that merely
 * finds "NHS" returns about 16% signal, and the rest is noise a rep has to hand-sort.
 *
 * Two independent tests, both of which must pass:
 *
 *   1. the BUYER is a health body — and it is almost always the buyer, not the
 *      title, that says so. Of 13 NHS notices in a sample of 100, only 3 said
 *      "NHS" anywhere in the title or description. Matching on text alone misses
 *      three quarters of them.
 *
 *   2. the WORK is estates work — construction, refurbishment, demolition,
 *      building services, or the surveys and design that precede them.
 *
 * The second test is the hard one, because the generic construction vocabulary is
 * actively wrong on health procurement. It admits "Microsoft Infrastructure
 * Software Licensing", "Enterprise Network Infrastructure" and "Legal Services -
 * Property & Construction" on the words infrastructure and construction, while
 * missing "DBTH Asbestos Abatement" and "Ward 6B South Refurbishment Works"
 * entirely. CPV codes would settle it, but they are published on 4% of Find a
 * Tender notices and 0% of Contracts Finder ones, so there is nothing to lean on
 * but the words.
 *
 * Hence: exclusions run FIRST and win. A notice that mentions software licensing
 * is not a building project no matter how many times it says infrastructure.
 *
 * Tuned for precision over recall. "Kinnaird House Proposed Work" and "DRI Ortho
 * Minor Ops room" are genuine estates jobs this will miss, because the words that
 * would catch them also catch a dozen clinical contracts. A missed lead costs one
 * lead; a queue full of nursing-agency contracts costs the rep's trust in the
 * queue, and they stop opening it.
 *
 * Every fixture in scripts/test-health-infra.mjs is a real notice observed live
 * on 2026-08-07.
 */

export type HealthBuyerKind =
  | 'nhs_trust' // an acute/mental-health/ambulance trust — owns its estate
  | 'nhs_national' // NHS England, NHS Property Services, DHSC, UKHSA
  | 'icb' // Integrated Care Board — commissions, rarely builds
  | 'health_board' // Wales and Scotland
  | 'hsc_ni' // Northern Ireland
  | 'hospital'; // says Hospital/Infirmary without an NHS token

/** What KIND of estates work, used to set building_type so the queue is sortable. */
export type HealthWorkKind =
  | 'new_build'
  | 'refurbishment'
  | 'demolition'
  | 'building_services'
  | 'fabric'
  | 'survey_design'
  | 'maintenance';

const BUYER_RULES: { pattern: RegExp; kind: HealthBuyerKind }[] = [
  // Ordered most-specific first: "Velindre University NHS Trust" is a trust, and
  // "NHS South Yorkshire ICB" is an ICB, and both contain the token NHS.
  { pattern: /\bnhs\b[^,|]*\btrust\b|\btrust\b[^,|]*\bnhs\b/i, kind: 'nhs_trust' },
  { pattern: /\b(icb|integrated care board|clinical commissioning group|\bccg\b)\b/i, kind: 'icb' },
  {
    pattern:
      /\bnhs (england|wales|scotland|improvement|digital|supply chain|property services|business services|shared services|blood)\b|\bnhs property\b|\bdepartment of health\b|\bukhsa\b|\bdhsc\b/i,
    kind: 'nhs_national',
  },
  { pattern: /\bhealth board\b|\bbwrdd iechyd\b/i, kind: 'health_board' },
  { pattern: /\bhealth and social care trust\b|\bhsc trust\b/i, kind: 'hsc_ni' },
  // Bare NHS with no other qualifier — still a health buyer.
  { pattern: /\bnhs\b/i, kind: 'nhs_national' },
  { pattern: /\b(hospitals?|infirmary)\b/i, kind: 'hospital' },
];

/**
 * The buyer, if it is a health body.
 *
 * Deliberately NOT matched against "HSE": in Ireland that is the Health Service
 * Executive, and in Britain it is the Health and Safety Executive. The two are
 * unrelated and the abbreviation appears in ordinary safety text.
 */
export function healthBuyer(name: string | null | undefined): HealthBuyerKind | null {
  if (!name?.trim()) return null;
  for (const { pattern, kind } of BUYER_RULES) {
    if (pattern.test(name)) return kind;
  }
  return null;
}

/**
 * Not building work, whatever else the text says. Checked before anything else.
 *
 * Each entry here was earned by a real false positive. IT contracts say
 * "infrastructure", law firms are retained for "Property & Construction", a chest
 * compression device gets a "Mechanical ... Upgrade", and construction project
 * software (Aconex, Primavera) is bought by estates teams without a building
 * being involved.
 */
const NOT_BUILDING: RegExp[] = [
  /\b(software|licen[cs]|saas|subscription|microsoft|oracle|aconex|primavera|epr\b|patient administration|virtual desktop|wifi|wi-fi|roaming|network infrastructure|cyber|laptop|server hardware|it\s*-|-\s*it\b|\bict\b|digital pathway|web platform|app\b)/i,
  /\b(legal (services|advice|advisory)|solicitor|patent attorney|counsel)\b/i,
  /\b(agency|locum|recruitment|apprenticeship|training (programme|course)|course costs|leadership programme|education)\b/i,
  /\b(insourc|outsourc|clinical|patient|therapy|therapist|podiatry|dental services|pharmacy|medicines|prescrib|nursing|midwif|diagnos|pathology|radiolog(y|ist)|oncolog|cancer|mental health (support|services)|enhanced services|medical services|interpreting|translation)\b/i,
  /\b(ultrasound|scanner|laryngoscope|endoscop|autoclave|steriliz|sterilis|defibrillat|ventilator\b|implant|catheter|syringe|blade|reagent|consumables|furniture|bed frame|mattress|trolley|wheelchair)\b/i,
  /\b(taxi|catering|laundry|pest control|tyres|stationery|print credits|advertis|survey 20\d\d)\b/i,
  /*
    Soft FM and supply contracts that name building systems without touching them.

    "Security Services (Trust-wide)" is manned guarding — it described CCTV and
    access control, matched the fabric rule, and arrived at the top of the queue
    at £45m, which is the single most damaging kind of false positive. "Supply and
    Delivery of Red Diesel ... For Standby Generators" is fuel, not a generator.
  */
  /\b(security (services|guarding)|manned guard|keyholding|patrol services|portering|cleaning services|waste (collection|management|disposal))\b/i,
  /\b(supply and delivery|red diesel|rebated gas oil|fuel oil|bottled gas|cylinders? rental)\b/i,
];

/**
 * Estates signals, grouped by the kind of work they indicate.
 *
 * Order matters only for the kind label — the first group to match names the work.
 * Phrases are narrow on purpose: bare "engineering", "mechanical", "upgrade",
 * "maintenance" and "survey" all appear in clinical contracts and are excluded in
 * favour of the qualified forms ("M&E", "backlog maintenance", "condition survey").
 */
const WORK_RULES: { pattern: RegExp; kind: HealthWorkKind }[] = [
  /*
    Advisory work is tested FIRST, before the trades.

    An appointment to design or survey a job names the trade it concerns — "M&E
    Engineer Led Design Team", "Consultancy Service For Flat Roof Replacement",
    "X-Ray Rooms Design and Cost Consultancy". Tested in trade-first order those
    read as M&E and roofing, and a consultancy appointment gets filed as building
    work. What the buyer is actually purchasing is the advice.
  */
  /*
    No trailing \b on this one, and that is deliberate.

    Wrapping the alternation in \b(...)\b means an alternative ending in a word
    character cannot match when the text continues with one — so "consultancy
    service" matched and "consultancy serviceS" did not, and a RIBA Stage 4-7
    consultancy appointment was filed as refurbishment works. The leading \b is
    what prevents mid-word matches; the trailing one only broke plurals.
  */
  {
    pattern:
      /\b(planning application|architectural service|design team|design and cost|cost consultanc|consultancy service|riba stage|feasibility stud|condition survey|building survey|measured survey|structural survey|utilities detection|borehole|site investigation|building services (and|consultancy)|quantity survey|\bqs service|principal designer|estates? (strategy|utilisation|plan)|\bsurvey)/i,
    kind: 'survey_design',
  },
  /*
    Servicing an installed system is not installing one, and it has to be tested
    before the trades for the same reason as advisory work: "CRITICAL VENTILATION
    SERVICING" and "Fire Alarm Maintenance" name the system, so a trade-first
    order reads them as ventilation and fire-alarm works.
  */
  {
    pattern:
      /\b(servicing|service and maintenance|maintenance (contract|of|and repair)|alarm maintenance|planned maintenance|annual (service|maintenance)|inspection and test)/i,
    kind: 'maintenance',
  },
  {
    pattern:
      /\b(new build|newbuild|new hospital programme|redevelopment|new wing|extension (works|project)|expansion project|ground lease|development arrangements)\b/i,
    kind: 'new_build',
  },
  {
    // "Enabling works" is the trade term for clearing the way for a build — on
    // "Fluoroscopy Installation Enabling Works" it is the only estates word present.
    pattern: /\b(demolition|demolish|asbestos|abatement|strip[- ]?out|decant|enabling works)\b/i,
    kind: 'demolition',
  },
  {
    pattern: /\b(refurbish|refurbishment|renovation|fit[- ]?out|remodel|reconfigur\w* works|alterations)\b/i,
    kind: 'refurbishment',
  },
  {
    // Building services: M&E, HV/LV, plant. "AHU" is an air handling unit.
    pattern:
      /\b(m&e|mechanical and electrical|hv\/lv|\bahu\b|air handling|ventilation|heating (system|works)|boiler|chiller|substation|generator replacement|lv panel|standby power|building management system|\bbms\b(?!.*\bdata\b)|electrical works|solar pv|rooftop solar|\bpsds\b)\b/i,
    kind: 'building_services',
  },
  {
    // The building's fabric and its safety systems.
    pattern:
      /\b(roof|re-?roof|roofing|cladding|fa[cç]ade|window|glazing|door replacement|external works|brickwork|flooring|structural works|fire (alarm|safety|stopping|door)|\bcctv\b|door access)\b/i,
    kind: 'fabric',
  },
  { pattern: /\b(backlog maintenance|planned preventative maintenance|\bppm\b|lifecycle works)\b/i, kind: 'maintenance' },
  // Generic construction words last: real, but the weakest evidence.
  { pattern: /\b(construction works|building works|civil engineering|main contractor|design and build|capital works)\b/i, kind: 'refurbishment' },
];

export interface HealthWorkMatch {
  kind: HealthWorkKind | null;
  /** Why it was decided, so an unexpected classification can be traced. */
  via: 'excluded' | 'matched' | 'no-signal';
}

/** Whether the described work is building/estates work. */
export function healthWork(text: string | null | undefined): HealthWorkMatch {
  if (!text?.trim()) return { kind: null, via: 'no-signal' };
  // Exclusions win. An IT contract that says "infrastructure" is still an IT contract.
  for (const rx of NOT_BUILDING) {
    if (rx.test(text)) return { kind: null, via: 'excluded' };
  }
  for (const { pattern, kind } of WORK_RULES) {
    if (pattern.test(text)) return { kind, via: 'matched' };
  }
  return { kind: null, via: 'no-signal' };
}

/**
 * The kinds where something is physically built, altered or removed.
 *
 * The other two — `survey_design` and `maintenance` — are real estates spend and
 * genuinely useful as early-warning (a condition survey today is a refurbishment
 * next year), but they are not construction work, and a queue that mixes them in
 * reads as padded. Excluded by default; `includeAdvisory` brings them back.
 */
export const CONSTRUCTION_WORK_KINDS: ReadonlySet<HealthWorkKind> = new Set([
  'new_build',
  'refurbishment',
  'demolition',
  'building_services',
  'fabric',
]);

export interface HealthInfraMatch {
  isHealthInfra: boolean;
  buyerKind: HealthBuyerKind | null;
  workKind: HealthWorkKind | null;
  /** A short human explanation — shown in dry runs so a decision can be argued with. */
  reason: string;
}

/**
 * Both tests, together.
 *
 * `buyerName` should be the procuring entity; `text` the title plus description
 * plus any classification wording.
 */
export function classifyHealthInfra(
  buyerName: string | null | undefined,
  text: string | null | undefined,
  opts: { includeAdvisory?: boolean } = {}
): HealthInfraMatch {
  const buyerKind = healthBuyer(buyerName);
  if (!buyerKind) return { isHealthInfra: false, buyerKind: null, workKind: null, reason: 'buyer is not a health body' };
  const work = healthWork(text);
  if (work.via === 'excluded') {
    return { isHealthInfra: false, buyerKind, workKind: null, reason: 'health buyer, but the work is not construction' };
  }
  if (!work.kind) {
    return { isHealthInfra: false, buyerKind, workKind: null, reason: 'health buyer, but no estates signal in the text' };
  }
  // Advisory and maintenance spend is identified, then set aside unless asked for
  // — the work kind is still returned, so a caller can see what it passed over.
  if (!opts.includeAdvisory && !CONSTRUCTION_WORK_KINDS.has(work.kind)) {
    return {
      isHealthInfra: false,
      buyerKind,
      workKind: work.kind,
      reason: `health buyer, but ${work.kind} is not construction work`,
    };
  }
  return { isHealthInfra: true, buyerKind, workKind: work.kind, reason: `${buyerKind} buying ${work.kind}` };
}

/**
 * Human label for `building_type`, so the queue can be sorted by work kind.
 *
 * These strings are not cosmetic. `building_type` is the first input to
 * `leadVertical()`, which feeds `vertical`, which feeds the GENERATED `ref_code`
 * column — so a careless word here silently changes a record's business id.
 *
 * `leadVertical` matches loose substrings, and the natural label for the fabric
 * category — "building fabric" — contains "fab", which is the semiconductor test.
 * It classified hospital cladding as a chip plant. Hence "external envelope".
 *
 * scripts/test-health-infra.mjs asserts every label here still resolves to
 * `procurement`, so the next label added cannot quietly reintroduce this.
 */
export const WORK_LABEL: Record<HealthWorkKind, string> = {
  new_build: 'Healthcare — new build / redevelopment',
  refurbishment: 'Healthcare — refurbishment',
  demolition: 'Healthcare — demolition / enabling works',
  building_services: 'Healthcare — building services (M&E)',
  fabric: 'Healthcare — external envelope',
  survey_design: 'Healthcare — survey & design',
  maintenance: 'Healthcare — estates maintenance',
};
