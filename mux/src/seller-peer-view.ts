/**
 * seller-peer-view: a full BuyerPeerView for our own seller.
 *
 * Two sources, in priority order:
 *  1. MUX_CATALOG_URL - the network catalog (a mirror of port 4199 via the website). The only
 *     option inside the TEE CVM, where the seller config is not reachable.
 *  2. The local seller config.json (VPS staging).
 *
 * 60s cache + background refresh; the interface is sync, so the network is touched in the background only.
 */
import { existsSync, readFileSync } from "node:fs";

export interface SellerPeerViewInput {
  sellerPeerId: string;
  sellerCapabilities: string[];
  sellerPublicAddress: string;
  sellerConfigPath?: string;
}

let cache: { ts: number; view: any } = { ts: 0, view: null };
let refreshing = false;

const CATALOG_URL = process.env.MUX_CATALOG_URL ?? "";

function emptyView(input: SellerPeerViewInput): any {
  return {
    peerId: input.sellerPeerId,
    capabilities: input.sellerCapabilities,
    publicAddress: input.sellerPublicAddress,
    providers: [],
    providerPricing: {},
    providerServiceApiProtocols: {},
    providerServiceUnitBillingModels: {},
    providerServiceCategories: {},
    providerServiceCapabilities: {},
  };
}

/** Catalog (v1/models aggregate): our offers by peerId -> BuyerPeerView. */
function viewFromCatalog(input: SellerPeerViewInput, catalog: any): any {
  const view = emptyView(input);
  const pfx = input.sellerPeerId.slice(0, 10);
  const pricing: Record<string, any> = {};
  const protocols: Record<string, string[]> = {};
  const units: Record<string, any> = {};
  const cats: Record<string, string[]> = {};
  const caps: Record<string, any> = {};
  let provider = "openai";
  for (const m of catalog?.data ?? []) {
    const p = (m.peers ?? []).find((x: any) => String(x?.peerId ?? "").startsWith(pfx));
    if (!p) continue;
    provider = p.provider ?? provider;
    const sid = p.serviceId ?? m.id;
    if (Array.isArray(p.protocols) && p.protocols.length) protocols[sid] = p.protocols;
    if (p.categories) cats[sid] = p.categories;
    if (p.capabilities) caps[sid] = p.capabilities;
    if (p.minImageUsdPerImage != null) {
      const proto = protocols[sid]?.[0] ?? "openai-images";
      units[sid] = {
        [proto]: { version: 1, components: [{ unit: "output_images", priceUsd: p.minImageUsdPerImage }] },
      };
      pricing[sid] = { inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
    } else if (p.inputUsdPerMillion != null) {
      pricing[sid] = {
        inputUsdPerMillion: p.inputUsdPerMillion,
        outputUsdPerMillion: p.outputUsdPerMillion ?? 0,
        cachedInputUsdPerMillion: p.cachedInputUsdPerMillion,
      };
    }
  }
  if (Object.keys(pricing).length || Object.keys(units).length) {
    view.providers = [provider];
    view.providerPricing[provider] = { services: pricing };
    view.providerServiceApiProtocols[provider] = { services: protocols };
    view.providerServiceUnitBillingModels[provider] = { services: units };
    view.providerServiceCategories[provider] = { services: cats };
    view.providerServiceCapabilities[provider] = { services: caps };
  }
  return view;
}

/** Local config.json (VPS): services.* -> BuyerPeerView. */
function viewFromSellerConfig(input: SellerPeerViewInput): any {
  const view = emptyView(input);
  try {
    const cfgPath = input.sellerConfigPath ?? "/home/antseed/.antseed/config.json";
    if (!existsSync(cfgPath)) return view;
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    const providers = cfg?.seller?.providers ?? {};
    for (const [pname, pval] of Object.entries<any>(providers)) {
      const services = pval?.services ?? {};
      view.providers.push(pname);
      const pricing: Record<string, any> = {};
      const protocols: Record<string, string[]> = {};
      const units: Record<string, any> = {};
      const cats: Record<string, string[]> = {};
      for (const [mid, svc] of Object.entries<any>(services)) {
        if (svc.pricing) pricing[mid] = svc.pricing;
        if (svc.apiProtocols) protocols[mid] = svc.apiProtocols;
        if (svc.unitBillingModels) units[mid] = svc.unitBillingModels;
        if (svc.categories) cats[mid] = svc.categories;
      }
      view.providerPricing[pname] = { services: pricing };
      view.providerServiceApiProtocols[pname] = { services: protocols };
      view.providerServiceUnitBillingModels[pname] = { services: units };
      view.providerServiceCategories[pname] = { services: cats };
    }
  } catch (e) {
    console.error("[mux] seller peer view build failed:", String((e as any)?.message ?? e).slice(0, 120));
  }
  return view;
}

async function refreshRemote(input: SellerPeerViewInput): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const r = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`catalog ${r.status}`);
    const j = await r.json();
    const view = viewFromCatalog(input, j);
    if (view.providers.length) cache = { ts: Date.now(), view };
  } catch (e) {
    console.error("[mux] catalog peer view refresh failed:", String((e as any)?.message ?? e).slice(0, 120));
  } finally {
    refreshing = false;
  }
}

export function buildSellerPeerView(input: SellerPeerViewInput): any {
  if (CATALOG_URL) {
    // Background: refresh the network cache. Synchronously we return what we have; on the very first
    // call after start there may be no cache - then, and only then, we read the
    // local config as a starting placeholder, if it exists at all.
    if (Date.now() - cache.ts > 60_000) void refreshRemote(input);
    if (cache.view) return cache.view;
    return viewFromSellerConfig(input);
  }
  if (Date.now() - cache.ts < 60_000 && cache.view) return cache.view;
  const view = viewFromSellerConfig(input);
  cache = { ts: Date.now(), view };
  return view;
}
