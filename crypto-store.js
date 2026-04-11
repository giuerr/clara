/**
 * @module crypto-store
 * @description AES-256-GCM encryption at rest for PII JSON files.
 *
 * - Reads encryption key from process.env.CLARA_ENCRYPTION_KEY (64-char hex = 32 bytes)
 * - readEncrypted(filePath)       — decrypt + parse, backwards-compatible with plain JSON
 * - writeEncrypted(filePath, data) — stringify + encrypt + write with random IV
 * - atomicWriteEncrypted(filePath, data) — async atomic (tmp + rename) encrypted write
 *
 * Encrypted files are prefixed with the magic header "ENC:" followed by:
 *   <iv_hex>:<authTag_hex>:<ciphertext_hex>
 *
 * If CLARA_ENCRYPTION_KEY is not set, falls back to plaintext with a startup warning.
 */

const crypto = require("crypto");
const fs     = require("fs");
const path   = require("path");

const ALGORITHM  = "aes-256-gcm";
const MAGIC      = "ENC:";
const IV_BYTES   = 16;
const TAG_BYTES  = 16;

// ─── Key management ──────────────────────────────────────────────────────────
let _encryptionKey = null; // Buffer | null
let _warned = false;

function _getKey() {
  if (_encryptionKey !== null) return _encryptionKey;

  const hex = process.env.CLARA_ENCRYPTION_KEY;
  if (!hex) {
    if (!_warned) {
      console.warn(
        "[CRYPTO-STORE] WARNING: CLARA_ENCRYPTION_KEY is not set. " +
        "PII JSON files will be stored as PLAINTEXT. " +
        "Set a 64-character hex string (32 bytes) to enable AES-256-GCM encryption at rest."
      );
      _warned = true;
    }
    _encryptionKey = false; // false = explicitly no key
    return false;
  }

  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "CLARA_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). " +
      `Got ${hex.length} characters.`
    );
  }

  _encryptionKey = Buffer.from(hex, "hex");
  console.log("[CRYPTO-STORE] Encryption key loaded — PII files will be encrypted at rest (AES-256-GCM).");
  return _encryptionKey;
}

// ─── Encrypt / Decrypt primitives ────────────────────────────────────────────

function _encrypt(plaintext) {
  const key = _getKey();
  if (!key) return plaintext; // no key → passthrough

  const iv     = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag   = cipher.getAuthTag();

  // ENC:<iv_hex>:<authTag_hex>:<ciphertext_hex>
  return MAGIC + iv.toString("hex") + ":" + authTag.toString("hex") + ":" + encrypted.toString("hex");
}

function _decrypt(raw) {
  const key = _getKey();

  // Not encrypted — plain JSON
  if (!raw.startsWith(MAGIC)) {
    return raw;
  }

  if (!key) {
    throw new Error(
      "File is encrypted but CLARA_ENCRYPTION_KEY is not set. Cannot decrypt."
    );
  }

  const payload = raw.slice(MAGIC.length);
  const parts   = payload.split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted file — expected ENC:<iv>:<tag>:<ciphertext>");
  }

  const iv         = Buffer.from(parts[0], "hex");
  const authTag    = Buffer.from(parts[1], "hex");
  const ciphertext = Buffer.from(parts[2], "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Read a JSON file, decrypting if necessary.
 * Returns `fallback` if the file does not exist or is empty.
 * Backwards-compatible: plain JSON files are read normally.
 */
function readEncrypted(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf-8").trim();
    if (!raw) return fallback;
    const plaintext = _decrypt(raw);
    return JSON.parse(plaintext);
  } catch (e) {
    console.error(`[CRYPTO-STORE] Failed to read ${path.basename(filePath)}: ${e.message}`);
    return fallback;
  }
}

/**
 * Encrypt and write JSON data to a file (synchronous).
 */
function writeEncrypted(filePath, data) {
  const json = JSON.stringify(data, null, 2);
  const output = _encrypt(json);
  fs.writeFileSync(filePath, output);
}

/**
 * Atomic encrypted write (async): write to .tmp then rename.
 * Drop-in replacement for atomicWrite + JSON.stringify.
 */
async function atomicWriteEncrypted(filePath, data) {
  const json = JSON.stringify(data, null, 2);
  const output = _encrypt(json);
  const tmp = filePath + ".tmp";
  await fs.promises.writeFile(tmp, output);
  await fs.promises.rename(tmp, filePath);
}

/**
 * Atomic encrypted write (sync): for shutdown/signal handlers.
 */
function atomicWriteEncryptedSync(filePath, data) {
  const json = JSON.stringify(data, null, 2);
  const output = _encrypt(json);
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, output);
  fs.renameSync(tmp, filePath);
}

/**
 * Check if encryption is active.
 */
function isEncryptionEnabled() {
  return !!_getKey();
}

module.exports = {
  readEncrypted,
  writeEncrypted,
  atomicWriteEncrypted,
  atomicWriteEncryptedSync,
  isEncryptionEnabled,
};
