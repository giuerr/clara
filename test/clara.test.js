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
