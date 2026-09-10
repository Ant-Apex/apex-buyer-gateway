/**
 * ▲ Internal HTTP API (loopback, bearer-auth). Гейтвей — единственный клиент.
 *
 * Прокси-контракт:
 *   POST /u/:userId/request
 *     headers: x-target-method, x-target-path (+ x-fwd-* для заголовков на селлера)
 *     body: raw bytes
 *   ← ответ селлера: status/headers/body, стримится как есть (SSE сквозной).
 *
 * Админка:
 *   POST   /internal/users            {userId} → {peerId, buyerAddress}
 *   GET    /internal/users/:userId    → {peerId, buyerAddress, balance}
 *   POST   /internal/attach           {userId, peerId} → reattach после рестарта
 *   POST   /internal/export-key       {peerId} → {identityHex}   (backup flow!)
 *   GET    /internal/stats            → {users, hotSessions}
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { MuxConfig } from "./config.js";
import type { Mux } from "./mux.js";
import type { SerializedHttpRequest } from "@antseed/protocol/http";

function send(res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) {
  const b = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", ...headers });
  res.end(b);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > limit) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export function startApi(cfg: MuxConfig, mux: Mux): void {
  const srv = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const auth = req.headers.authorization ?? "";

      // ── прокси-путь (аутентификация юзера — на гейтвее; тут internal token) ──
      const m = url.pathname.match(/^\/u\/([A-Za-z0-9_-]+)\/request$/);
      if (m && req.method === "POST") {
        if (auth !== `Bearer ${cfg.internalToken}`) return send(res, 401, { error: "unauthorized" });
        const s = mux.session(m[1]);
        if (!s) return send(res, 404, { error: "unknown_user" });

        const targetMethod = String(req.headers["x-target-method"] ?? "POST");
        const targetPath = String(req.headers["x-target-path"] ?? "/v1/chat/completions");
        const fwdHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (k.startsWith("x-fwd-") && typeof v === "string") fwdHeaders[k.slice(6)] = v;
        }
        const body = await readBody(req, cfg.maxUploadBodyBytes);
        const requestId = randomUUID();

        const sReq: SerializedHttpRequest = {
          requestId, method: targetMethod, path: targetPath, headers: fwdHeaders,
          body: new Uint8Array(body),
        };

        // Стримим ответ: сначала status+headers селлера, потом тело/чанки.
        let headSent = false;
        const sRes = await s.sendRequest(cfg, sReq, {
          onResponseStart: (r, meta) => {
            if (meta.streaming && !headSent) {
              headSent = true;
              res.writeHead(r.statusCode, {
                ...filterHeaders(r.headers),
                "x-antseed-request-id": requestId,
                "transfer-encoding": "chunked",
              });
            }
          },
          onResponseChunk: (c) => { if (headSent && c.data.length) res.write(Buffer.from(c.data)); },
        }, req.aborted ? undefined : undefined);

        if (!headSent) {
          res.writeHead(sRes.statusCode, {
            ...filterHeaders(sRes.headers),
            "x-antseed-request-id": requestId,
          });
        }
        if (sRes.body?.length) res.write(Buffer.from(sRes.body));
        return res.end();
      }

      // ── админка ──
      if (auth !== `Bearer ${cfg.internalToken}`) return send(res, 401, { error: "unauthorized" });

      if (url.pathname === "/internal/users" && req.method === "POST") {
        const { userId } = JSON.parse((await readBody(req, 4096)).toString("utf8") || "{}");
        if (!userId) return send(res, 400, { error: "userId required" });
        if (mux.session(userId)) return send(res, 409, { error: "user_exists" });
        return send(res, 201, mux.createUser(userId));
      }
      const gu = url.pathname.match(/^\/internal\/users\/([A-Za-z0-9_-]+)$/);
      if (gu && req.method === "GET") {
        const s = mux.session(gu[1]);
        if (!s) return send(res, 404, { error: "unknown_user" });
        const bal = await s.balance();
        return send(res, 200, {
          peerId: s.peerId, buyerAddress: s.evmAddress,
          balance: bal && {
            availableUsdc: (Number(bal.available) / 1e6).toFixed(6),
            reservedUsdc: (Number(bal.reserved) / 1e6).toFixed(6),
          },
        });
      }
      if (url.pathname === "/internal/close" && req.method === "POST") {
        const { userId } = JSON.parse((await readBody(req, 4096)).toString("utf8") || "{}");
        if (!userId) return send(res, 400, { error: "userId_required" });
        try {
          const r = await mux.closeUserChannel(userId);
          if (!r) return send(res, 404, { error: "unknown_user" });
          return send(res, 200, r);
        } catch (e: any) {
          return send(res, 409, { error: String(e?.message ?? e).slice(0, 200) });
        }
      }
      if (url.pathname === "/internal/attach" && req.method === "POST") {
        const { userId, peerId } = JSON.parse((await readBody(req, 4096)).toString("utf8") || "{}");
        return mux.attachUser(userId, peerId)
          ? send(res, 200, { ok: true })
          : send(res, 404, { error: "unknown_peer" });
      }
      if (url.pathname === "/internal/import" && req.method === "POST") {
        const { userId, privateKey } = JSON.parse((await readBody(req, 4096)).toString("utf8") || "{}");
        if (!userId || !privateKey) return send(res, 400, { error: "userId_and_privateKey_required" });
        try { return send(res, 200, mux.importUser(userId, privateKey)); }
        catch (e: any) { return send(res, 400, { error: String(e?.message ?? e).slice(0, 120) }); }
      }
      if (url.pathname === "/internal/adopt" && req.method === "POST") {
        const { userId, address } = JSON.parse((await readBody(req, 4096)).toString("utf8") || "{}");
        if (!userId || !address) return send(res, 400, { error: "userId_and_address_required" });
        const r = mux.adoptUser(userId, address);
        return r ? send(res, 200, r) : send(res, 404, { error: "address_not_in_keystore" });
      }
      if (url.pathname === "/internal/export-key" && req.method === "POST") {
        const { peerId } = JSON.parse((await readBody(req, 4096)).toString("utf8") || "{}");
        const hex = mux.exportUserKey(peerId);
        return hex ? send(res, 200, { identityHex: hex }) : send(res, 404, { error: "unknown_peer" });
      }
      if (url.pathname === "/internal/stats" && req.method === "GET") {
        return send(res, 200, mux.stats());
      }

      send(res, 404, { error: "not_found" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) send(res, 502, { error: "mux_error", message: msg });
      else res.end();
    }
  });
  srv.listen(cfg.listenPort, cfg.listenHost, () => {
    console.log(`[mux] internal API on http://${cfg.listenHost}:${cfg.listenPort}`);
  });
}

function filterHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const lk = k.toLowerCase();
    if (lk === "content-length" || lk === "transfer-encoding" || lk === "connection") continue;
    out[k] = v;
  }
  return out;
}
