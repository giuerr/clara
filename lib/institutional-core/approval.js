// VENDORED — do not edit here.
// Source of truth: packages/institutional-core in the tabularum monorepo.
// Refresh with: scripts/sync-institutional-core.sh
'use strict';

/**
 * HUMAN APPROVAL GATE
 *
 * Configurable checkpoints requiring human approval before critical actions.
 * Actions are classified by risk tier, and each tier can require:
 *   - AUTO:    proceed without human input
 *   - NOTIFY:  proceed but alert the human
 *   - REVIEW:  queue for human review, proceed only after approval
 *   - BLOCK:   refuse to proceed, require explicit human override
 *
 * The gate integrates with the audit trail to record every approval decision.
 */

const APPROVAL_TIERS = {
  AUTO:   'auto',      // no human needed
  NOTIFY: 'notify',    // proceed + alert
  REVIEW: 'review',    // queue, wait for approval
  BLOCK:  'block',     // refuse until explicit override
};

/**
 * Default rules by action category.
 * Agents override these with their own domain-specific rules.
 */
const DEFAULT_RULES = {
  // Financial
  'wire_transfer':        APPROVAL_TIERS.REVIEW,
  'capital_call':         APPROVAL_TIERS.REVIEW,
  'distribution':         APPROVAL_TIERS.REVIEW,
  'fee_calculation':      APPROVAL_TIERS.NOTIFY,

  // Legal
  'document_draft':       APPROVAL_TIERS.AUTO,
  'document_execution':   APPROVAL_TIERS.BLOCK,
  'legal_advice':         APPROVAL_TIERS.AUTO,
  'regulatory_filing':    APPROVAL_TIERS.REVIEW,

  // Communications
  'email_to_lp':          APPROVAL_TIERS.REVIEW,
  'email_to_counterparty': APPROVAL_TIERS.REVIEW,
  'email_internal':       APPROVAL_TIERS.AUTO,
  'email_to_owner':       APPROVAL_TIERS.AUTO,

  // Data
  'data_export':          APPROVAL_TIERS.NOTIFY,
  'data_deletion':        APPROVAL_TIERS.BLOCK,
  'profile_update':       APPROVAL_TIERS.AUTO,

  // Investment
  'investment_decision':  APPROVAL_TIERS.REVIEW,
  'valuation_update':     APPROVAL_TIERS.NOTIFY,
  'deal_stage_change':    APPROVAL_TIERS.AUTO,
};

class ApprovalGate {
  constructor({ agentId, rules = {}, audit }) {
    this.agentId = agentId;
    this.audit   = audit;
    this.rules   = { ...DEFAULT_RULES, ...rules };
    this._pending = new Map(); // id → { action, metadata, createdAt, status }
    this._expiryTimers = new Map(); // id → auto-expiry timer handle
  }

  /**
   * Check whether an action requires approval.
   *
   * @param {string} action — the action key (e.g. 'wire_transfer')
   * @param {object} [context] — additional context (amount, recipient, etc.)
   * @returns {{ tier, approved, pendingId?, message }}
   */
  check(action, context = {}) {
    const tier = this.rules[action] || APPROVAL_TIERS.NOTIFY;

    // Amount-based escalation: amounts over thresholds escalate tier
    const escalatedTier = this._applyAmountEscalation(tier, context);

    // Confidence-based escalation: low confidence forces review
    const finalTier = this._applyConfidenceEscalation(escalatedTier, context);

    switch (finalTier) {
      case APPROVAL_TIERS.AUTO:
        this._auditApproval(action, 'auto_approved', context);
        return { tier: finalTier, approved: true, message: 'Auto-approved' };

      case APPROVAL_TIERS.NOTIFY:
        this._auditApproval(action, 'auto_approved_with_notification', context);
        return { tier: finalTier, approved: true, message: 'Approved — notification sent to principal' };

      case APPROVAL_TIERS.REVIEW: {
        const pendingId = this._createPending(action, context);
        this._auditApproval(action, 'pending_human_review', context, pendingId);
        return { tier: finalTier, approved: false, pendingId, message: 'Queued for human review' };
      }

      case APPROVAL_TIERS.BLOCK:
        this._auditApproval(action, 'blocked', context);
        return { tier: finalTier, approved: false, message: 'BLOCKED — requires explicit human override' };

      default:
        return { tier: APPROVAL_TIERS.BLOCK, approved: false, message: 'Unknown tier — defaulting to BLOCK' };
    }
  }

