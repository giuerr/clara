// VENDORED — do not edit here.
// Source of truth: packages/institutional-core in the tabularum monorepo.
// Refresh with: scripts/sync-institutional-core.sh
'use strict';

/**
 * INSTITUTIONAL-CORE — Shared infrastructure for Antoninus agent stack
 *
 * Provides institutional-grade capabilities required by regulators,
 * institutional LPs, and compliance frameworks:
 *
 *   1. Confidence Scoring    — quantified uncertainty on every AI output
 *   2. Citation Tracker       — source attribution chain for every claim
 *   3. Persistent Audit Trail — append-only, tamper-evident decision log
 *   4. Human Approval Gate    — configurable checkpoints for critical actions
 *   5. Output Versioning      — immutable snapshots of every generated artifact
 *   6. Scope Guard            — enforces domain boundaries, rejects out-of-scope
 *   7. Data Isolation         — per-tenant / per-fund partitioning
 *
 * All modules are stateless where possible; state lives in the persistent
 * audit store (file-based JSON with optional SQLite adapter).
 */

const { ConfidenceScorer } = require('./confidence');
const { CitationTracker }  = require('./citations');
const { AuditTrail }       = require('./audit');
const { ApprovalGate }     = require('./approval');
const { OutputVersioning } = require('./versioning');
const { ScopeGuard }       = require('./scope-guard');
const { DataIsolation }    = require('./data-isolation');

/**
 * Factory: creates a full institutional-core instance for an agent.
 *
 * @param {object} opts
 * @param {string} opts.agentId       — e.g. 'gaio', 'mila', 'clara', 'lucio', 'livia'
 * @param {string} opts.agentVersion  — semver string
 * @param {string} opts.dataDir       — root directory for persistent state
 * @param {string[]} opts.scopeTopics — allowed domain topics (e.g. ['legal','fund-formation'])
 * @param {object}  [opts.approvalRules] — action→threshold map for human approval
 * @param {string}  [opts.tenantId]   — current tenant / fund ID
 */
function createInstitutionalCore(opts) {
  const {
    agentId,
    agentVersion,
    dataDir,
    scopeTopics = [],
    approvalRules = {},
    tenantId = 'default',
  } = opts;

  const isolation = new DataIsolation({ dataDir, tenantId });
  const baseDir   = isolation.tenantDir();

  const audit      = new AuditTrail({ agentId, agentVersion, dataDir: baseDir });
  const confidence  = new ConfidenceScorer({ agentId, audit });
  const citations   = new CitationTracker({ agentId, audit });
  const approval    = new ApprovalGate({ agentId, rules: approvalRules, audit });
  const versioning  = new OutputVersioning({ agentId, dataDir: baseDir, audit });
  const scopeGuard  = new ScopeGuard({ agentId, allowedTopics: scopeTopics, audit });

  return {
    confidence,
    citations,
    audit,
    approval,
    versioning,
    scopeGuard,
    isolation,

    /**
     * Wrap a full AI response with institutional metadata.
     * Call this as the LAST step before returning any AI output.
     */
    wrapResponse(raw, meta = {}) {
      const scored   = confidence.score(raw, meta);
      const cited    = citations.attach(raw, meta.sources || []);
      const record   = audit.log({
        action:   meta.action || 'response',
        module:   meta.module || agentId,
        input:    meta.inputSummary || '',
        output:   _truncate(typeof raw === 'string' ? raw : JSON.stringify(raw), 500),
        confidence: scored.confidence,
        citationCount: cited.citations.length,
        userId:   meta.userId,
        tenantId,
        durationMs: meta.durationMs,
        model:    meta.model,
      });

      return {
        ...scored,
        citations: cited.citations,
        audit: {
          id:        record.id,
          timestamp: record.timestamp,
          agent:     agentId,
          version:   agentVersion,
        },
        _meta: {
          institutionalCore: '1.0.0',
          dataIsolation:     tenantId,
        },
      };
    },
  };
}

function _truncate(s, max) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

module.exports = {
  createInstitutionalCore,
  ConfidenceScorer,
  CitationTracker,
  AuditTrail,
  ApprovalGate,
  OutputVersioning,
  ScopeGuard,
  DataIsolation,
};
