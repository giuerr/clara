// VENDORED — do not edit here.
// Source of truth: packages/institutional-core in the tabularum monorepo.
// Refresh with: scripts/sync-institutional-core.sh
'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * OUTPUT VERSIONING
 *
 * Immutable snapshots of every generated artifact.
 * Institutions must prove WHAT was generated WHEN.
 *
 * Each version record contains:
 *   - Content hash (SHA-256) for integrity verification
 *   - Full content snapshot (stored to disk)
 *   - Metadata: who requested, when, which model, confidence score
 *   - Previous version link (for diff/redline capability)
 *
 * Storage: JSON index + raw content files.
 */

class OutputVersioning {
  constructor({ agentId, dataDir, audit }) {
    this.agentId  = agentId;
    this.dataDir  = path.join(dataDir, 'versions');
    this.audit    = audit;
    this._index   = {};

    this._ensureDir();
    this._loadIndex();
  }

  /**
   * Save a new version of an output artifact.
   *
   * @param {string} artifactId — logical ID (e.g. 'lpa-draft-fundA', 'capital-call-2024Q1')
   * @param {string|object} content — the artifact content
   * @param {object} meta
   * @param {string} [meta.userId]
   * @param {string} [meta.action]     — what produced this (e.g. 'draft', 'review')
   * @param {string} [meta.model]      — AI model used
   * @param {number} [meta.confidence] — confidence score
   * @param {string} [meta.docType]    — document type
   * @returns {object} version record
   */
  save(artifactId, content, meta = {}) {
    const serialized = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    const contentHash = crypto.createHash('sha256').update(serialized).digest('hex');

    // Check for duplicate (same content = no new version)
    const existing = this._index[artifactId];
    if (existing?.versions?.length > 0) {
      const lastVersion = existing.versions[existing.versions.length - 1];
      if (lastVersion.contentHash === contentHash) {
        return lastVersion; // no change
      }
    }

    const versionNum = (existing?.versions?.length || 0) + 1;
    const versionId  = `${artifactId}-v${versionNum}`;
    const fileName   = `${versionId}.json`;

    const record = {
      versionId,
      versionNum,
      artifactId,
      contentHash,
      fileName,
      createdAt:   new Date().toISOString(),
      createdBy:   meta.userId || null,
      agent:       this.agentId,
      action:      meta.action || null,
      model:       meta.model || null,
      confidence:  meta.confidence ?? null,
      docType:     meta.docType || null,
      sizeBytes:   Buffer.byteLength(serialized, 'utf8'),
      prevVersion: existing?.versions?.length > 0
        ? existing.versions[existing.versions.length - 1].versionId
        : null,
    };

    // Write content to disk
    const contentFile = path.join(this.dataDir, fileName);
    fs.writeFileSync(contentFile, serialized, 'utf8');

    // Update index
    if (!this._index[artifactId]) {
      this._index[artifactId] = { artifactId, versions: [] };
    }
    this._index[artifactId].versions.push(record);
    this._saveIndex();

    // Audit
    if (this.audit) {
      this.audit.log({
        action:   'version_saved',
        module:   'versioning',
        input:    artifactId,
        output:   versionId,
        metadata: { contentHash, versionNum, sizeBytes: record.sizeBytes },
      });
    }

    return record;
  }

  /**
   * Get all versions of an artifact.
   */
  getHistory(artifactId) {
    return this._index[artifactId]?.versions || [];
  }

  /**
   * Get the latest version of an artifact.
   */
  getLatest(artifactId) {
    const versions = this.getHistory(artifactId);
    return versions.length > 0 ? versions[versions.length - 1] : null;
  }

  /**
   * Read the content of a specific version.
   */
  readVersion(versionId) {
    // Find the version record
    for (const entry of Object.values(this._index)) {
      const version = entry.versions.find(v => v.versionId === versionId);
      if (version) {
        const file = path.join(this.dataDir, version.fileName);
        if (fs.existsSync(file)) {
          const content = fs.readFileSync(file, 'utf8');
          return { ...version, content };
        }
      }
    }
    return null;
  }

  /**
   * Verify integrity of a version (check hash).
   */
  verify(versionId) {
    const version = this.readVersion(versionId);
    if (!version) return { valid: false, message: 'Version not found' };

    const actualHash = crypto.createHash('sha256').update(version.content).digest('hex');
    const valid = actualHash === version.contentHash;

    return {
      valid,
      versionId,
      expectedHash: version.contentHash,
      actualHash,
      message: valid ? 'Integrity verified' : 'INTEGRITY VIOLATION — content has been modified',
    };
  }

  /**
   * List all artifacts with their version counts.
   */
  listArtifacts() {
    return Object.entries(this._index).map(([id, entry]) => ({
      artifactId: id,
      versionCount: entry.versions.length,
      latestVersion: entry.versions[entry.versions.length - 1]?.versionId,
      lastModified:  entry.versions[entry.versions.length - 1]?.createdAt,
    }));
  }

  // --- Internal ---

  _ensureDir() {
    try { fs.mkdirSync(this.dataDir, { recursive: true }); } catch (_) {}
  }

  _indexFile() {
    return path.join(this.dataDir, '_index.json');
  }

  _loadIndex() {
    try {
      if (fs.existsSync(this._indexFile())) {
        this._index = JSON.parse(fs.readFileSync(this._indexFile(), 'utf8'));
      }
    } catch (_) { this._index = {}; }
  }

  _saveIndex() {
    try {
      fs.writeFileSync(this._indexFile(), JSON.stringify(this._index, null, 2), 'utf8');
    } catch (e) {
      console.error(`[VERSIONING] Index save failed: ${e.message}`);
    }
  }
}

module.exports = { OutputVersioning };