  /**
   * Approve a pending action (called by human/owner).
   */
  approve(pendingId, approvedBy, notes = '') {
    const pending = this._pending.get(pendingId);
    if (!pending) return { success: false, message: 'Pending action not found' };
    if (pending.status !== 'pending') return { success: false, message: `Action already ${pending.status}` };

    pending.status     = 'approved';
    pending.approvedBy = approvedBy;
    pending.approvedAt = new Date().toISOString();
    pending.notes      = notes;
    this._clearExpiry(pendingId);

    this._auditApproval(pending.action, 'human_approved', { ...pending.metadata, approvedBy, notes }, pendingId);
    return { success: true, message: 'Action approved' };
  }

  /**
   * Reject a pending action.
   */
  reject(pendingId, rejectedBy, reason = '') {
    const pending = this._pending.get(pendingId);
    if (!pending) return { success: false, message: 'Pending action not found' };

    pending.status     = 'rejected';
    pending.rejectedBy = rejectedBy;
    pending.rejectedAt = new Date().toISOString();
    pending.reason     = reason;
    this._clearExpiry(pendingId);

    this._auditApproval(pending.action, 'human_rejected', { ...pending.metadata, rejectedBy, reason }, pendingId);
    return { success: true, message: 'Action rejected' };
  }

  /**
   * Get all pending approvals.
   */
  getPending() {
    return Array.from(this._pending.entries())
      .filter(([, v]) => v.status === 'pending')
      .map(([id, v]) => ({ id, ...v }));
  }

  /**
   * Check if a specific pending action has been approved.
   */
  isApproved(pendingId) {
    const p = this._pending.get(pendingId);
    return p?.status === 'approved';
  }

  // --- Internal ---

  _applyAmountEscalation(tier, context) {
    const amount = context.amount || context.value || 0;
    if (amount >= 10_000_000 && tier !== APPROVAL_TIERS.BLOCK) return APPROVAL_TIERS.BLOCK;
    if (amount >= 1_000_000 && tier === APPROVAL_TIERS.AUTO) return APPROVAL_TIERS.REVIEW;
    if (amount >= 100_000 && tier === APPROVAL_TIERS.AUTO) return APPROVAL_TIERS.NOTIFY;
    return tier;
  }

  _applyConfidenceEscalation(tier, context) {
    const confidence = context.confidenceScore;
    if (typeof confidence !== 'number') return tier;
    if (confidence < 0.3 && tier !== APPROVAL_TIERS.BLOCK) return APPROVAL_TIERS.BLOCK;
    if (confidence < 0.6 && tier === APPROVAL_TIERS.AUTO) return APPROVAL_TIERS.REVIEW;
    return tier;
  }

  _createPending(action, context) {
    const id = `APR-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this._pending.set(id, {
      action,
      metadata:  context,
      createdAt: new Date().toISOString(),
      status:    'pending',
    });

    // Auto-expire pending approvals after 72 hours.
    //
    // unref() so a queued approval cannot hold the event loop open: an
    // unreferenced 72-hour timer would otherwise keep any process that
    // requested an approval alive for three days, unable to exit. The handle
    // is kept so approve()/reject() can clear it once the approval resolves.
    const timer = setTimeout(() => {
      const p = this._pending.get(id);
      if (p && p.status === 'pending') {
        p.status    = 'expired';
        p.expiredAt = new Date().toISOString();
      }
      this._expiryTimers.delete(id);
    }, 72 * 60 * 60 * 1000);
    if (timer.unref) timer.unref();
    this._expiryTimers.set(id, timer);

    return id;
  }

  /** Cancel the auto-expiry timer for a resolved approval. */
  _clearExpiry(pendingId) {
    const timer = this._expiryTimers.get(pendingId);
    if (timer) {
      clearTimeout(timer);
      this._expiryTimers.delete(pendingId);
    }
  }

  /**
   * Release all pending auto-expiry timers. Not required for process exit —
   * the timers are unref'd — but lets a long-lived host drop them eagerly.
   */
  shutdown() {
    for (const timer of this._expiryTimers.values()) clearTimeout(timer);
    this._expiryTimers.clear();
  }

  _auditApproval(action, decision, context, pendingId) {
    if (!this.audit) return;
    this.audit.log({
      action:   'approval_gate',
      module:   'approval',
      input:    action,
      output:   decision,
      metadata: { pendingId, ...context },
    });
  }
}

module.exports = { ApprovalGate, APPROVAL_TIERS, DEFAULT_RULES };
