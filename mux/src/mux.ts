/**
 * ▲ Mux - registry of per-user sessions: lazy start, hibernation, spend ledger.
 */
import { randomUUID } from "node:crypto";
import type { MuxConfig } from "./config.js";
import { UserSession, type SpendEvent } from "./session.js";
import { createIdentity, loadIdentity, exportIdentityHex, importIdentity, findIdentityByAddress } from "./identity.js";
import { appendLedger } from "./ledger.js";

export class Mux {
  private _cfg: MuxConfig;
  private _sessions = new Map<string, UserSession>(); // userId → session
  private _sweeper: NodeJS.Timeout;

  constructor(cfg: MuxConfig) {
    this._cfg = cfg;
    this._sweeper = setInterval(() => void this._sweep(), 60_000);
    this._sweeper.unref();
  }

  /** New user: generate an identity and return the buyer address for the deposit. */
  createUser(userId: string): { peerId: string; buyerAddress: string } {
    const identity = createIdentity(this._cfg.dataDir, this._cfg.masterKeyHex);
    const s = new UserSession(userId, identity, this._cfg);
    this._wire(userId, s);
    this._sessions.set(userId, s);
    return { peerId: identity.peerId, buyerAddress: identity.wallet.address };
  }

  /** Register an existing peerId under a userId (after a process restart). */
  attachUser(userId: string, peerId: string): boolean {
    const identity = loadIdentity(this._cfg.dataDir, this._cfg.masterKeyHex, peerId);
    if (!identity) return false;
    const s = new UserSession(userId, identity, this._cfg);
    this._wire(userId, s);
    this._sessions.set(userId, s);
    return true;
  }

  /** Import a buyer from a private key: it is encrypted with the master key and stored in the keystore. */
  importUser(userId: string, privateKeyHex: string): { peerId: string; buyerAddress: string } {
    const identity = importIdentity(this._cfg.dataDir, this._cfg.masterKeyHex, privateKeyHex);
    const s = new UserSession(userId, identity, this._cfg);
    this._wire(userId, s);
    this._sessions.set(userId, s);
    return { peerId: identity.peerId, buyerAddress: identity.wallet.address };
  }

  /** Adopt: bind a user to a buyer whose key already sits in our keystore, looked up by address. */
  adoptUser(userId: string, address: string): { peerId: string; buyerAddress: string } | null {
    const identity = findIdentityByAddress(this._cfg.dataDir, this._cfg.masterKeyHex, address);
    if (!identity) return null;
    const s = new UserSession(userId, identity, this._cfg);
    this._wire(userId, s);
    this._sessions.set(userId, s);
    return { peerId: identity.peerId, buyerAddress: identity.wallet.address };
  }

  /** Backup of a user key (only through the authenticated internal flow). */
  exportUserKey(peerId: string): string | null {
    return exportIdentityHex(this._cfg.dataDir, this._cfg.masterKeyHex, peerId);
  }

  session(userId: string): UserSession | undefined { return this._sessions.get(userId); }

  async closeUserChannel(userId: string) {
    const s = this._sessions.get(userId);
    if (!s) return null;
    return s.closeChannel(this._cfg);
  }

  stats() {
    let hot = 0;
    for (const s of this._sessions.values()) if (s.isOpen) hot++;
    return { users: this._sessions.size, hotSessions: hot };
  }

  private _wire(userId: string, s: UserSession) {
    s.on("spend", (ev: SpendEvent) => {
      appendLedger(this._cfg.dataDir, {
        id: randomUUID(), ...ev,
      });
    });
    s.on("closed", () => { /* lazy reopen on next request */ });
  }

  private async _sweep(): Promise<void> {
    const now = Date.now();
    for (const s of this._sessions.values()) {
      if (s.isOpen && now - s.lastActivity > this._cfg.idleHibernateMs) {
        await s.hibernate().catch(() => {});
      }
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this._sweeper);
    for (const s of this._sessions.values()) await s.destroy().catch(() => {});
  }
}
