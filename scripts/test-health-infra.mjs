/**
 * The NHS estates filter, pinned against real notices.
 *
 *   node --experimental-transform-types --no-warnings \
 *        --import ./scripts/lib/register-alias.mjs scripts/test-health-infra.mjs
 *
 * Every string below was observed live on Find a Tender or Contracts Finder on
 * 2026-08-07. That matters: the traps in here are not hypothetical, they are the
 * notices that a generic construction keyword filter actually admits — a Microsoft
 * licensing renewal, a law firm retainer, and a chest compression device.
 *
 * The precision cases are the point of the file. Recall can be improved later by
 * adding a phrase; precision is what a rep judges the queue on, and once they see
 * three nursing-agency contracts in a "construction leads" list they stop opening it.
 *
 * Pure — no network, no database.
 */

import { classifyHealthInfra, healthBuyer, healthWork, WORK_LABEL } from '@/lib/healthInfra';
import { leadVertical } from '@/lib/classify';

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

const NHS_TRUST = 'East and North Hertfordshire Teaching NHS Trust';
/** Asserts the pair (buyer, text) is or is not a health-infrastructure lead. */
const wants = (text, yes, buyer = NHS_TRUST) => {
  const r = classifyHealthInfra(buyer, text);
  check(`${yes ? 'KEEP' : 'DROP'}  ${text.slice(0, 72)}`, r.isHealthInfra === yes, `${r.reason} (work=${r.workKind})`);
};

console.log('The buyer is what says NHS, not the title');
{
  // Of 13 NHS notices in a sample of 100, only 3 said NHS in the title.
  check('a foundation trust', healthBuyer('Mid and South Essex NHS Foundation Trust') === 'nhs_trust');
  check('a university trust with a trailing space', healthBuyer('Velindre University NHS Trust ') === 'nhs_trust');
  check('an ICB is not read as a trust', healthBuyer('NHS South Yorkshire ICB') === 'icb');
  check('NHS Property Services is national', healthBuyer('NHS Property Services Limited') === 'nhs_national');
  check('a Welsh health board', healthBuyer('Betsi Cadwaladr University Health Board') === 'health_board');
  check('a Northern Irish trust', healthBuyer('Belfast Health and Social Care Trust') === 'hsc_ni');
  check('a hospital without an NHS token', healthBuyer('The Royal Marsden') === null, 'no hospital word either');
  check('an infirmary counts', healthBuyer('Royal Infirmary of Edinburgh') === 'hospital');

  check('a council is not a health buyer', healthBuyer('Leeds City Council') === null);
  check('a university is not a health buyer', healthBuyer('University of Manchester') === null);
  check('empty is not a health buyer', healthBuyer('') === null);
  check('null is not a health buyer', healthBuyer(null) === null);
  /*
    HSE is deliberately unmatched: Health Service Executive in Ireland, Health and
    Safety Executive in Britain. Guessing between them would file GB safety
    paperwork as Irish healthcare.
  */
  check('HSE is left alone as ambiguous', healthBuyer('HSE') === null);
}

console.log('\nReal estates work is kept');
{
  wants('New Hospital Programme - Hospital 2.0 Alliance (H2A) Framework Call-Off Contract for Hillingdon Hospital Redevelopment', true);
  wants('ENHT - Ward 6B South Refurbishment Works', true);
  wants('Demolition of Staff Accommodations', true);
  wants('DBTH Asbestos Abatement', true);
  wants('Roof coverings replacement and electrical works', true);
  wants('Ventilation Installation Work', true);
  wants('Dental area upgrade and external windows and door replacement at St Johns Health Centre', true);
  wants('Door Access & Intercom, CCTV and Fire Alarm Installation', true);
  wants('CGH BMS Upgrade Project 2026/2027', true);
  wants('Substation 9 LV Panel & Generator Replacement and Evelina Standby Power', true);
  wants('Development Arrangements relating to the Ground Lease at Harrogate District Hospital', true);
  wants('UHL Retained Estate Rooftop Solar PV Panels', true);
}

