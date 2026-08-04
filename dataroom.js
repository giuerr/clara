/**
 * CLARA — Data room operations
 *
 * Clara runs data rooms; she does not store them. Document storage, access
 * tokens and NDA capture belong to the platform VDR — this module owns the
 * operational layer on top: what a room for a given deal type should contain,
 * how complete it is, what is blocking a launch, and who should see which
 * folder.
 *
 * Everything here is pure: it takes a deal type and a list of documents that
 * exist, and returns a plan, an assessment and a work list. That keeps it
 * usable against any storage backend, and testable without one.
 */

'use strict';

/** Folder taxonomies by deal type. `critical` documents block a launch. */
const STRUCTURES = {
  fund_raise: [
    { folder: '01_Fund_Formation',   documents: [
      { name: 'Limited Partnership Agreement', critical: true },
      { name: 'Private Placement Memorandum',  critical: true },
      { name: 'Subscription Agreement',        critical: true },
      { name: 'Certificate of Formation',      critical: true },
      { name: 'Side Letter Precedents',        critical: false },
    ] },
    { folder: '02_Track_Record',     documents: [
      { name: 'Prior Fund Performance',        critical: true },
      { name: 'Realised Deal Case Studies',    critical: true },
      { name: 'Attribution Analysis',          critical: false },
    ] },
    { folder: '03_Team',             documents: [
      { name: 'Partner Biographies',           critical: true },
      { name: 'Organisational Chart',          critical: false },
      { name: 'Key Person Provisions',         critical: true },
    ] },
    { folder: '04_Legal_Regulatory', documents: [
      { name: 'Regulatory Registrations',      critical: true },
      { name: 'Compliance Manual',             critical: false },
      { name: 'Litigation Disclosure',         critical: true },
    ] },
    { folder: '05_Operations',       documents: [
      { name: 'Service Provider List',         critical: true },
      { name: 'Valuation Policy',              critical: true },
      { name: 'Audited Financials',            critical: true },
    ] },
    { folder: '06_ESG',              documents: [
      { name: 'ESG Policy',                    critical: false },
      { name: 'SFDR Disclosures',              critical: false },
    ] },
  ],

  ma_sell_side: [
    { folder: '01_Corporate',        documents: [
      { name: 'Articles of Association',       critical: true },
      { name: 'Shareholder Register',          critical: true },
      { name: 'Cap Table',                     critical: true },
      { name: 'Board Minutes',                 critical: false },
    ] },
    { folder: '02_Financial',        documents: [
      { name: 'Audited Financials (3yr)',      critical: true },
      { name: 'Management Accounts',           critical: true },
      { name: 'Financial Model',               critical: true },
      { name: 'Quality of Earnings',           critical: false },
    ] },
    { folder: '03_Commercial',       documents: [
      { name: 'Customer Contracts',            critical: true },
      { name: 'Revenue by Customer',           critical: true },
      { name: 'Pipeline Analysis',             critical: false },
    ] },
    { folder: '04_Legal',            documents: [
      { name: 'Material Contracts',            critical: true },
      { name: 'IP Register',                   critical: true },
      { name: 'Litigation Summary',            critical: true },
      { name: 'Insurance Policies',            critical: false },
    ] },
    { folder: '05_People',           documents: [
      { name: 'Employee Census',               critical: true },
      { name: 'Employment Contracts',          critical: true },
      { name: 'Pension Arrangements',          critical: false },
    ] },
    { folder: '06_Tax',              documents: [
      { name: 'Tax Returns (3yr)',             critical: true },
      { name: 'Transfer Pricing Documentation', critical: false },
    ] },
  ],

  portfolio_reporting: [
    { folder: '01_Quarterly',        documents: [
      { name: 'Quarterly Report',              critical: true },
      { name: 'Capital Account Statement',     critical: true },
      { name: 'Portfolio Valuations',          critical: true },
    ] },
    { folder: '02_Annual',           documents: [
      { name: 'Audited Financials',            critical: true },
      { name: 'K-1 / Tax Statements',          critical: true },
    ] },
    { folder: '03_Capital_Activity',  documents: [
      { name: 'Capital Call Notices',          critical: false },
      { name: 'Distribution Notices',          critical: false },
    ] },
  ],
};

/**
 * Folder visibility by counterparty role. A role sees a folder if its prefix
 * appears here; anything unlisted is hidden by default.
 */
const ACCESS_TIERS = {
  // Pre-NDA: enough to assess interest, nothing confidential.
  prospect:   ['01_', '03_Team'],
  // Post-NDA: the working set.
  nda_signed: ['01_', '02_', '03_', '06_'],
  // In diligence: everything except the seller's own privileged material.
  diligence:  ['01_', '02_', '03_', '04_', '05_', '06_'],
  // Internal: unrestricted.
  internal:   ['*'],
};

const DEAL_TYPES = Object.keys(STRUCTURES);
const ROLES = Object.keys(ACCESS_TIERS);

/**
 * The folder and document plan for a deal type.
 *
 * @param {object} opts
 * @param {string} opts.dealType — one of DEAL_TYPES
 * @returns {{ dealType, folders, totalDocuments, criticalDocuments }}
 */
function buildRoomPlan({ dealType } = {}) {
  const structure = STRUCTURES[dealType];
  if (!structure) {
    throw new Error(`Unknown dealType "${dealType}". Expected one of: ${DEAL_TYPES.join(', ')}.`);
  }

  const folders = structure.map(f => ({
    folder: f.folder,
    documents: f.documents.map(d => ({ ...d })),
  }));

  return {
    dealType,
    folders,
    totalDocuments:    folders.reduce((n, f) => n + f.documents.length, 0),
    criticalDocuments: folders.reduce((n, f) => n + f.documents.filter(d => d.critical).length, 0),
  };
}

