// VENDORED — do not edit here.
// Source of truth: packages/institutional-core in the tabularum monorepo.
// Refresh with: scripts/sync-institutional-core.sh
'use strict';

/**
 * SCOPE GUARD
 *
 * Enforces that each agent operates ONLY within its domain.
 * Institutions trust narrow, validated agents — not general-purpose chatbots.
 *
 * Each agent declares its allowed topics. The scope guard:
 *   1. Classifies incoming requests by topic
 *   2. Rejects out-of-scope requests with clear explanation
 *   3. Routes cross-domain requests to the appropriate agent
 *   4. Logs all scope violations for compliance review
 */

/**
 * Topic taxonomy for the Antoninus agent stack.
 * Each agent claims a subset of these.
 */
const TOPIC_TAXONOMY = {
  // Gaio — Legal
  'legal-advice':        { domain: 'legal', agent: 'gaio' },
  'fund-formation':      { domain: 'legal', agent: 'gaio' },
  'document-drafting':   { domain: 'legal', agent: 'gaio' },
  'document-review':     { domain: 'legal', agent: 'gaio' },
  'regulatory-compliance': { domain: 'legal', agent: 'gaio' },
  'negotiation':         { domain: 'legal', agent: 'gaio' },
  'contract-law':        { domain: 'legal', agent: 'gaio' },
  'corporate-governance': { domain: 'legal', agent: 'gaio' },

  // Mila — Finance
  'fund-accounting':     { domain: 'finance', agent: 'mila' },
  'capital-calls':       { domain: 'finance', agent: 'mila' },
  'distributions':       { domain: 'finance', agent: 'mila' },
  'nav-calculation':     { domain: 'finance', agent: 'mila' },
  'waterfall':           { domain: 'finance', agent: 'mila' },
  'financial-reporting': { domain: 'finance', agent: 'mila' },
  'tax':                 { domain: 'finance', agent: 'mila' },
  'treasury':            { domain: 'finance', agent: 'mila' },
  'valuation':           { domain: 'finance', agent: 'mila' },
  'lp-portal':           { domain: 'finance', agent: 'mila' },

  // Lucio — Investment
  'deal-sourcing':       { domain: 'investment', agent: 'lucio' },
  'due-diligence':       { domain: 'investment', agent: 'lucio' },
  'ic-memo':             { domain: 'investment', agent: 'lucio' },
  'portfolio-monitoring': { domain: 'investment', agent: 'lucio' },
  'exit-strategy':       { domain: 'investment', agent: 'lucio' },
  'market-analysis':     { domain: 'investment', agent: 'lucio' },
  'risk-modeling':       { domain: 'investment', agent: 'lucio' },
  'financial-modeling':  { domain: 'investment', agent: 'lucio' },

  // Clara — Operations
  'data-room':           { domain: 'operations', agent: 'clara' },
  'lp-onboarding':       { domain: 'operations', agent: 'clara' },
  'compliance-calendar': { domain: 'operations', agent: 'clara' },
  'scheduling':          { domain: 'operations', agent: 'clara' },
  'email-management':    { domain: 'operations', agent: 'clara' },
  'crm':                 { domain: 'operations', agent: 'clara' },
  'outreach':            { domain: 'operations', agent: 'clara' },

  // Livia — Executive Assistant (Errante Holding)
  'executive-scheduling': { domain: 'executive', agent: 'livia' },
  'executive-comms':      { domain: 'executive', agent: 'livia' },
  'travel-booking':       { domain: 'executive', agent: 'livia' },
  'expense-tracking':     { domain: 'executive', agent: 'livia' },
};

/**
 * Keyword → topic mapping for fast classification.
 */
