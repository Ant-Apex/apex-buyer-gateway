/**
 * seller-peer-view: полноценный BuyerPeerView для нашего селлера.
 * Источник — конфиг селлера на этом же хосте (pricing/apiProtocols/unitBillingModels).
 * Кэш 60s, чтобы цены/сервисы подхватывались после рестартов селлера.
 */
import { readFileSync } from "node:fs";

export interface SellerPeerViewInput {
  sellerPeerId: string;
  sellerCapabilities: string[];
  sellerPublicAddress: string;
  sellerConfigPath?: string;
}

let cache: { ts: number; view: any } = { ts: 0, view: null };

export function buildSellerPeerView(input: SellerPeerViewInput): any {
  if (Date.now() - cache.ts < 60_000 && cache.view) return cache.view;
  const view: any = {
    peerId: input.sellerPeerId,
    capabilities: input.sellerCapabilities,
    publicAddress: input.sellerPublicAddress,
    providers: [],
    providerPricing: {},
    providerServiceApiProtocols: {},
    providerServiceUnitBillingModels: {},
    providerServiceCategories: {},
  };
  try {
    const cfg = JSON.parse(readFileSync(
      input.sellerConfigPath ?? "/home/antseed/.antseed/config.json", "utf8"));
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
  cache = { ts: Date.now(), view };
  return view;
}