/**
 * Abbreviations deal teams actually name files with. Without these, a room
 * containing "PPM_2026.pdf" reports its private placement memorandum missing.
 */
const ALIASES = {
  'limited partnership agreement': ['lpa'],
  'private placement memorandum':  ['ppm'],
  'subscription agreement':        ['sub doc', 'subdoc', 'sub agreement'],
  'quality of earnings':           ['qoe'],
  'articles of association':       ['aoa', 'articles'],
  'certificate of formation':      ['cert of formation', 'coi', 'certificate of incorporation'],
  'organisational chart':          ['org chart', 'organizational chart'],
  'k 1 tax statements':            ['k1', 'k-1', 'schedule k-1'],
  'esg policy':                    ['esg'],
  'sfdr disclosures':              ['sfdr'],
  'employee census':               ['headcount', 'census'],
  'ip register':                   ['intellectual property register', 'ip schedule'],
  'transfer pricing documentation': ['transfer pricing'],
  'capital account statement':     ['capital account'],
  'cap table':                     ['capitalisation table', 'capitalization table'],
};

/** Loose match so "LPA — final v3.pdf" satisfies "Limited Partnership Agreement". */
function documentPresent(required, present) {
  const norm = str => String(str).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const target = norm(required);
  const targetWords = target.split(' ').filter(w => w.length > 3);
  const aliases = (ALIASES[target] || []).map(norm);

  return present.some((candidate) => {
    const c = norm(candidate);
    if (c.includes(target) || target.includes(c)) return true;

    // An abbreviation counts, but only as a whole word — 'coi' must not match
    // inside 'coinvestment'.
    if (aliases.some(a => new RegExp(`(^| )${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(c))) {
      return true;
    }

    // Otherwise require most of the distinctive words to appear.
    if (!targetWords.length) return false;
    const hits = targetWords.filter(w => c.includes(w)).length;
    return hits / targetWords.length >= 0.75;
  });
}

/**
 * Compare a plan against the documents actually uploaded.
 *
 * @param {object} plan — from buildRoomPlan
 * @param {string[]} presentDocuments — document names currently in the room
 * @returns {{ completeness, criticalCompleteness, launchReady, missing, missingCritical, byFolder }}
 */
function assessReadiness(plan, presentDocuments = []) {
  if (!plan || !Array.isArray(plan.folders)) throw new Error('A room plan is required.');
  const present = presentDocuments.map(String);

  const missing = [];
  const missingCritical = [];
  const byFolder = [];

  for (const folder of plan.folders) {
    const folderMissing = [];
    for (const doc of folder.documents) {
      if (!documentPresent(doc.name, present)) {
        const entry = { folder: folder.folder, document: doc.name, critical: doc.critical };
        missing.push(entry);
        if (doc.critical) missingCritical.push(entry);
        folderMissing.push(doc.name);
      }
    }
    byFolder.push({
      folder: folder.folder,
      required: folder.documents.length,
      present: folder.documents.length - folderMissing.length,
      missing: folderMissing,
      complete: folderMissing.length === 0,
    });
  }

  const found = plan.totalDocuments - missing.length;
  const criticalFound = plan.criticalDocuments - missingCritical.length;

  return {
    completeness: pct(found, plan.totalDocuments),
    criticalCompleteness: pct(criticalFound, plan.criticalDocuments),
    // A room opens on critical coverage, not total coverage — nice-to-haves
    // can land after counterparties are already reading.
    launchReady: missingCritical.length === 0,
    missing,
    missingCritical,
    byFolder,
  };
}

/**
 * The operational work list, most blocking first.
 *
 * @param {object} assessment — from assessReadiness
 * @returns {Array<{priority, action, folder, document}>}
 */
function nextActions(assessment) {
  if (!assessment) throw new Error('An assessment is required.');

  const actions = assessment.missingCritical.map(m => ({
    priority: 'blocking',
    action: `Obtain "${m.document}" — the room cannot open without it.`,
    folder: m.folder,
    document: m.document,
  }));

  for (const m of assessment.missing) {
    if (m.critical) continue;
    actions.push({
      priority: 'standard',
      action: `Request "${m.document}" to complete ${m.folder}.`,
      folder: m.folder,
      document: m.document,
    });
  }

  if (!actions.length) {
    actions.push({
      priority: 'ready',
      action: 'All documents present — open the room and issue invitations.',
      folder: null,
      document: null,
    });
  }
  return actions;
}

/**
 * Which folders a counterparty role may see.
 *
 * @param {object} plan
 * @param {string} role — one of ROLES
 */
function accessMatrix(plan, role) {
  const tiers = ACCESS_TIERS[role];
  if (!tiers) throw new Error(`Unknown role "${role}". Expected one of: ${ROLES.join(', ')}.`);

  const visible = plan.folders
    .map(f => f.folder)
    .filter(name => tiers.includes('*') || tiers.some(prefix => name.startsWith(prefix)));

  return {
    role,
    visibleFolders: visible,
    hiddenFolders: plan.folders.map(f => f.folder).filter(n => !visible.includes(n)),
    ndaRequired: role !== 'prospect' && role !== 'internal',
  };
}

function pct(n, total) {
  if (!total) return 100;
  return Math.round((n / total) * 100);
}

module.exports = {
  STRUCTURES,
  ALIASES,
  ACCESS_TIERS,
  DEAL_TYPES,
  ROLES,
  buildRoomPlan,
  assessReadiness,
  nextActions,
  accessMatrix,
  documentPresent,
};
