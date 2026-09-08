/**
 * ▲ Periodic USDC sweeper — runs INSIDE the enclave.
 *
 * Users may send USDC directly to their buyer address (bypassing the cabinet
 * deposit flow). The deposits contract only credits deposits made through it,
 * so we sweep loose USDC into it per user. Gas comes from a tiny dedicated
 * funder wallet (GAS_FUNDER_KEY, env-only) — never the seller key.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { JsonRpcProvider, Wallet, Contract, parseEther, formatUnits } from "ethers";
import type { MuxConfig } from "./config.js";
import { exportIdentityHex } from "./identity.js";

const MIN_SWEEP = 100_000n; // $0.10
const GAS_TOPUP = parseEther("0.00001");
const MIN_GAS = parseEther("0.000003");

const USDC_ABI = ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256)"];
const DEPOSITS_ABI = ["function deposit(address buyer, uint256 amount)"];

export function startSweeper(cfg: MuxConfig, masterKeyHex: string): void {
  const funderKey = process.env.GAS_FUNDER_KEY;
  if (!funderKey) { console.log("[sweeper] GAS_FUNDER_KEY unset — disabled"); return; }
  const provider = new JsonRpcProvider(cfg.rpcUrl);
  const funder = new Wallet(funderKey.replace(/^0x/, ""), provider);
  const usdc = new Contract(cfg.usdcAddress, USDC_ABI, provider);
  const usersRoot = join(cfg.dataDir, "users");

  const tick = async () => {
    let peerIds: string[];
    try { peerIds = readdirSync(usersRoot).filter((f) => /^[0-9a-f]{40}$/.test(f)); }
    catch { return; }
    for (const peerId of peerIds) {
      const eoa = "0x" + peerId;
      try {
        const bal: bigint = await usdc.balanceOf(eoa);
        if (bal < MIN_SWEEP) continue;
        const hex = exportIdentityHex(cfg.dataDir, masterKeyHex, peerId);
        if (!hex) continue;
        const w = new Wallet(hex.replace(/^0x/, ""), provider);
        if ((await provider.getBalance(eoa)) < MIN_GAS) {
          const t = await funder.sendTransaction({ to: eoa, value: GAS_TOPUP });
          await t.wait();
        }
        const a = await (usdc.connect(w) as Contract).approve(cfg.depositsAddress, bal); await a.wait();
        const dep = new Contract(cfg.depositsAddress, DEPOSITS_ABI, w);
        const d = await dep.deposit(eoa, bal); await d.wait();
        console.log(`[sweeper] swept ${formatUnits(bal, 6)} USDC → deposit(${eoa.slice(0, 10)}…) tx=${d.hash}`);
      } catch (e: any) {
        console.error(`[sweeper] fail ${eoa.slice(0, 10)}…:`, String(e?.shortMessage || e?.message || e).slice(0, 140));
      }
    }
  };
  const t = setInterval(() => void tick(), 300_000);
  t.unref();
  console.log("[sweeper] started (5 min interval)");
}
