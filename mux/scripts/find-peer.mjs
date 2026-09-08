// One-shot DHT peer lookup (uses upstream @antseed/node discovery).
import { randomBytes } from "node:crypto";
import {
  DHTNode, DEFAULT_DHT_CONFIG,
  HttpMetadataResolver, PeerLookup, DEFAULT_LOOKUP_CONFIG,
} from "@antseed/node/discovery";

const target = process.argv[2]?.replace(/^0x/, "").toLowerCase();
if (!target || !/^[0-9a-f]{40}$/.test(target)) {
  console.error("usage: node scripts/find-peer.mjs <peerId-40-hex>");
  process.exit(1);
}

const dht = new DHTNode({ ...DEFAULT_DHT_CONFIG, peerId: randomBytes(20).toString("hex") });
await dht.start();
try {
  const lookup = new PeerLookup({
    dht,
    metadataResolver: new HttpMetadataResolver(),
    ...DEFAULT_LOOKUP_CONFIG,
  });
  const results = await lookup.findByPeerId(target);
  if (!results.length) {
    console.log("PEER NOT FOUND (offline or not announcing)");
  } else {
    for (const r of results) {
      const md = r.metadata ?? {};
      const services = [];
      for (const [prov, svc] of Object.entries(md.providers ?? {})) {
        for (const s of svc?.services ?? []) services.push(`${prov}/${s.id ?? s.serviceId ?? "?"}`);
      }
      console.log(JSON.stringify({
        peerId: md.peerId ?? target,
        endpoint: `${r.host}:${r.port}`,
        publicAddress: md.publicAddress,
        capabilities: md.capabilities,
        version: md.version,
        services: services.slice(0, 40),
        serviceCount: services.length,
      }, null, 1));
    }
  }
} finally {
  await dht.stop();
}
