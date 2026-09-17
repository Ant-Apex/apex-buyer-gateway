/**
 * ▲ Apex Mux-Buyer — entry point.
 * One process, N user identities, one pinned seller. See ARCHITECTURE.md.
 */
import { loadConfig } from "./config.js";
import { Mux } from "./mux.js";
import { startApi } from "./api.js";
import { startSweeper } from "./sweeper.js";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const cfg = loadConfig();
const mux = new Mux(cfg);
startSweeper(cfg, process.env.MUX_MASTER_KEY!);

// Re-attach every known user from disk (peerId -> userId=peerId by default;
// on the first request the gateway may re-attach with the real userId).
const usersDir = join(cfg.dataDir, "users");
if (existsSync(usersDir)) {
  let n = 0;
  for (const peerId of readdirSync(usersDir)) {
    if (/^[0-9a-f]{40}$/.test(peerId) && mux.attachUser(peerId, peerId)) n++;
  }
  console.log(`[mux] reattached ${n} identities from disk`);
}

startApi(cfg, mux);

const shutdown = async () => {
  console.log("[mux] shutting down…");
  await mux.shutdown();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
