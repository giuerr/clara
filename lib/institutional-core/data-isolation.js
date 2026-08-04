// VENDORED — do not edit here.
// Source of truth: packages/institutional-core in the tabularum monorepo.
// Refresh with: scripts/sync-institutional-core.sh
'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * DATA ISOLATION
 *
 * Per-tenant / per-fund data partitioning.
 * Ensures no cross-contamination between clients.
 *
 * Directory structure:
 *   {dataDir}/
 *     {tenantId}/
 *       audit/          — audit trail (JSONL per day)
 *       versions/       — output version snapshots
 *       exports/        — generated documents
 *       cache/          — ephemeral data
 */

const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

class DataIsolation {
  constructor({ dataDir, tenantId = 'default' }) {
    if (!dataDir) throw new Error('DataIsolation requires dataDir');
    this.dataDir  = dataDir;
    this.tenantId = this._sanitizeId(tenantId);
  }

  /**
   * Get the isolated directory for the current tenant.
   */
  tenantDir() {
    const dir = path.join(this.dataDir, this.tenantId);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    return dir;
  }

  /**
   * Get a sub-path within the tenant directory.
   * Prevents path traversal attacks.
   */
  resolve(subPath) {
    const base     = this.tenantDir();
    const resolved = path.resolve(base, subPath);

    // Path traversal check
    if (!resolved.startsWith(base)) {
      throw new Error(`Path traversal blocked: ${subPath}`);
    }

    return resolved;
  }

  /**
   * Switch tenant context (returns new instance).
   */
  forTenant(tenantId) {
    return new DataIsolation({ dataDir: this.dataDir, tenantId });
  }

  /**
   * List all tenants (for admin use).
   */
  listTenants() {
    try {
      return fs.readdirSync(this.dataDir)
        .filter(f => {
          const full = path.join(this.dataDir, f);
          return fs.statSync(full).isDirectory() && SAFE_ID_PATTERN.test(f);
        });
    } catch (_) { return []; }
  }

  /**
   * Verify that a file belongs to the current tenant.
   */
  owns(filePath) {
    const resolved = path.resolve(filePath);
    return resolved.startsWith(path.resolve(this.tenantDir()));
  }

  _sanitizeId(id) {
    const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    if (!safe) throw new Error('Invalid tenant ID');
    return safe;
  }
}

module.exports = { DataIsolation };
