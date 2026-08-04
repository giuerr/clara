// VENDORED — do not edit here.
// Source of truth: packages/institutional-core in the tabularum monorepo.
// Refresh with: scripts/sync-institutional-core.sh
'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * PERSISTENT AUDIT TRAIL
 *
 * Append-only, tamper-evident decision log.
 * Every agent action is recorded with:
 *   - WHO triggered it (userId, tenantId)
 *   - WHAT happened (action, module, input summary, output summary)
 *   - WHEN it happened (ISO timestamp, duration)
 *   - WHY it was taken (confidence score, model used)
 *   - HOW to verify (hash chain for tamper evidence)
 *
 * Storage: JSON-lines file (.jsonl) per day, per tenant.
 * Each line is a self-contained JSON record with a SHA-256 chain hash
 * linking it to the previous record (tamper-evident).
 *
 * Retention: configurable, default 365 days.
 */

const MAX_INPUT_SUMMARY  = 200;
const MAX_OUTPUT_SUMMARY = 500;
const FLUSH_INTERVAL_MS  = 5000;

class AuditTrail {
  constructor({ agentId, agentVersion, dataDir, retentionDays = 365 }) {
    this.agentId       = agentId;
    this.agentVersion  = agentVersion || '0.0.0';
    this.dataDir       = path.join(dataDir, 'audit');
    this.retentionDays = retentionDays;
    this._buffer       = [];
    this._lastHash     = '0000000000000000000000000000000000000000000000000000000000000000';
    this._flushTimer   = null;
    this._inMemoryLog  = [];       // ring buffer for quick access
    this._inMemoryMax  = 1000;

    this._ensureDir();
    this._loadLastHash();
    this._startFlush();
  }

  /**
   * Log a decision/action. Returns the audit record.
   */
  log(entry) {
    const record = {
      id:           `AUD-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
      timestamp:    new Date().toISOString(),
      agent:        this.agentId,
      agentVersion: this.agentVersion,
      action:       entry.action || 'unknown',
      module:       entry.module || this.agentId,
      input:        _truncate(entry.input, MAX_INPUT_SUMMARY),
      output:       _truncate(entry.output, MAX_OUTPUT_SUMMARY),
      confidence:   entry.confidence ?? null,
      citationCount: entry.citationCount ?? null,
      userId:       entry.userId || null,
      tenantId:     entry.tenantId || null,
      model:        entry.model || null,
      durationMs:   entry.durationMs ?? null,
      outcome:      entry.outcome || 'success',
      error:        entry.error || null,
      metadata:     entry.metadata || {},
    };

    // Tamper-evident hash chain
    const payload   = JSON.stringify(record);
    record.prevHash = this._lastHash;
    record.hash     = crypto.createHash('sha256').update(this._lastHash + payload).digest('hex');
    this._lastHash  = record.hash;

    this._buffer.push(record);
    this._pushInMemory(record);

    return record;
  }

  /**
   * Query recent audit records (from in-memory ring buffer).
   */
  recent(limit = 50, filter = {}) {
    let records = [...this._inMemoryLog];

    if (filter.action)   records = records.filter(r => r.action === filter.action);
    if (filter.module)   records = records.filter(r => r.module === filter.module);
    if (filter.userId)   records = records.filter(r => r.userId === filter.userId);
    if (filter.tenantId) records = records.filter(r => r.tenantId === filter.tenantId);
    if (filter.since) {
      const since = new Date(filter.since).getTime();
      records = records.filter(r => new Date(r.timestamp).getTime() >= since);
    }

    return records.slice(-limit);
  }

  /**
   * Read full audit trail from disk for a date range.
   */
  readFromDisk(startDate, endDate) {
    const records = [];
    const start = new Date(startDate);
    const end   = new Date(endDate || new Date());

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const file = this._dayFile(d);
      if (fs.existsSync(file)) {
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          try { records.push(JSON.parse(line)); } catch (_) { /* skip corrupt */ }
        }
      }
    }
    return records;
  }

  /**
   * Verify hash chain integrity for a set of records.
   */
  verifyChain(records) {
    const issues = [];
    for (let i = 1; i < records.length; i++) {
      const prev    = records[i - 1];
      const current = records[i];
      if (current.prevHash !== prev.hash) {
        issues.push({
          index:    i,
          recordId: current.id,
          expected: prev.hash,
          actual:   current.prevHash,
          message:  'Hash chain broken — possible tampering',
        });
      }
    }
    return { valid: issues.length === 0, issues };
  }

  /**
   * Flush buffer to disk immediately.
   */
  flush() {
    if (this._buffer.length === 0) return;

    const toWrite = [...this._buffer];
    this._buffer  = [];

    const byDay = {};
    for (const record of toWrite) {
      const day = record.timestamp.slice(0, 10); // YYYY-MM-DD
      if (!byDay[day]) byDay[day] = [];
      byDay[day].push(record);
    }

    for (const [day, records] of Object.entries(byDay)) {
      const file  = this._dayFile(new Date(day));
      const lines = records.map(r => JSON.stringify(r)).join('\n') + '\n';
      try {
        fs.appendFileSync(file, lines, 'utf8');
      } catch (e) {
        // Re-buffer on write failure
        this._buffer.unshift(...records);
        console.error(`[AUDIT] Write failed for ${file}: ${e.message}`);
      }
    }
  }

  /**
   * Clean up audit files older than retention period.
   */
  cleanup() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.retentionDays);

    try {
      const files = fs.readdirSync(this.dataDir).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        const dateStr = file.replace(`${this.agentId}-`, '').replace('.jsonl', '');
        const fileDate = new Date(dateStr);
        if (fileDate < cutoff) {
          fs.unlinkSync(path.join(this.dataDir, file));
        }
      }
    } catch (_) { /* best effort */ }
  }

  /**
   * Shutdown: flush remaining buffer.
   */
  shutdown() {
    if (this._flushTimer) clearInterval(this._flushTimer);
    this.flush();
  }

  // --- Internal ---

  _ensureDir() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
    } catch (_) { /* already exists */ }
  }

  _dayFile(date) {
    const day = date.toISOString().slice(0, 10);
    return path.join(this.dataDir, `${this.agentId}-${day}.jsonl`);
  }

  _loadLastHash() {
    try {
      const today = this._dayFile(new Date());
      if (fs.existsSync(today)) {
        const content = fs.readFileSync(today, 'utf8').trim();
        const lines = content.split('\n').filter(Boolean);
        if (lines.length > 0) {
          const last = JSON.parse(lines[lines.length - 1]);
          if (last.hash) this._lastHash = last.hash;
        }
      }
    } catch (_) { /* start fresh */ }
  }

  _startFlush() {
    this._flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    if (this._flushTimer.unref) this._flushTimer.unref();
  }

  _pushInMemory(record) {
    this._inMemoryLog.push(record);
    while (this._inMemoryLog.length > this._inMemoryMax) {
      this._inMemoryLog.shift();
    }
  }
}

function _truncate(s, max) {
  if (!s) return '';
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  return str.length > max ? str.slice(0, max) + '...' : str;
}

module.exports = { AuditTrail };
