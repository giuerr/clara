// VENDORED — do not edit here.
// Source of truth: packages/institutional-core in the tabularum monorepo.
// Refresh with: scripts/sync-institutional-core.sh
'use strict';

/**
 * CITATION TRACKER
 *
 * Every claim in an institutional AI output must be traceable to a source.
 * This module enforces citation discipline across all agents.
 *
 * Citation types:
 *   REGULATION   — statute, directive, rule (e.g., AIFMD Art. 23)
 *   CASE_LAW     — court decision (e.g., Arnold v Britton [2015] UKSC 36)
 *   TEMPLATE     — institutional template (e.g., ILPA Model LPA v3.0)
 *   MARKET_DATA  — data provider (e.g., Yahoo Finance, Bloomberg)
 *   INTERNAL     — prior deal/memo/document within tenant data
 *   GUIDELINE    — industry body guidance (e.g., IPEV Valuation Guidelines)
 *   USER_INPUT   — information provided by the user/client
 *   WEB_SOURCE   — publicly accessible web resource
 *
 * Every citation carries: type, title, reference, url?, date?, jurisdiction?, confidence
 */

const CITATION_TYPES = [
  'REGULATION', 'CASE_LAW', 'TEMPLATE', 'MARKET_DATA',
  'INTERNAL', 'GUIDELINE', 'USER_INPUT', 'WEB_SOURCE',
];

class CitationTracker {
  constructor({ agentId, audit }) {
    this.agentId = agentId;
    this.audit   = audit;
  }

  /**
   * Create a structured citation.
   *
   * @param {object} src
   * @param {string} src.type        — one of CITATION_TYPES
   * @param {string} src.title       — human-readable title
   * @param {string} src.reference   — formal citation string
   * @param {string} [src.url]       — link to source
   * @param {string} [src.date]      — date of source (ISO or descriptive)
   * @param {string} [src.jurisdiction] — relevant jurisdiction
   * @param {string} [src.excerpt]   — relevant excerpt (max 500 chars)
   * @param {number} [src.confidence] — 0–1 confidence that this source is relevant
   * @returns {object} validated citation
   */
  cite(src) {
    if (!src || !src.type || !src.title || !src.reference) {
      throw new Error('Citation requires type, title, and reference');
    }
    if (!CITATION_TYPES.includes(src.type)) {
      throw new Error(`Invalid citation type: ${src.type}. Must be one of: ${CITATION_TYPES.join(', ')}`);
    }

    return {
      id:           `CIT-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      type:         src.type,
      title:        src.title,
      reference:    src.reference,
      url:          src.url || null,
      date:         src.date || null,
      jurisdiction: src.jurisdiction || null,
      excerpt:      src.excerpt ? src.excerpt.slice(0, 500) : null,
      confidence:   typeof src.confidence === 'number' ? Math.max(0, Math.min(1, src.confidence)) : null,
      citedBy:      this.agentId,
      citedAt:      new Date().toISOString(),
    };
  }

  /**
   * Attach citations to a response object.
   *
   * @param {string|object} response — the AI response
   * @param {object[]} sources — array of raw source objects to convert to citations
   * @returns {{ response, citations: object[], citationSummary: object }}
   */
  attach(response, sources = []) {
    const citations = [];

    for (const src of sources) {
      try {
        citations.push(this.cite(src));
      } catch (e) {
        // Skip invalid citations but log
        if (this.audit) {
          this.audit.log({
            action: 'citation_invalid',
            module: 'citations',
            input:  JSON.stringify(src).slice(0, 200),
            output: e.message,
          });
        }
      }
    }

    const citationSummary = {
      total:        citations.length,
      byType:       this._countByType(citations),
      jurisdictions: [...new Set(citations.map(c => c.jurisdiction).filter(Boolean))],
      hasRegulatory: citations.some(c => c.type === 'REGULATION'),
      hasCaseLaw:    citations.some(c => c.type === 'CASE_LAW'),
      hasTemplate:   citations.some(c => c.type === 'TEMPLATE'),
    };

    return { response, citations, citationSummary };
  }

  /**
   * Build citation block for injection into AI system prompts.
   * Forces the model to reference these sources in its response.
   */
  buildPromptBlock(citations) {
    if (!citations || citations.length === 0) return '';

    let block = '\n\n--- AUTHORITATIVE SOURCES (cite these where relevant) ---\n';
    for (const c of citations) {
      block += `\n[${c.type}] ${c.reference}`;
      if (c.title !== c.reference) block += ` — ${c.title}`;
      if (c.jurisdiction) block += ` (${c.jurisdiction})`;
      if (c.url) block += `\n  URL: ${c.url}`;
      if (c.excerpt) block += `\n  Excerpt: "${c.excerpt}"`;
      block += '\n';
    }
    block += '\n--- END SOURCES ---\n';
    block += 'INSTRUCTION: When making claims supported by the above sources, cite them using [SOURCE: reference] format. ';
    block += 'If a claim is NOT supported by any provided source, prefix it with [UNVERIFIED]. ';
    block += 'Never fabricate citations.\n';

    return block;
  }

  /**
   * Extract inline citations from AI response text.
   * Looks for [SOURCE: ...] and [UNVERIFIED] markers.
   */
  extractInlineCitations(text) {
    const cited = [];
    const unverified = [];

    const sourcePattern = /\[SOURCE:\s*([^\]]+)\]/g;
    let match;
    while ((match = sourcePattern.exec(text)) !== null) {
      cited.push({ reference: match[1].trim(), position: match.index });
    }

    const unverifiedPattern = /\[UNVERIFIED\]/g;
    while ((match = unverifiedPattern.exec(text)) !== null) {
      unverified.push({ position: match.index });
    }

    return {
      citedReferences: cited,
      unverifiedClaims: unverified.length,
      citationDensity: text.split(/\s+/).length > 0
        ? (cited.length / text.split(/\s+/).length * 100).toFixed(2) + '%'
        : '0%',
    };
  }

  _countByType(citations) {
    const counts = {};
    for (const c of citations) {
      counts[c.type] = (counts[c.type] || 0) + 1;
    }
    return counts;
  }
}

module.exports = { CitationTracker, CITATION_TYPES };