const KEYWORD_MAP = {
  // Legal
  'lpa': 'legal-advice', 'ppm': 'document-review', 'side letter': 'legal-advice',
  'subscription agreement': 'document-drafting', 'nda': 'document-drafting',
  'aifmd': 'regulatory-compliance', 'fatca': 'regulatory-compliance',
  'negotiate': 'negotiation', 'clause': 'negotiation', 'redline': 'document-review',
  'draft': 'document-drafting', 'review': 'document-review',

  // Finance
  'capital call': 'capital-calls', 'distribution': 'distributions',
  'nav': 'nav-calculation', 'waterfall': 'waterfall', 'carry': 'waterfall',
  'management fee': 'fund-accounting', 'k-1': 'tax', 'tax': 'tax',
  'wire': 'capital-calls', 'financial statement': 'financial-reporting',
  'quarterly report': 'financial-reporting', 'valuation': 'valuation',

  // Investment
  'deal': 'deal-sourcing', 'pipeline': 'deal-sourcing', 'due diligence': 'due-diligence',
  'ic memo': 'ic-memo', 'dcf': 'financial-modeling', 'lbo': 'financial-modeling',
  'monte carlo': 'risk-modeling', 'exit': 'exit-strategy', 'portfolio': 'portfolio-monitoring',

  // Operations
  'data room': 'data-room', 'onboarding': 'lp-onboarding',
  'calendar': 'scheduling', 'meeting': 'scheduling', 'email': 'email-management',
  'crm': 'crm', 'outreach': 'outreach', 'campaign': 'outreach',

  // Executive
  'book': 'executive-scheduling', 'flight': 'travel-booking',
  'hotel': 'travel-booking', 'expense': 'expense-tracking',
  'receipt': 'expense-tracking', 'invoice': 'expense-tracking',
};

class ScopeGuard {
  constructor({ agentId, allowedTopics = [], audit }) {
    this.agentId       = agentId;
    this.allowedTopics = new Set(allowedTopics);
    this.audit         = audit;
  }

  /**
   * Check if a request is within this agent's scope.
   *
   * @param {string} text — user request text
   * @param {string} [explicitTopic] — if topic is already known
   * @returns {{ inScope, topic?, suggestedAgent?, message }}
   */
  check(text, explicitTopic) {
    const topic = explicitTopic || this._classifyTopic(text);

    if (!topic) {
      // Could not classify — allow but flag
      return {
        inScope: true,
        topic:   null,
        message: 'Topic could not be classified — proceeding with caution',
        flag:    'UNCLASSIFIED',
      };
    }

    if (this.allowedTopics.has(topic)) {
      return { inScope: true, topic, message: 'Within scope' };
    }

    // Out of scope — suggest correct agent
    const taxonomy = TOPIC_TAXONOMY[topic];
    const suggestedAgent = taxonomy?.agent || null;

    if (this.audit) {
      this.audit.log({
        action: 'scope_violation',
        module: 'scope-guard',
        input:  text.slice(0, 200),
        output: `Topic "${topic}" outside scope. Suggested: ${suggestedAgent}`,
        metadata: { topic, suggestedAgent, allowedTopics: [...this.allowedTopics] },
      });
    }

    return {
      inScope: false,
      topic,
      suggestedAgent,
      message: suggestedAgent
        ? `This request is about "${topic}" which is handled by ${suggestedAgent}. I specialize in: ${[...this.allowedTopics].join(', ')}.`
        : `This request is about "${topic}" which is outside my scope. I specialize in: ${[...this.allowedTopics].join(', ')}.`,
    };
  }

  /**
   * Classify the topic of a text input using keyword matching.
   */
  _classifyTopic(text) {
    if (!text) return null;
    const lower = text.toLowerCase();

    // Check keywords in order of specificity (longer phrases first)
    const sortedKeywords = Object.entries(KEYWORD_MAP)
      .sort((a, b) => b[0].length - a[0].length);

    for (const [keyword, topic] of sortedKeywords) {
      if (lower.includes(keyword)) return topic;
    }

    return null;
  }
}

module.exports = { ScopeGuard, TOPIC_TAXONOMY, KEYWORD_MAP };
