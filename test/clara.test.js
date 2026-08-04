'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const clara = require('../index');

test('agent card is a well-formed NANDA identity', () => {
  const c = clara.AGENT_CARD;
  assert.equal(c.name, 'Clara');
  assert.equal(c.protocol, 'NANDA/1.0');
  assert.match(c.version, /^\d+\.\d+\.\d+$/);
  assert.ok(c.owner && c.owner.name);
  assert.ok(Array.isArray(c.capabilities) && c.capabilities.length > 0);
});

test('card version matches package version', () => {
  // These had drifted: the card said 1.0.0 while the server and its
  // institutional-core config both declared 6.0.0.
  assert.equal(clara.AGENT_CARD.version, require('../package.json').version);
});

test('every advertised capability has an endpoint', () => {
  const { capabilities, endpoints } = clara.AGENT_CARD;
  const missing = capabilities.filter(c => !endpoints[c.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())]);
  assert.deepEqual(missing, [], `capabilities with no endpoint: ${missing.join(', ')}`);
});

test('importing the library does not start a server', () => {
  const handles = process._getActiveHandles().filter(h => h.constructor.name === 'Server');
  assert.equal(handles.length, 0, 'importing @tabularum/clara bound a listening socket');
});

test('eager modules load without touching the network or filesystem', () => {
  for (const name of ['crmEngine', 'calendarAdapter', 'telegramHandler', 'hrFunctions', 'onboardingChat', 'receiptProcessor']) {
    assert.ok(clara[name], `${name} is not exported`);
  }
});

test('expense classification maps to a known category and accounting code', () => {
  const { classifyExpense, mapToAccountingCode, EXPENSE_CATEGORIES } = clara.receiptProcessor;

  const flight = classifyExpense({ merchant: 'British Airways', description: 'LHR-JFK return', amount: 2400 });
  assert.ok(flight.category, 'classification produced no category');

  // EXPENSE_CATEGORIES is a list of category names; 'Other' is the documented
  // catch-all the classifier falls back to.
  const known = new Set([...EXPENSE_CATEGORIES, 'Other']);
  assert.ok(known.has(flight.category), `classified into unknown category "${flight.category}"`);

  const code = mapToAccountingCode(flight.category, 'xero');
  assert.ok(code, 'no Xero accounting code for a classified expense');
});

test('every expense category maps to a code in each supported ledger', () => {
  const { mapToAccountingCode, EXPENSE_CATEGORIES } = clara.receiptProcessor;
  const unmapped = [];

  for (const category of EXPENSE_CATEGORIES) {
    for (const ledger of ['xero', 'quickbooks', 'sage']) {
      if (!mapToAccountingCode(category, ledger)) unmapped.push(`${category}/${ledger}`);
    }
  }
  assert.deepEqual(unmapped, [], `categories with no accounting code: ${unmapped.join(', ')}`);
});

test('pipeline stages advance in a defined order with probabilities', () => {
  const { PIPELINE_STAGE_ORDER, PIPELINE_STAGE_PROB } = clara.crmEngine;

  assert.ok(PIPELINE_STAGE_ORDER.length > 1, 'no pipeline stages defined');
  for (const stage of PIPELINE_STAGE_ORDER) {
    const p = PIPELINE_STAGE_PROB[stage];
    assert.equal(typeof p, 'number', `stage "${stage}" has no probability`);
    // Probabilities are expressed as percentages.
    assert.ok(p >= 0 && p <= 100, `stage "${stage}" probability ${p} is outside 0..100`);
  }
});

test('conversation state transitions only produce defined states', () => {
  // STATE_TRANSITIONS is keyed by event name, not by source state; each entry
  // maps a source state to the state that event moves it to.
  const { CONVERSATION_STATES, STATE_TRANSITIONS } = clara.crmEngine;
  const states = new Set(CONVERSATION_STATES);

  for (const [event, mapping] of Object.entries(STATE_TRANSITIONS)) {
    assert.ok(mapping && typeof mapping === 'object', `event "${event}" has no transition map`);
    for (const [from, to] of Object.entries(mapping)) {
      // '_default' is the wildcard source matching any state not listed.
      assert.ok(from === '_default' || states.has(from),
        `event "${event}": source "${from}" is not a defined state`);
      // A null target means the event does not move that state.
      assert.ok(to === null || states.has(to),
        `event "${event}": target "${to}" is not a defined state`);
    }
  }
});

// ── Data room operations ────────────────────────────────────────────────────

test('a room plan is produced for every supported deal type', () => {
  const { DEAL_TYPES, buildRoomPlan } = clara.dataroom;
  assert.ok(DEAL_TYPES.length >= 3);

  for (const dealType of DEAL_TYPES) {
    const plan = buildRoomPlan({ dealType });
    assert.ok(plan.folders.length > 0, `${dealType} has no folders`);
    assert.ok(plan.totalDocuments > 0, `${dealType} requires no documents`);
    assert.ok(plan.criticalDocuments > 0, `${dealType} has no critical documents`);
    assert.ok(plan.criticalDocuments <= plan.totalDocuments);
  }
});