console.log('\nAdvisory and maintenance spend is set aside, not treated as a build');
{
  /*
    All real health estates money, and all useful early-warning — a condition
    survey today is a refurbishment next year. None of it is construction work,
    so it stays out of a construction queue by default.
  */
  wants('Cirencester Hospital - Full Planning Application _Fees', false);
  wants('Asset Condition Survey', false);
  wants('Feasibility Study and Report of Heating Systems', false);
  wants('Test borehole design, surveys and specification', false);
  wants('CoBP Fire Safety Survey', false);
  wants('Modelling of the NHS Estates Utilisation', false);
  wants('PAHT - Utilities Detection Survey', false);
  wants('HCT - Backlog Maintenance Programme 2026/27', false);
  wants('Building Services and Sustainability Consultancy', false);

  /*
    The reorder that made this work. Each of these names a trade, so a trade-first
    rule order labelled them M&E, roofing and architecture — when what is being
    bought is the advice about that trade, not the trade.
  */
  wants('M&E Engineer Led Design Team for PSDS and HV/LV', false);
  wants('Consultancy Service For Flat Roof Replacement at Warminster Hospital', false);
  wants('LMER: X-Ray Rooms Design and Cost Consultancy', false);
  wants('Fracture Clinic AHU - Architectural services', false);

  // Still identified, so nothing is lost — only filtered.
  const survey = classifyHealthInfra(NHS_TRUST, 'Asset Condition Survey');
  check('the work kind survives the filter', survey.workKind === 'survey_design', String(survey.workKind));
  check('and the reason names it', /survey_design is not construction/.test(survey.reason), survey.reason);

  // And recoverable on request, for whoever wants early-warning leads.
  const opened = classifyHealthInfra(NHS_TRUST, 'Asset Condition Survey', { includeAdvisory: true });
  check('includeAdvisory brings surveys back', opened.isHealthInfra);
  check('and maintenance too', classifyHealthInfra(NHS_TRUST, 'HCT - Backlog Maintenance Programme', { includeAdvisory: true }).isHealthInfra);
  check(
    'but it does not weaken the real exclusions',
    !classifyHealthInfra(NHS_TRUST, 'Nursing Agency Provision', { includeAdvisory: true }).isHealthInfra
  );
}

console.log('\nWhat the first real ingest let through');
{
  /*
    These twenty-two landed in canonical_projects on 2026-08-09 and were reviewed
    by hand. Six were wrong, and they are pinned here because each was wrong for a
    different reason — this is the block that would catch a regression in any of
    the four fixes that followed.
  */

  // £45m of manned guarding, top of the queue by value. It described CCTV and
  // access control, which is what the fabric rule looks for.
  wants('Security Services (Trust-wide)', false);
  // Fuel for generators, not a generator.
  wants('Supply and Delivery of Red Diesel / Rebated Gas Oil For Standby Generators', false);
  // Servicing an installed system is not installing one.
  wants('Fire Alarm Maintenance', false);
  wants('CRITICAL VENTILATION SERVICING', false);
  // Advisory appointments that name the trade they advise on.
  wants('Consultancy services through RIBA Stages 4-7 for Hunter Street Refurbishment', false);
  wants('WSFT - Works - MECU Refurb QS services', false);

  // The plural bug behind two of the six: \b(...)\b cannot match an alternative
  // whose next character is a word character.
  check(
    'the singular and plural now agree',
    healthWork('Consultancy service for roof').kind === healthWork('Consultancy services for roof').kind,
    `${healthWork('Consultancy service for roof').kind} vs ${healthWork('Consultancy services for roof').kind}`
  );

  // And the sixteen that were right are still right — servicing exclusions must
  // not swallow replacement and installation work.
  wants('Wath Health Centre - Fire alarm replacement', true);
  wants('Door Access & Intercom, CCTV and Fire Alarm Installation', true);
  wants('Ventilation Installation Work', true);
  wants('WAS-ITT-62898 - Re-roofing at Carmarthen Ambulance Station', true);
  wants('Amble Health Centre – Boiler Plant Upgrades and BMS alterations', true);
  /*
    This one's title carries no estates word at all — it was its DESCRIPTION that
    said refurbishment, and the classifier reads both. Asserted the way the
    pipeline actually calls it rather than pretending the title were enough.
  */
  wants('Bedford Hospital - South Wing Endoscopy / EDU Department Project — refurbishment of the endoscopy suite', true);
  wants('Fluoroscopy Installation Enabling Works', true);
  wants('Hospital Refurbishment work and minor new Builds', true);
  wants('POW-ITT-63800 - Ty Cloc Windows and Flooring', true);
  wants('SP2026/27-16 - HBPOS & Seclusion Heating works', true);
  wants('EEAST – Welwyn Garden City Ambulance Roof (26-T12)', true);
}

