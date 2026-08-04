// VENDORED — do not edit here.
// Source of truth: packages/institutional-core in the tabularum monorepo.
// Refresh with: scripts/sync-institutional-core.sh
'use strict';

/**
 * CONFIDENCE SCORER
 *
 * Assigns quantified confidence levels to every AI-generated output.
 * Institutions need to know WHEN to trust the output and when to escalate
 * to human review.
 *
 * Scoring dimensions:
 *   1. Data completeness  — were all required inputs provided?
 *   2. Source coverage     — how many authoritative sources back this?
 *   3. Domain match        — is this within the agent's core expertise?
 *   4. Hedging language    — does the AI output itself signal uncertainty?
 *   5. Template grounding  — was output generated from a known template?
 *
 * Output: { confidence: { score, level, dimensions, flags } }
 *
 * Levels:
 *   HIGH   (0.85–1.0)  — safe for automated workflows
 *   MEDIUM (0.60–0.84) — human review recommended
 *   LOW    (0.30–0.59) — human approval REQUIRED
 *   INSUFFICIENT (<0.30) — refuse to output, escalate
 */

const HEDGE_PATTERNS = [
  /\b(may|might|could|possibly|potentially|arguably|unclear|uncertain|debatable)\b/gi,
  /\b(it depends|not certain|hard to say|difficult to determine|further analysis needed)\b/gi,
  /\b(subject to|depending on|contingent upon|this is not legal advice)\b/gi,
  /\b(consult|seek professional|engage counsel|verify independently)\b/gi,
];

const CONFIDENCE_LEVELS = {
  HIGH:         { min: 0.85, label: 'HIGH',         action: 'auto_proceed' },
  MEDIUM:       { min: 0.60, label: 'MEDIUM',       action: 'human_review_recommended' },
  LOW:          { min: 0.30, label: 'LOW',           action: 'human_approval_required' },
  INSUFFICIENT: { min: 0.00, label: 'INSUFFICIENT', action: 'escalate_refuse' },
};

class ConfidenceScorer {
  constructor({ agentId, audit }) {
    this.agentId = agentId;
    this.audit   = audit;
  }

  /**
   * Score an AI response.
   *
   * @param {string|object} response — the raw AI output
   * @param {object} meta
   * @param {boolean}  meta.allInputsProvided  — were all required fields filled?
   * @param {number}   meta.sourceCount        — number of authoritative sources cited
   * @param {boolean}  meta.withinCoreDomain   — is this within agent's primary scope?
   * @param {boolean}  meta.templateGrounded   — was a known template used?
   * @param {string[]} [meta.missingFields]    — list of missing input fields
   * @param {string}   [meta.mode]             — operation mode (advise, draft, review, etc.)
   * @returns {{ response, confidence: { score, level, action, dimensions, flags } }}
   */
  score(response, meta = {}) {
    const text = typeof response === 'string'
      ? response
      : (response?.content || response?.text || JSON.stringify(response));

    const dimensions = {
      dataCompleteness:  this._scoreDataCompleteness(meta),
      sourceCoverage:    this._scoreSourceCoverage(meta),
      domainMatch:       this._scoreDomainMatch(meta),
      hedgingAnalysis:   this._scoreHedging(text),
      templateGrounding: this._scoreTemplateGrounding(meta),
    };

    const weights = {
      dataCompleteness:  0.25,
      sourceCoverage:    0.20,
      domainMatch:       0.25,
      hedgingAnalysis:   0.15,
      templateGrounding: 0.15,
    };

    let score = 0;
    for (const [dim, weight] of Object.entries(weights)) {
      score += (dimensions[dim]?.score || 0) * weight;
    }
    score = Math.round(score * 100) / 100;

    const level = this._classifyLevel(score);
    const flags = this._generateFlags(dimensions, meta);

    return {
      response,
      confidence: {
        score,
        level:      level.label,
        action:     level.action,
        dimensions,
        flags,
        scoredAt:   new Date().toISOString(),
        scoredBy:   this.agentId,
      },
    };
  }

  _scoreDataCompleteness(meta) {
    if (meta.allInputsProvided === true) return { score: 1.0, detail: 'All required inputs provided' };
    if (meta.missingFields?.length > 0) {
      const penalty = Math.min(meta.missingFields.length * 0.15, 0.6);
      return {
        score: Math.max(1.0 - penalty, 0.2),
        detail: `Missing fields: ${meta.missingFields.join(', ')}`,
        missing: meta.missingFields,
      };
    }
    return { score: 0.7, detail: 'Input completeness unknown' };
  }

