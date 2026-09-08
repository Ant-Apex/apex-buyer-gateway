// Watcher: ждёт появления venice-proxy пира в DHT, пишет endpoint + шлёт TG-алерт.
// Cron: */10 * * * *  node /home/antseed/monitor/peer-watch-vproxy.mjs
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  DHTNode, DEFAULT_DHT_CONFIG, HttpMetadataResolver, PeerLookup, DEFAULT_LOOKUP_CONFIG,
} from "/usr/lib/node_modules/@antseed/cli/node_modules/@antseed/node/dist/discovery/index.js";

const TARGET = "1f228613116e2d08014dfdcc198377c8dedf18c9";
const STATE = "/home/antseed/monitor/vproxy-peer.json";

const dht = new DHTNode({ ...DEFAULT_DHT_CONFIG, peerId: randomBytes(20).toString("hex"), port: 16881 + Math.floor(Math.random() * 2000) });
await dht.start();
let found = null;
try {
  const lookup = new PeerLookup({ dht, metadataResolver: new HttpMetadataResolver(), ...DEFAULT_LOOKUP_CONFIG });
  const res = await lookup.findByPeerId(TARGET);
  if (res.length) {
    const r = res[0];
    found = { peerId: TARGET, host: r.host, port: r.port, ts: new Date().toISOString() };
  }
} finally { await dht.stop(); }

const prev = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : null;
if (found && !prev?.online) {
  writeFileSync(STATE, JSON.stringify({ ...found, online: true }, null, 1));
  // TG alert через env (usepod.env уже содержит креды вотчдога)
  const env = Object.fromEntries(readFileSync("/home/antseed/usepod.env", "utf8")
    .split("\n").filter(l => l.includes("=") && !l.startsWith("#"))
    .map(l => l.split("=", 2).map(s => s.trim())));
  const tok = env.TELEGRAM_BOT_TOKEN ?? env.TG_BOT_TOKEN;
  const chat = env.TELEGRAM_CHAT_ID ?? env.TG_CHAT_ID;
  if (tok && chat) {
    await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text:
        `🟢 venice-proxy peer ONLINE\n${TARGET}\nendpoint: ${found.host}:${found.port}\nможно funded e2e` }),
    }).catch(() => {});
  }
  console.log("ONLINE", found.host + ":" + found.port);
} else if (!found && prev?.online) {
  writeFileSync(STATE, JSON.stringify({ ...prev, online: false, lastSeen: prev.ts }));
  console.log("went offline");
} else {
  console.log(found ? "online (known)" : "offline");
}