console.log('\nThe traps a generic construction filter falls into');
{
  // Each of these matches /infrastructure|construction|engineer|upgrade/.
  wants('WSFT - IT - Microsoft Infrastructure Software Licensing', false);
  wants('WSFT - Capital Purchase - IT - Enterprise Network Infrastructure and Support', false);
  wants('Legal Services - Property & Construction', false);
  wants('Oracle Aconex Connected Cost Primavera 6 OPC Virtual Desktop', false);
  wants('Mechanical Chest Compression Device Upgrade', false);
  wants('Clinical Engineering Test Equipment', false);
  wants('Apprenticeships - Data Engineers & Data Analysts', false);
  wants('DBTH YHPSN & GovRoam - Roaming Wifi Service Subscription', false);
}

console.log('\nOrdinary NHS buying is not a construction lead');
{
  wants('Occupational Therapy Services', false);
  wants('Nursing Agency Provision', false);
  wants('NHS South Yorkshire ICB Rotherham - GP Local Enhanced Services 2026/27', false, 'NHS South Yorkshire ICB');
  wants('Hydraulic Lifting Table', false);
  wants('Ward Furniture', false);
  wants('Maintenance of Laboratory Sterilizer Autoclaves- Gloucestershire Royal Hospital', false);
  wants('Provision of Taxi Services for SWASFT', false);
  wants('U16 Cancer Patient Experience Survey 2027-2030', false);
  wants('Saw Blades', false);
  wants('Provision of Professional Interpreting and Translation Services', false);
  wants('Body Storage Contingency', false);
}

console.log('\nBoth tests must pass, not either');
{
  // Genuine construction, but the buyer builds roads, not hospitals.
  const road = classifyHealthInfra('Highways England', 'Major bridge refurbishment works');
  check('construction for a non-health buyer is out', !road.isHealthInfra, road.reason);
  check('and the reason says why', /not a health body/.test(road.reason), road.reason);

  // Health buyer, no building.
  const rota = classifyHealthInfra(NHS_TRUST, 'Nursing Agency Provision');
  check('a health buyer alone is not enough', !rota.isHealthInfra);
  check('and it is reported as excluded work', /not construction/.test(rota.reason), rota.reason);

  const vague = classifyHealthInfra(NHS_TRUST, 'Kinnaird House Proposed Work');
  check('a vague title is dropped rather than guessed', !vague.isHealthInfra, vague.reason);
  check('and says the signal was missing', /no estates signal/.test(vague.reason), vague.reason);
}

console.log('\nExclusions beat inclusions, always');
{
  // Contains "refurbishment" AND "software" — the exclusion has to win, or every
  // estates IT contract lands in the queue.
  check(
    'software licensing for a refurbishment project is still software',
    healthWork('Software licensing for the ward refurbishment programme').via === 'excluded'
  );
  check('a legal retainer for construction is still legal', healthWork('Legal Services - Property & Construction').via === 'excluded');
  check('an estates apprenticeship is still training', healthWork('Apprenticeship - Building Services Engineering').via === 'excluded');
}

console.log('\nThe work kind is usable as a building_type');
{
  const eq = (text, kind) =>
    check(`${kind.padEnd(17)} <- ${text.slice(0, 52)}`, classifyHealthInfra(NHS_TRUST, text).workKind === kind, `got ${classifyHealthInfra(NHS_TRUST, text).workKind}`);
  eq('Hillingdon Hospital Redevelopment', 'new_build');
  eq('Ward 6B South Refurbishment Works', 'refurbishment');
  eq('Demolition of Staff Accommodations', 'demolition');
  eq('Ventilation Installation Work', 'building_services');
  eq('Roof coverings replacement', 'fabric');
  // Set aside by default, but still labelled — see the advisory block above.
  eq('Asset Condition Survey', 'survey_design');
  eq('HCT - Backlog Maintenance Programme 2026/27', 'maintenance');
}

console.log('\nThe work labels cannot hijack the vertical');
{
  /*
    building_type is the first input to leadVertical(), which decides `vertical`,
    which is baked into the GENERATED ref_code column. leadVertical matches loose
    substrings, so a label is not just a caption — it is part of a record's id.

    The obvious label for the fabric category, "building fabric", contains "fab"
    and classified hospital cladding as a semiconductor plant. Every label is
    checked here so the next one added cannot bring that back.
  */
  for (const [kind, label] of Object.entries(WORK_LABEL)) {
    const v = leadVertical(label, null, 'tender');
    check(`${kind.padEnd(17)} stays procurement`, v === 'procurement', `"${label}" -> ${v}`);
  }
  check('and the old wording would indeed have broken it', leadVertical('Healthcare — building fabric', null, 'tender') === 'semiconductor');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