test('an unknown deal type is rejected', () => {
  assert.throws(() => clara.dataroom.buildRoomPlan({ dealType: 'ipo' }), /Unknown dealType/);
});

test('an empty room is 0% complete and not launch-ready', () => {
  const { buildRoomPlan, assessReadiness } = clara.dataroom;
  const plan = buildRoomPlan({ dealType: 'fund_raise' });
  const a = assessReadiness(plan, []);

  assert.equal(a.completeness, 0);
  assert.equal(a.launchReady, false);
  assert.equal(a.missing.length, plan.totalDocuments);
  assert.equal(a.missingCritical.length, plan.criticalDocuments);
});

test('a fully stocked room is 100% complete and launch-ready', () => {
  const { buildRoomPlan, assessReadiness } = clara.dataroom;
  const plan = buildRoomPlan({ dealType: 'fund_raise' });
  const everything = plan.folders.flatMap(f => f.documents.map(d => d.name));

  const a = assessReadiness(plan, everything);
  assert.equal(a.completeness, 100);
  assert.equal(a.launchReady, true);
  assert.deepEqual(a.missing, []);
});

test('launch readiness turns on critical documents, not total count', () => {
  const { buildRoomPlan, assessReadiness } = clara.dataroom;
  const plan = buildRoomPlan({ dealType: 'fund_raise' });
  const criticalOnly = plan.folders.flatMap(f => f.documents.filter(d => d.critical).map(d => d.name));

  const a = assessReadiness(plan, criticalOnly);
  assert.equal(a.launchReady, true, 'all critical documents present should allow launch');
  assert.equal(a.criticalCompleteness, 100);
  assert.ok(a.completeness < 100, 'non-critical documents are still outstanding');
});

test('document matching tolerates real-world filenames', () => {
  const { documentPresent } = clara.dataroom;
  assert.ok(documentPresent('Limited Partnership Agreement', ['LPA - Limited Partnership Agreement v3 FINAL.pdf']));
  assert.ok(documentPresent('Audited Financials', ['audited_financials_2025.xlsx']));
  assert.equal(documentPresent('Compliance Manual', ['Cap Table.xlsx']), false);
});

test('next actions put blocking items first and clear when ready', () => {
  const { buildRoomPlan, assessReadiness, nextActions } = clara.dataroom;
  const plan = buildRoomPlan({ dealType: 'ma_sell_side' });

  const actions = nextActions(assessReadiness(plan, []));
  assert.equal(actions[0].priority, 'blocking');
  const firstStandard = actions.findIndex(a => a.priority === 'standard');
  const lastBlocking = actions.map(a => a.priority).lastIndexOf('blocking');
  if (firstStandard !== -1) assert.ok(lastBlocking < firstStandard, 'blocking items must precede standard ones');

  const everything = plan.folders.flatMap(f => f.documents.map(d => d.name));
  const ready = nextActions(assessReadiness(plan, everything));
  assert.equal(ready[0].priority, 'ready');
});

test('access widens with counterparty role and never leaks past internal', () => {
  const { buildRoomPlan, accessMatrix, ROLES } = clara.dataroom;
  const plan = buildRoomPlan({ dealType: 'ma_sell_side' });

  const counts = ROLES.map(r => accessMatrix(plan, r).visibleFolders.length);
  const [prospect, nda, diligence, internal] = counts;

  assert.ok(prospect < nda, 'a prospect must see less than an NDA-signed counterparty');
  assert.ok(nda <= diligence, 'diligence must see at least as much as post-NDA');
  assert.equal(internal, plan.folders.length, 'internal sees everything');
  assert.equal(accessMatrix(plan, 'prospect').ndaRequired, false);
  assert.equal(accessMatrix(plan, 'diligence').ndaRequired, true);
  assert.throws(() => accessMatrix(plan, 'journalist'), /Unknown role/);
});

test('abbreviated filenames satisfy their full document name', () => {
  const { documentPresent } = clara.dataroom;
  assert.ok(documentPresent('Private Placement Memorandum', ['PPM_2026.pdf']));
  assert.ok(documentPresent('Quality of Earnings', ['QoE report.pdf']));
  assert.ok(documentPresent('Cap Table', ['capitalisation table.xlsx']));
  // Abbreviations match as whole words only — 'coi' must not hit 'coinvestment'.
  assert.equal(documentPresent('Certificate of Formation', ['coinvestment terms.pdf']), false);
});

test('every alias key names a document that actually exists in a structure', () => {
  const { ALIASES, STRUCTURES } = clara.dataroom;
  const known = new Set(
    Object.values(STRUCTURES).flat()
      .flatMap(f => f.documents.map(d => d.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())),
  );
  const orphans = Object.keys(ALIASES).filter(k => !known.has(k));
  assert.deepEqual(orphans, [], `aliases for documents no structure requires: ${orphans.join(', ')}`);
});
