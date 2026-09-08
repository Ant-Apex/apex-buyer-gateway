/**
 * ▲ Apex Mux-Buyer — runtime configuration.
 * Everything overridable via env; no secrets in this file.
 */
import { resolveChainConfig } from "@antseed/node";

export interface MuxConfig {
  /** Loopback-only internal API port (gateway talks to us here). */
  listenHost: string;
  listenPort: number;
  /** Bearer token the gateway must present. Generated at deploy, env-only. */
  internalToken: string;
  /** Pinned seller. */
  sellerPeerId: string;
  sellerPublicAddress: string; // host:port
  sellerCapabilities: string[];
  /** Per-user state root: <dataDir>/users/<peerId>/{identity.enc,payments/} */
  dataDir: string;
  /** 64-hex master key for identity encryption at rest (AES-256-GCM). */
  masterKeyHex: string;
  /** Payments */
  rpcUrl: string;
  fallbackRpcUrls: string[];
  chainId: string; // "base-mainnet"
  evmChainId: number;
  depositsAddress: string;
  channelsAddress: string;
  usdcAddress: string;
  identityRegistryAddress: string;
  /** Buyer payment policy (mirror of CLI defaults, tuned for API users). */
  defaultAuthDurationSecs: number;
  maxPerRequestUsdc: bigint;
  maxReserveAmountUsdc: bigint;
  /** Request handling */
  requestTimeoutMs: number;
  maxStreamDurationMs: number;
  maxUploadBodyBytes: number;
  /** Hibernation */
  idleHibernateMs: number;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export function loadConfig(): MuxConfig {
  const chainId = process.env.MUX_CHAIN_ID ?? "base-mainnet";
  const rpcUrl = process.env.MUX_RPC_URL ?? "https://base.publicnode.com";
  const fallbackRpcUrls = (process.env.MUX_RPC_FALLBACKS ??
    "https://base.drpc.org,https://base.llamarpc.com")
    .split(",").map(s => s.trim()).filter(Boolean);

  // Contract addresses resolve from chain registry defaults (same as CLI);
  // env overrides win for testing/staging.
  const chain = resolveChainConfig({ chainId, rpcUrl, fallbackRpcUrls });

  const masterKeyHex = req("MUX_MASTER_KEY");
  if (!/^[0-9a-fA-F]{64}$/.test(masterKeyHex))
    throw new Error("MUX_MASTER_KEY must be 64 hex chars (32 bytes)");

  return {
    listenHost: process.env.MUX_LISTEN_HOST ?? "127.0.0.1",
    listenPort: Number(process.env.MUX_LISTEN_PORT ?? 8410),
    internalToken: req("MUX_INTERNAL_TOKEN"),
    sellerPeerId: process.env.MUX_SELLER_PEER_ID ??
      "73b4c9335fa239f9c6df3d28d5bf5d3cdf4de736",
    sellerPublicAddress: process.env.MUX_SELLER_ADDRESS ?? "104.194.132.226:6882",
    sellerCapabilities: (process.env.MUX_SELLER_CAPS ?? "transport.tcp-enc.v1")
      .split(",").map(s => s.trim()).filter(Boolean),
    dataDir: process.env.MUX_DATA_DIR ?? "./mux-data",
    masterKeyHex,
    rpcUrl: chain.rpcUrl,
    fallbackRpcUrls: chain.fallbackRpcUrls ?? fallbackRpcUrls,
    chainId,
    evmChainId: chain.evmChainId,
    depositsAddress: chain.depositsContractAddress,
    channelsAddress: chain.channelsContractAddress,
    usdcAddress: chain.usdcContractAddress,
    identityRegistryAddress: chain.identityRegistryAddress ?? "",
    defaultAuthDurationSecs: Number(process.env.MUX_AUTH_DURATION_SECS ?? 900),
    maxPerRequestUsdc: BigInt(process.env.MUX_MAX_PER_REQUEST_USDC ?? "500000"),   // $0.50
    maxReserveAmountUsdc: BigInt(process.env.MUX_MAX_RESERVE_USDC ?? "1000000"),   // $1.00
    requestTimeoutMs: Number(process.env.MUX_REQUEST_TIMEOUT_MS ?? 120_000),
    maxStreamDurationMs: Number(process.env.MUX_MAX_STREAM_MS ?? 30 * 60_000),
    maxUploadBodyBytes: Number(process.env.MUX_MAX_UPLOAD_BYTES ?? 16 * 1024 * 1024),
    idleHibernateMs: Number(process.env.MUX_IDLE_HIBERNATE_MS ?? 15 * 60_000),
  };
}
