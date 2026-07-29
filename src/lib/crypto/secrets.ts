import 'server-only';
import { createHash, createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * AES-256-GCM encryption for stored credentials.
 *
 * Every API key the app holds is written through `encryptSecret` and read back
 * through `decryptSecret`. GCM is authenticated, so a tampered ciphertext
 * fails to decrypt rather than yielding garbage that gets sent to a vendor.
 *
 * ## Where the master key comes from
 *
 * The requirement is that no environment variable exists beyond the database
 * connection — but encryption needs a root of trust, and storing that root
 * next to the ciphertext it protects would be pointless. So by default the key
 * is DERIVED (HKDF-SHA256) from the Supabase service-role key, which is
 * already required to reach the database. No new configuration, and the secret
 * material never appears in the schema.
 *
 * `CREDENTIALS_MASTER_KEY` overrides that derivation when an install wants the
 * encryption key separated from the database key — for example so the DB
 * credential can be rotated without re-encrypting anything. Setting it is
 * optional and it is the only env var this module will read.
 *
 * ## Rotation
 *
 * Each ciphertext records the id of the key that produced it (the first bytes
 * of a hash of the key, never the key itself). `decryptSecret` accepts any key
 * in the active set, so a rotation can re-encrypt rows in the background while
 * the old key still decrypts everything not yet migrated — no downtime, and no
 * flag day.
 */

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the size GCM is specified for
const KEY_BYTES = 32;
const HKDF_INFO = 'ldr_tool:source_credentials:v1';

export class SecretCryptoError extends Error {}

/** Raw material the master key is derived from, in priority order. */
function keyMaterial(): string | null {
  const explicit = process.env.CREDENTIALS_MASTER_KEY;
  if (explicit && explicit.trim().length >= 16) return explicit.trim();

  const dbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  return dbKey && dbKey.trim() ? dbKey.trim() : null;
}

/** The previous master key during a rotation, so old rows still decrypt. */
function previousKeyMaterial(): string | null {
  const previous = process.env.CREDENTIALS_MASTER_KEY_PREVIOUS;
  return previous && previous.trim().length >= 16 ? previous.trim() : null;
}

function deriveKey(material: string): Buffer {
  // A fixed salt is acceptable here: the input is already high-entropy key
  // material, and the salt's role is domain separation, not stretching.
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(material, 'utf8'), Buffer.from(HKDF_INFO), Buffer.alloc(0), KEY_BYTES)
  );
}

/** Short, non-reversible label identifying which key produced a ciphertext. */
function keyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

interface ActiveKey {
  key: Buffer;
  id: string;
}

let cachedPrimary: ActiveKey | null = null;

function primaryKey(): ActiveKey {
  if (cachedPrimary) return cachedPrimary;
  const material = keyMaterial();
  if (!material) {
    throw new SecretCryptoError(
      'No encryption key available. Set SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY), or CREDENTIALS_MASTER_KEY, so stored credentials can be encrypted.'
    );
  }
  const key = deriveKey(material);
  cachedPrimary = { key, id: keyId(key) };
  return cachedPrimary;
}

/** Every key a ciphertext might have been produced with, newest first. */
function decryptionKeys(): ActiveKey[] {
  const keys: ActiveKey[] = [primaryKey()];
  const previous = previousKeyMaterial();
  if (previous) {
    const key = deriveKey(previous);
    keys.push({ key, id: keyId(key) });
  }
  return keys;
}

/** True when this process can encrypt and decrypt at all. */
export function isCryptoConfigured(): boolean {
  return keyMaterial() !== null;
}

/** The active key's id — shown in Settings so a rotation is observable. */
export function activeKeyId(): string | null {
  try {
    return primaryKey().id;
  } catch {
    return null;
  }
}

/**
 * Encrypts a secret into a self-describing, storable string:
 *   v1:<keyId>:<iv>:<authTag>:<ciphertext>   (each part base64url)
 */
export function encryptSecret(plaintext: string): string {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new SecretCryptoError('Refusing to encrypt an empty value.');
  }
  const { key, id } = primaryKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, id, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(':');
}

/**
 * Reverses `encryptSecret`. Returns null rather than throwing when the value
 * cannot be read — a corrupt or foreign-key row should surface as "not
 * configured", not as a 500 that takes a page down.
 */
export function decryptSecret(payload: string | null | undefined): string | null {
  if (!payload) return null;

  const parts = payload.split(':');
  if (parts.length !== 5 || parts[0] !== VERSION) return null;

  const [, id, ivPart, tagPart, ctPart] = parts;

  try {
    const iv = Buffer.from(ivPart, 'base64url');
    const tag = Buffer.from(tagPart, 'base64url');
    const ciphertext = Buffer.from(ctPart, 'base64url');

    for (const candidate of decryptionKeys()) {
      // Compare ids in constant time — they are not secret, but this avoids
      // leaking which keys exist through timing during a rotation.
      const a = Buffer.from(candidate.id);
      const b = Buffer.from(id);
      if (a.length !== b.length || !timingSafeEqual(a, b)) continue;

      const decipher = createDecipheriv(ALGORITHM, candidate.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    }
  } catch {
    // Wrong key, tampered ciphertext, or malformed input.
    return null;
  }
  return null;
}

/** Whether a stored value is in the encrypted envelope format. */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(`${VERSION}:`) && value.split(':').length === 5;
}

/** Whether a ciphertext was produced by a key other than the active one. */
export function needsReEncryption(payload: string | null | undefined): boolean {
  if (!isEncrypted(payload)) return Boolean(payload);
  try {
    return payload!.split(':')[1] !== primaryKey().id;
  } catch {
    return false;
  }
}

/** Last-4 hint for the UI. Never returns any other part of the secret. */
export function maskSecret(plaintext: string | null | undefined): string | null {
  if (!plaintext) return null;
  return `••••${plaintext.slice(-4)}`;
}