  _scoreSourceCoverage(meta) {
    const count = meta.sourceCount || 0;
    if (count >= 5) return { score: 1.0, detail: `${count} authoritative sources`, sourceCount: count };
    if (count >= 3) return { score: 0.85, detail: `${count} sources`, sourceCount: count };
    if (count >= 1) return { score: 0.6, detail: `${count} source(s) — limited coverage`, sourceCount: count };
    return { score: 0.3, detail: 'No authoritative sources cited', sourceCount: 0 };
  }

  _scoreDomainMatch(meta) {
    if (meta.withinCoreDomain === true) return { score: 1.0, detail: 'Within core domain expertise' };
    if (meta.withinCoreDomain === false) return { score: 0.2, detail: 'OUTSIDE core domain — high uncertainty' };
    return { score: 0.6, detail: 'Domain match not determined' };
  }

  _scoreHedging(text) {
    if (!text) return { score: 0.5, detail: 'No text to analyze' };

    let hedgeCount = 0;
    const hedgeExamples = [];
    for (const pattern of HEDGE_PATTERNS) {
      const matches = text.match(pattern);
      if (matches) {
        hedgeCount += matches.length;
        hedgeExamples.push(...matches.slice(0, 2));
      }
    }

    const wordCount = text.split(/\s+/).length;
    const hedgeRatio = wordCount > 0 ? hedgeCount / wordCount : 0;

    // More hedging = lower confidence in the output's assertions
    let score;
    if (hedgeRatio < 0.005) score = 1.0;
    else if (hedgeRatio < 0.015) score = 0.85;
    else if (hedgeRatio < 0.03)  score = 0.65;
    else if (hedgeRatio < 0.05)  score = 0.45;
    else score = 0.25;

    return {
      score,
      detail: `${hedgeCount} hedging terms in ${wordCount} words (ratio: ${(hedgeRatio * 100).toFixed(2)}%)`,
      hedgeCount,
      hedgeExamples: hedgeExamples.slice(0, 5),
    };
  }

  _scoreTemplateGrounding(meta) {
    if (meta.templateGrounded === true) return { score: 1.0, detail: 'Output grounded in institutional template' };
    if (meta.templateGrounded === false) return { score: 0.4, detail: 'Free-form generation — no template grounding' };
    return { score: 0.6, detail: 'Template grounding unknown' };
  }

  _classifyLevel(score) {
    if (score >= CONFIDENCE_LEVELS.HIGH.min) return CONFIDENCE_LEVELS.HIGH;
    if (score >= CONFIDENCE_LEVELS.MEDIUM.min) return CONFIDENCE_LEVELS.MEDIUM;
    if (score >= CONFIDENCE_LEVELS.LOW.min) return CONFIDENCE_LEVELS.LOW;
    return CONFIDENCE_LEVELS.INSUFFICIENT;
  }

  _generateFlags(dimensions, meta) {
    const flags = [];

    if (dimensions.domainMatch?.score < 0.5) {
      flags.push({ type: 'OUT_OF_SCOPE', severity: 'critical', message: 'Response may be outside agent\'s domain expertise' });
    }
    if (dimensions.sourceCoverage?.sourceCount === 0) {
      flags.push({ type: 'NO_SOURCES', severity: 'warning', message: 'No authoritative sources backing this output' });
    }
    if (dimensions.dataCompleteness?.missing?.length > 2) {
      flags.push({ type: 'INCOMPLETE_INPUT', severity: 'warning', message: `${dimensions.dataCompleteness.missing.length} required fields missing` });
    }
    if (dimensions.hedgingAnalysis?.hedgeCount > 10) {
      flags.push({ type: 'HIGH_UNCERTAINTY', severity: 'warning', message: 'Output contains significant hedging language — treat as preliminary' });
    }
    if (dimensions.templateGrounding?.score < 0.5) {
      flags.push({ type: 'UNGROUNDED', severity: 'info', message: 'Output not grounded in institutional template' });
    }

    return flags;
  }
}

module.exports = { ConfidenceScorer, CONFIDENCE_LEVELS, HEDGE_PATTERNS };
