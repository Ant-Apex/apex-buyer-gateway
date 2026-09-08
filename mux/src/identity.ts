/**
 * ▲ Per-user identity management.
 *
 * Each gateway user owns a secp256k1 keypair. The EVM address derived from it
 * IS the AntSeed peerId AND the on-chain buyer address. The user funds that
 * address themselves via AntseedDeposits.deposit(buyerAddr, amount) — we never
 * touch user funds.
 *
 * At rest the key is AES-256-GCM encrypted under MUX_MASTER_KEY (env-only).
 * The raw key is exportable exactly once per explicit user request
 * (export-key endpoint) — the cabinet encrypts it to the user's wallet pubkey
 * (ECIES) or their passphrase. That backup IS the user's exit guarantee:
 * with it they can run `antseed buyer withdraw` anywhere, without us.
 *
 * TEE phase: keys will be generated inside the enclave and the master-key
 * path disappears entirely; this module's interface stays unchanged.
 */
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { identityFromPrivateKeyHex, type Identity } from "@antseed/node";

const KEY_FILE = "identity.enc";

export function userDir(dataDir: string, peerId: string): string {
  return join(dataDir, "users", peerId);
}

function encrypt(masterKey: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", masterKey, iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

function decrypt(masterKey: Buffer, blob: Buffer): string {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const d = createDecipheriv("aes-256-gcm", masterKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

/** Create a fresh identity for a new user. Throws if one already exists. */
export function createIdentity(dataDir: string, masterKeyHex: string): Identity {
  const masterKey = Buffer.from(masterKeyHex, "hex");
  const privateKeyHex = randomBytes(32).toString("hex");
  const identity = identityFromPrivateKeyHex(privateKeyHex);
  const dir = userDir(dataDir, identity.peerId);
  if (existsSync(join(dir, KEY_FILE)))
    throw new Error(`identity collision for ${identity.peerId} (astronomically unlikely; retry)`);
  mkdirSync(join(dir, "payments"), { recursive: true });
  writeFileSync(join(dir, KEY_FILE), encrypt(masterKey, privateKeyHex), { mode: 0o600 });
  return identity;
}

/** Load an existing identity by peerId. Returns null if unknown. */
export function loadIdentity(dataDir: string, masterKeyHex: string, peerId: string): Identity | null {
  const p = join(userDir(dataDir, peerId), KEY_FILE);
  if (!existsSync(p)) return null;
  const hex = decrypt(Buffer.from(masterKeyHex, "hex"), readFileSync(p));
  return identityFromPrivateKeyHex(hex);
}

/** Raw hex export — ONLY for the authenticated backup flow. */
export function exportIdentityHex(dataDir: string, masterKeyHex: string, peerId: string): string | null {
  const p = join(userDir(dataDir, peerId), KEY_FILE);
  if (!existsSync(p)) return null;
  return decrypt(Buffer.from(masterKeyHex, "hex"), readFileSync(p));
}
