/**
 * ▲ Apex Gateway (staging) — cabinet + OpenAI/Venice-compatible API.
 * Один процесс: SIWE-кабинет, apx_ ключи, прокси в mux, метринг.
 * STAGING ONLY — прод после TEE (декрет).
 */
import { createServer } from "node:http";
import { createHmac, randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { verifyMessage } from "ethers";

// ── конфиг из env ──
const PORT = Number(process.env.GW_PORT ?? 8420);
const HOST = process.env.GW_HOST ?? "127.0.0.1";
const HMAC_SECRET = process.env.GW_HMAC_SECRET ?? (() => { throw new Error("GW_HMAC_SECRET"); })();
const MUX_URL = process.env.MUX_URL ?? "http://127.0.0.1:8410";
const MUX_TOKEN = process.env.MUX_INTERNAL_TOKEN ?? (() => { throw new Error("MUX_INTERNAL_TOKEN"); })();
const CATALOG_URL = process.env.GW_CATALOG_URL ?? "http://127.0.0.1:8377/v1/models";
const OUR_PEER = process.env.GW_SELLER_PEER ?? "73b4c9335fa239f9c6df3d28d5bf5d3cdf4de736";
const SITE_ORIGIN = process.env.GW_SITE_ORIGIN ?? "https://next.apex-ant.net";
const SITE_DOMAIN = new URL(SITE_ORIGIN).host;
const DEPOSITS_ADDR = process.env.GW_DEPOSITS_ADDR ?? "";
const USDC_ADDR = process.env.GW_USDC_ADDR ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const KEY_PREFIX = process.env.GW_KEY_PREFIX ?? "apx";

// ── db ──
const GW_DIR = process.env.GW_DATA_DIR ?? "./gw-data";
// одноразовый restore: /internal/restore-data кладёт restore.db + выходит;
// после рестарта подменяем gw.db ДО открытия
const RESTORE_DB = join(GW_DIR, "restore.db");
if (existsSync(RESTORE_DB)) {
  try { renameSync(RESTORE_DB, join(GW_DIR, "gw.db")); console.log("[gw] restore.db applied as gw.db"); }
  catch (e) { console.error("[gw] restore apply failed:", String(e).slice(0, 120)); }
}
const db = new Database(join(GW_DIR, "gw.db"));
db.exec(`
CREATE TABLE IF NOT EXISTS users(wallet TEXT PRIMARY KEY, peerId TEXT UNIQUE, created INTEGER);
CREATE TABLE IF NOT EXISTS keys(id TEXT PRIMARY KEY, wallet TEXT, keyHash TEXT, created INTEGER, revoked INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS challenges(address TEXT PRIMARY KEY, nonce TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY, wallet TEXT, keyId TEXT, model TEXT,
  inTok INTEGER, outTok INTEGER, cacheTok INTEGER, status INTEGER, ts INTEGER);
`);

// ── helpers ──
const json = (res, code, body, extra = {}) =>
  { res.writeHead(code, { "content-type": "application/json", ...cors(), ...extra }); res.end(JSON.stringify(body)); };
const cors = () => ({
  "access-control-allow-origin": SITE_ORIGIN,
  "access-control-allow-headers": "authorization,content-type",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
});
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const hmac = (s) => createHmac("sha256", HMAC_SECRET).update(s).digest("hex");

async function readJson(req) {
  let b = "";
  for await (const c of req) { b += c; if (b.length > 1e6) throw new Error("too big"); }
  return b ? JSON.parse(b) : {};
}

// multipart/form-data → JSON: файловые поля → data-url base64, текстовые → строки.
// нужно для /v1/images/edits: нода AntSeed ищет model в JSON-теле, multipart она не парсит.
function multipartToJson(buf, ct) {
  const m = String(ct).match(/boundary=([^;]+)/);
  if (!m) return null;
  const boundary = m[1].trim().replace(/^"|"$/g, "");
  const bin = buf.toString("binary");
  const parts = bin.split("--" + boundary).slice(1, -1);
  const out = {};
  for (const part of parts) {
    const idx = part.indexOf("\r\n\r\n");
    if (idx < 0) continue;
    const head = part.slice(0, idx);
    let body = part.slice(idx + 4);
    if (body.endsWith("\r\n")) body = body.slice(0, -2);
    const name = head.match(/name="([^"]+)"/)?.[1];
    if (!name) continue;
    if (/filename="/.test(head)) {
      const mime = head.match(/Content-Type:\s*([^\r\n]+)/i)?.[1]?.trim() ?? "image/png";
      out[name] = `data:${mime};base64,${Buffer.from(body, "binary").toString("base64")}`;
    } else out[name] = body;
  }
  return out;
}

// бинарное тело (multipart image edit) — лимит 30MB
async function readRaw(req) {
  const chunks = [];
  let n = 0;
  for await (const c of req) { chunks.push(c); n += c.length; if (n > 30e6) throw new Error("too big"); }
  return Buffer.concat(chunks);
}

// ── SIWE-lite: challenge = подписываемое сообщение, токен = HMAC(wallet:nonce) ──
function issueToken(wallet) {
  const payload = `${wallet.toLowerCase()}.${Date.now()}`;
  return Buffer.from(payload).toString("base64url") + "." + hmac(payload);
}
function verifyToken(token) {
  const [p, sig] = token.split(".");
  if (!p || !sig) return null;
  const payload = Buffer.from(p, "base64url").toString();
  if (hmac(payload) !== sig) return null;
  const [wallet, ts] = payload.split(".");
  if (Date.now() - Number(ts) > 30 * 24 * 3600e3) return null; // 30d
  return wallet;
}
function cabinetAuth(req) {
  const t = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  return t ? verifyToken(t) : null;
}

// ── apx_ ключи ──
function keyAuth(req) {
  const k = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (!k.startsWith(KEY_PREFIX + "_") && !k.startsWith("apx_test_") && !k.startsWith("apx_live_")) return null; // legacy prefixes keep working
  const row = db.prepare("SELECT id, wallet FROM keys WHERE keyHash=? AND revoked=0").get(sha256(k));
  return row ? { wallet: row.wallet, keyId: row.id } : null;
}

async function muxCall(path, init = {}) {
  return fetch(MUX_URL + path, {
    ...init,
    headers: { authorization: `Bearer ${MUX_TOKEN}`, ...(init.headers ?? {}) },
  });
}

// ── каталог моделей (кэш 60с, фильтр на наш peer, Venice-shape адаптация) ──
let catCache = { ts: 0, data: null };
// 2026-09-09: sell prices overlay from our public board (prices.json) — the
// network catalog's minImageUsdPerImage is a network-wide min, NOT our price
// (pickers showed $0.0045 for a $0.1215 model).
const PRICES_JSON_URL = process.env.GW_PRICES_URL ?? CATALOG_URL.replace(/\/v1\/models.*$/, "").replace(/\/catalog$/, "") + "/prices.json";
async function pricesOverlay() {
  try {
    const r = await fetch(PRICES_JSON_URL, { signal: AbortSignal.timeout(8000) });
    const pj = await r.json();
    const map = {};
    for (const m of pj.models ?? []) map[m.model] = { input: m.in ?? null, output: m.out ?? null, cached: m.cache ?? null };
    for (const m of pj.images ?? []) map[m.model] = { perImage: m.perImage ?? null };
    return map;
  } catch { return {}; }
}

async function modelsCatalog() {
  if (Date.now() - catCache.ts < 60_000 && catCache.data) return catCache.data;
  const [r, priceMap] = await Promise.all([fetch(CATALOG_URL), pricesOverlay()]);
  const j = await r.json();
  const out = [];
  for (const m of j.data ?? []) {
    const ours = (m.peers ?? []).find((p) => String(p.peerId ?? "").startsWith(OUR_PEER.slice(0, 10)));
    if (!ours) continue;
    const isImage = (m.supported_protocols ?? []).includes("openai-images");
    const ov = priceMap[m.id];
    out.push({
      id: m.id, object: "model", created: 1720000000, owned_by: "apex-ant",
      type: isImage ? "image" : "text",
      pricing: isImage
        ? { perImage: ov?.perImage ?? ours.minImageUsdPerImage ?? null }
        : { input: ov?.input ?? ours.inputUsdPerMillion ?? null, output: ov?.output ?? ours.outputUsdPerMillion ?? null, cached: ov?.cached ?? ours.cachedInputUsdPerMillion ?? null },
      model_spec: {
        name: m.id,
        pricing: ours.pricing ?? undefined,
        // 2026-09-08: реальные capabilities из нашего оффера (было capability_coverage —
        // чуждый формат, из-за него playground видел 1 модель). Venice-shape booleans.
        capabilities: (() => {
          const c = ours.capabilities ?? {};
          return {
            supportsFunctionCalling: !!c.toolUse,
            supportsReasoning: !!c.reasoning,
            supportsResponseSchema: !!c.structuredOutput,
            supportsVision: Array.isArray(c.inputs) && c.inputs.includes("image"),
          };
        })(),
        availableContextTokens: ours.capabilities?.contextWindow ?? undefined,
      },
    });
  }
  catCache = { ts: Date.now(), data: { object: "list", data: out } };
  return catCache.data;
}

// ── server ──
// ── rate limiting (in-memory, fixed window; сбрасывается при рестарте) ──
function makeLimiter(windowMs, max) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, Math.max(windowMs, 30_000)).unref();
  return (key) => { // 0 = ок; иначе retry-after, сек
    const now = Date.now();
    let e = hits.get(key);
    if (!e || e.resetAt <= now) { e = { count: 0, resetAt: now + windowMs }; hits.set(key, e); }
    return ++e.count <= max ? 0 : Math.ceil((e.resetAt - now) / 1000);
  };
}
const limGlobal = makeLimiter(60e3, 300);   // 300/мин на IP — общий потолок
const limAuth   = makeLimiter(600e3, 30);   // 30/10мин на IP — анти-брутфорс SIWE
const limChat   = makeLimiter(60e3, 60);    // 60/мин на apx-ключ
const limImage  = makeLimiter(60e3, 12);    // 12/мин на apx-ключ (дорогие генерации)

function limited(res, retryAfter, openaiShape = false) {
  res.setHeader("retry-after", String(retryAfter));
  return json(res, 429, openaiShape
    ? { error: { message: `Rate limit exceeded — retry in ${retryAfter}s`, code: "rate_limited" } }
    : { error: "rate_limited", retry_after: retryAfter });
}

createServer(async (req, res) => {
  let url = new URL(req.url ?? "/", "http://x");
  try {
    if (req.method === "OPTIONS") { res.writeHead(204, cors()); return res.end(); }

    const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?").split(",")[0].trim();
    { const ra = limGlobal("ip:" + ip); if (ra) return limited(res, ra); }
    // 2026-09-09: cabinet JS calls /api/auth/* — alias to the siwe handlers
    // (wallet connect was 404ing on both domains).
    if (url.pathname === "/api/auth/challenge") url = new URL("/cabinet/siwe/challenge", url);
    else if (url.pathname === "/api/auth/verify") url = new URL("/cabinet/siwe/verify", url);
    if (url.pathname.startsWith("/cabinet/siwe/")) {
      const ra = limAuth("auth:" + ip); if (ra) return limited(res, ra);
    }

    // ═══ cabinet ═══
    if (url.pathname === "/cabinet/siwe/challenge" && req.method === "POST") {
      const { address } = await readJson(req);
      if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? "")) return json(res, 400, { error: "bad_address" });
      const nonce = randomBytes(8).toString("hex");
      db.prepare("INSERT OR REPLACE INTO challenges VALUES (?,?,?)").run(address.toLowerCase(), nonce, Date.now());
      const message = [
        `${SITE_DOMAIN} wants you to sign in with your wallet:`,
        ``,
        address,
        ``,
        `No transaction, no gas, no permissions — this signature only proves ownership.`,
        ``,
        `URI: ${SITE_ORIGIN}`, `Version: 1`, `Chain ID: 8453`, `Nonce: ${nonce}`,
      ].join("\n");
      return json(res, 200, { message });
    }
    if (url.pathname === "/cabinet/siwe/verify" && req.method === "POST") {
      const { address, signature } = await readJson(req);
      const ch = db.prepare("SELECT nonce, ts FROM challenges WHERE address=?").get((address ?? "").toLowerCase());
      if (!ch || Date.now() - ch.ts > 10 * 60e3) return json(res, 400, { error: "challenge_expired" });
      const message = [
        `${SITE_DOMAIN} wants you to sign in with your wallet:`, ``, address, ``,
        `No transaction, no gas, no permissions — this signature only proves ownership.`,
        ``, `URI: ${SITE_ORIGIN}`, `Version: 1`, `Chain ID: 8453`, `Nonce: ${ch.nonce}`,
      ].join("\n");
      const recovered = verifyMessage(message, signature);
      if (recovered.toLowerCase() !== address.toLowerCase()) return json(res, 401, { error: "bad_signature" });
      db.prepare("DELETE FROM challenges WHERE address=?").run(address.toLowerCase());
      return json(res, 200, { token: issueToken(address) });
    }

    if (url.pathname === "/cabinet/users" && req.method === "POST") {
      const wallet = cabinetAuth(req);
      if (!wallet) return json(res, 401, { error: "auth" });
      const existing = db.prepare("SELECT peerId FROM users WHERE wallet=?").get(wallet);
      if (existing) {
        const me = await muxCall(`/internal/users/${wallet}`).then(r => r.json()).catch(() => null);
        return json(res, 200, { peerId: existing.peerId, buyerAddress: me?.buyerAddress });
      }
      const created = await muxCall("/internal/users", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: wallet }),
      }).then(r => r.json());
      if (!created.peerId) return json(res, 502, { error: "mux_failed", detail: created });
      db.prepare("INSERT INTO users VALUES (?,?,?)").run(wallet, created.peerId, Date.now());
      return json(res, 201, created);
    }

    // импорт существующего байера: приватник (64 hex) или adopt по адресу (0x...) если ключ в нашем кейсторе
    // ── одноразовая миграция CVM: заливка gw.db + buyer-идентичностей ──
    // Bearer MUX_INTERNAL_TOKEN. Пишет restore.db (подменяется при ребуте,
    // см. boot-блок выше), идентичности проксирует в mux /internal/import,
    // отвечает и завершает процесс — docker restart применяет restore.
    if (url.pathname === "/internal/restore-data" && req.method === "POST") {
      if ((req.headers.authorization ?? "") !== `Bearer ${MUX_TOKEN}`)
        return json(res, 401, { error: "auth" });
      let raw = ""; for await (const c of req) { raw += c; if (raw.length > 10e6) return json(res, 413, { error: "too_big" }); }
      let body; try { body = JSON.parse(raw); } catch { return json(res, 400, { error: "bad_json" }); }
      const report = { dbWritten: false, imported: 0, errors: [] };
      if (body.gwDbB64) {
        const buf = Buffer.from(String(body.gwDbB64), "base64");
        if (buf.length < 100 || buf.length > 8e6) return json(res, 400, { error: "bad_db_size" });
        writeFileSync(RESTORE_DB, buf, { mode: 0o600 });
        report.dbWritten = true;
      }
      for (const it of body.identities ?? []) {
        try {
          const r = await muxCall("/internal/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: it.userId, privateKey: it.privateKey }) });
          if (r.ok) report.imported++; else report.errors.push(`${it.userId}: mux ${r.status}`);
        } catch (e) { report.errors.push(`${it.userId}: ${String(e).slice(0, 80)}`); }
      }
      json(res, 200, { ok: true, ...report, restarting: report.dbWritten });
      if (report.dbWritten) setTimeout(() => process.exit(0), 500);
      return;
    }

    if (url.pathname === "/cabinet/import-buyer" && req.method === "POST") {
      const wallet = cabinetAuth(req);
      if (!wallet) return json(res, 401, { error: "auth" });
      let input = ""; try { input = String((await readJson(req)).input || "").trim(); } catch {}
      const isKey = /^(0x)?[0-9a-fA-F]{64}$/.test(input);
      const isAddr = /^0x[0-9a-fA-F]{40}$/.test(input);
      if (!isKey && !isAddr) return json(res, 400, { error: "paste_private_key_or_address" });
      const r = await muxCall(isKey ? "/internal/import" : "/internal/adopt", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(isKey ? { userId: wallet, privateKey: input } : { userId: wallet, address: input }),
      }).then(x => x.json()).catch(() => null);
      if (!r?.peerId) return json(res, r?.error === "address_not_in_keystore" ? 404 : 502, { error: r?.error || "mux_failed" });
      const conflict = db.prepare("SELECT wallet FROM users WHERE peerId=? AND wallet!=?").get(r.peerId, wallet);
      if (conflict) return json(res, 409, { error: "linked_to_other_wallet" });
      db.prepare("INSERT INTO users VALUES (?,?,?) ON CONFLICT(wallet) DO UPDATE SET peerId=excluded.peerId").run(wallet, r.peerId, Date.now());
      return json(res, 200, { ok: true, peerId: r.peerId, buyerAddress: r.buyerAddress });
    }

    if (url.pathname === "/cabinet/me" && req.method === "GET") {
      const wallet = cabinetAuth(req);
      if (!wallet) return json(res, 401, { error: "auth" });
      const u = db.prepare("SELECT peerId, created FROM users WHERE wallet=?").get(wallet);
      if (!u) return json(res, 200, { exists: false });
      let me = await muxCall(`/internal/users/${wallet}`).then(r => r.json()).catch(() => null);
      if (me?.error === "unknown_user") {
        await muxCall(`/internal/attach`, { method: "POST", body: JSON.stringify({ userId: wallet, peerId: u.peerId }) }).catch(() => null);
        me = await muxCall(`/internal/users/${wallet}`).then(r => r.json()).catch(() => null);
      }
      const keys = db.prepare("SELECT id, created FROM keys WHERE wallet=? AND revoked=0").all(wallet);
      const usage = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(inTok),0) inT, COALESCE(SUM(outTok),0) outT
                                FROM usage WHERE wallet=? AND ts > ?`).get(wallet, Date.now() - 30 * 24 * 3600e3);
      return json(res, 200, {
        exists: true, peerId: u.peerId, buyerAddress: me?.buyerAddress,
        balance: me?.balance ?? null, keys, usage30d: usage,
        deposit: { depositsContract: DEPOSITS_ADDR, usdc: USDC_ADDR, minUsdc: 1, note: "fresh buyer addresses are capped ~$10-15 by protocol credit limit, growing +$0.50/day" },
      });
    }

    if (url.pathname === "/cabinet/channels" && req.method === "GET") {
      const wallet = cabinetAuth(req);
      if (!wallet) return json(res, 401, { error: "auth" });
      const u = db.prepare("SELECT peerId FROM users WHERE wallet=?").get(wallet);
      if (!u) return json(res, 200, { channels: [] });
      try {
        const pdb = new Database(`/home/antseed/apex-gw/mux-data/users/${u.peerId}/payments/sessions.db`, { readonly: true, fileMustExist: true });
        const rows = pdb.prepare(`SELECT session_id, status, CAST(auth_max AS INTEGER) auth_max,
          CAST(COALESCE(settled_amount,0) AS INTEGER) settled, deadline, updated_at
          FROM payment_channels ORDER BY updated_at DESC LIMIT 20`).all();
        pdb.close();
        return json(res, 200, { channels: rows.map(r => ({
          channelId: r.session_id, status: r.status,
          authorizedUsdc: (r.auth_max / 1e6).toFixed(6),
          settledUsdc: (r.settled / 1e6).toFixed(6),
          deadline: r.deadline, updatedAt: r.updated_at,
        })) });
      } catch { return json(res, 200, { channels: [] }); }
    }

    if (url.pathname === "/cabinet/close-session" && req.method === "POST") {
      const wallet = cabinetAuth(req);
      if (!wallet) return json(res, 401, { error: "auth" });
      const r = await muxCall(`/internal/close`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: wallet }),
      }).then(x => x.json().then(j => ({ st: x.status, j }))).catch(() => null);
      if (!r) return json(res, 502, { error: "mux_unreachable" });
      return json(res, r.st, r.j);
    }

    if (url.pathname === "/cabinet/keys" && req.method === "POST") {
      const wallet = cabinetAuth(req);
      if (!wallet) return json(res, 401, { error: "auth" });
      if (!db.prepare("SELECT 1 FROM users WHERE wallet=?").get(wallet)) return json(res, 400, { error: "create_buyer_first" });
      const secret = randomBytes(24).toString("base64url");
      const id = `${KEY_PREFIX}_${secret.slice(0, 6)}`;
      const key = `${id}${secret.slice(6)}`;
      db.prepare("INSERT INTO keys VALUES (?,?,?,?,0)").run(id, wallet, sha256(key), Date.now());
      return json(res, 201, { id, key, warning: "shown once — store it" });
    }
    const kd = url.pathname.match(/^\/cabinet\/keys\/(apx_(?:[a-z]+_)?[A-Za-z0-9_-]{6})$/); // legacy apx_live_/apx_test_ и новый apx_
    if (kd && req.method === "DELETE") {
      const wallet = cabinetAuth(req);
      if (!wallet) return json(res, 401, { error: "auth" });
      db.prepare("UPDATE keys SET revoked=1 WHERE id=? AND wallet=?").run(kd[1], wallet);
      return json(res, 200, { ok: true });
    }

    if (url.pathname === "/cabinet/backup-key" && req.method === "GET") {
      const wallet = cabinetAuth(req);
      if (!wallet) return json(res, 401, { error: "auth" });
      const u = db.prepare("SELECT peerId FROM users WHERE wallet=?").get(wallet);
      if (!u) return json(res, 400, { error: "no_buyer" });
      const r = await muxCall("/internal/export-key", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ peerId: u.peerId }),
      }).then(r => r.json());
      return r.identityHex ? json(res, 200, { identityHex: r.identityHex }) : json(res, 502, { error: "mux_failed" });
    }

    // ═══ OpenAI/Venice API ═══
    if (url.pathname === "/" || url.pathname === "/healthz") {
      // dstack v0.6 gateway health-gates published ports: unknown-path 404s
      // (our previous behavior) leave the app unregistered ("not_found").
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "apex-gw" }));
      return;
    }

    if (url.pathname === "/chat" || url.pathname.startsWith("/chat/")) {
      // 2026-09-09: chat SPA is baked into THIS image at CI build time (see
      // Dockerfile.gw) — the attested image digest covers the frontend bytes.
      const STATIC_ROOT = process.env.GW_STATIC_ROOT ?? "/srv/chat";
      const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".woff2": "font/woff2", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
      try {
        const rel = decodeURIComponent(url.pathname.slice(5)).replace(/\.\./g, "");
        let fp = join(STATIC_ROOT, rel === "" || rel.endsWith("/") ? rel + "index.html" : rel);
        let data;
        try { data = readFileSync(fp); }
        catch {
          // КРИТИЧНО: SPA fallback только для беспутных html-навигаций. Запрос ассета
          // (есть расширение) должен получить 404 — иначе во время редеплоев браузер
          // кэширует index.html под видом js/css на сутки и страница ломается.
          if (/\.[a-z0-9]+$/i.test(rel)) { res.writeHead(404); res.end("asset not found"); return; }
          fp = join(STATIC_ROOT, "index.html"); data = readFileSync(fp);
        }
        const ext = fp.slice(fp.lastIndexOf("."));
        res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": ext === ".html" ? "no-cache" : "public, max-age=86400" });
        res.end(data);
      } catch {
        res.writeHead(404); res.end("chat bundle missing");
      }
      return;
    }

    if (url.pathname === "/api/v1/models" && req.method === "GET") {
      const cat = await modelsCatalog();
      const t = url.searchParams.get("type");
      if (t) return json(res, 200, { ...cat, data: cat.data.filter(m => m.type === t) });
      return json(res, 200, cat);
    }

    // venice style presets — у нас их нет; пустой список, чтобы клиент не ел 404
    if (url.pathname === "/api/v1/image/styles" && req.method === "GET") {
      // пустой список не секретный — без авторизации, чтобы не сыпать 401 в консоль
      return json(res, 200, { data: [] });
    }

    // venice-native image generation → OpenAI /v1/images/generations на нашем seller
    if (url.pathname === "/api/v1/image/generate" && req.method === "POST") {
      const ka = keyAuth(req);
      if (!ka) return json(res, 401, { error: { message: "invalid API key" } });
      { const ra = limImage("key:" + ka.keyId); if (ra) return limited(res, ra, true); }
      const u = db.prepare("SELECT peerId FROM users WHERE wallet=?").get(ka.wallet);
      if (!u) return json(res, 402, { error: { message: "no buyer — visit the site cabinet", code: "no_buyer" } });
      const v = await readJson(req);
      const oai = {
        model: v.model,
        prompt: v.prompt,
        n: Math.min(4, Math.max(1, Number(v.variants ?? 1))),
        size: v.resolution ?? (v.width && v.height ? `${v.width}x${v.height}` : undefined),
        quality: v.quality,
        output_format: v.format,
        response_format: "b64_json",
      };
      for (const k of Object.keys(oai)) if (oai[k] === undefined) delete oai[k];
      console.log(`[gw] image/generate model=${oai.model ?? "?"} wallet=${ka.wallet.slice(0, 8)}`);
      let upstream = await muxCall(`/u/${ka.wallet}/request`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-target-method": "POST",
          "x-target-path": "/v1/images/generations", "x-fwd-content-type": "application/json" },
        body: JSON.stringify(oai),
      });
      if (upstream.status === 404) {
        const ej = await upstream.clone().json().catch(() => null);
        if (ej?.error === "unknown_user") {
          await muxCall("/internal/attach", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ userId: ka.wallet, peerId: u.peerId }) });
          upstream = await muxCall(`/u/${ka.wallet}/request`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-target-method": "POST",
              "x-target-path": "/v1/images/generations", "x-fwd-content-type": "application/json" },
            body: JSON.stringify(oai),
          });
        }
      }
      if (upstream.status === 402) {
        return json(res, 402, { error: { message: "Balance empty — top up in the cabinet.", code: "insufficient_balance" },
          topup_url: `${SITE_ORIGIN}/cabinet.html` });
      }
      const oj = await upstream.json().catch(() => null);
      if (!oj) return json(res, 502, { error: { message: "bad upstream response" } });
      if (!upstream.ok) return json(res, upstream.status, oj);
      // openai → venice shape
      const imgs = (oj.data ?? []).map(d => d.b64_json ?? d.url).filter(Boolean);
      db.prepare("INSERT INTO usage VALUES (?,?,?,?,?,?,?,?,?)").run(
        randomBytes(8).toString("hex"), ka.wallet, ka.keyId, oai.model ?? "?",
        0, 0, 0, 200, Date.now());
      return json(res, 200, { images: imgs, id: String(oj.created ?? Date.now()), model: oai.model });
    }
    if (url.pathname === "/api/v1/balance" && req.method === "GET") {
      const ka = keyAuth(req);
      if (!ka) return json(res, 401, { error: { message: "invalid API key" } });
      let me = await muxCall(`/internal/users/${ka.wallet}`).then(r => r.json()).catch(() => null);
      if (me?.error === "unknown_user") {
        const u = db.prepare("SELECT peerId FROM users WHERE wallet=?").get(ka.wallet);
        if (u) {
          await muxCall(`/internal/attach`, { method: "POST", body: JSON.stringify({ userId: ka.wallet, peerId: u.peerId }) }).catch(() => null);
          me = await muxCall(`/internal/users/${ka.wallet}`).then(r => r.json()).catch(() => null);
        }
      }
      return json(res, 200, { balance: me?.balance ?? null });
    }
    // venice-native image EDIT: JSON {image: base64/data-url, prompt, model} →
    // seller path /v1/images/edits (protocol detect), edge переписывает на venice
    // /image/edit. Ответ — бинарный blob, проксируем как есть.
    if (url.pathname === "/api/v1/image/edit" && req.method === "POST") {
      const ka = keyAuth(req);
      if (!ka) return json(res, 401, { error: { message: "invalid API key" } });
      { const ra = limImage("key:" + ka.keyId); if (ra) return limited(res, ra, true); }
      const u = db.prepare("SELECT peerId FROM users WHERE wallet=?").get(ka.wallet);
      if (!u) return json(res, 402, { error: { message: "no buyer — visit the site cabinet", code: "no_buyer" } });
      let rawBody = await readRaw(req);
      let ct = String(req.headers["content-type"] ?? "application/json");
      if (ct.includes("multipart/form-data")) {
        const fields = multipartToJson(rawBody, ct);
        if (!fields) return json(res, 400, { error: { message: "bad multipart body" } });
        if (!fields.image && !fields["image[]"]) return json(res, 400, { error: { message: "image field required" } });
        if (!fields.model) return json(res, 400, { error: { message: "model field required" } });
        if (!fields.image && fields["image[]"]) fields.image = fields["image[]"];
        rawBody = Buffer.from(JSON.stringify(fields), "utf8");
        ct = "application/json";
      } else if (ct.includes("application/json")) {
        // venice-конвенция modelId → AntSeed-нода ищет строго model/service
        try {
          const j = JSON.parse(rawBody.toString("utf8"));
          if (j && !j.model && j.modelId) { j.model = j.modelId; rawBody = Buffer.from(JSON.stringify(j), "utf8"); }
        } catch {}
      }
      const callMux = () => muxCall(`/u/${ka.wallet}/request`, {
        method: "POST",
        headers: {
          "x-target-method": "POST",
          "x-target-path": "/v1/images/edits",
          "x-fwd-content-type": ct,
        },
        body: rawBody,
      });
      let upstream = await callMux();
      if (upstream.status === 404) {
        const j404 = await upstream.clone().json().catch(() => null);
        if (j404?.error === "unknown_user") {
          await muxCall("/internal/attach", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ userId: ka.wallet, peerId: u.peerId }) }).catch(() => {});
          upstream = await callMux();
        }
      }
      if (upstream.status === 402) {
        return json(res, 402, { error: { message: "Balance empty — top up in the cabinet.", code: "insufficient_balance" }, topup_url: SITE_ORIGIN + "/cabinet.html" });
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      const upCt = upstream.headers.get("content-type") ?? "";
      if (!upstream.ok || !upCt.startsWith("image/")) {
        // ошибка приходит JSON'ом — пробрасываем честно
        const ej = JSON.parse(buf.toString("utf8") || "null");
        return json(res, upstream.ok ? 502 : upstream.status, ej ?? { error: { message: "bad upstream response" } });
      }
      db.prepare("INSERT INTO usage VALUES (?,?,?,?,?,?,?,?,?)").run(
        randomBytes(8).toString("hex"), ka.wallet, ka.keyId, "image-edit", 0, 0, 0, 200, Date.now());
      res.writeHead(200, { ...cors(), "content-type": upCt, "content-length": String(buf.length) });
      return res.end(buf);
    }

    if (url.pathname === "/api/v1/chat/completions" && req.method === "POST") {
      const ka = keyAuth(req);
      if (!ka) return json(res, 401, { error: { message: "invalid API key" } });
      { const ra = limChat("key:" + ka.keyId); if (ra) return limited(res, ra, true); }
      const u = db.prepare("SELECT peerId FROM users WHERE wallet=?").get(ka.wallet);
      if (!u) return json(res, 402, { error: { message: "no buyer — visit the site cabinet", code: "no_buyer" } });

      const body = await readJson(req);
      const wantStream = !!body.stream;
      console.log(`[gw] ${req.method} ${url.pathname} model=${body.model ?? "?"} wallet=${ka.wallet.slice(0, 8)}`);
      if (wantStream) body.stream_options = { include_usage: true, ...(body.stream_options ?? {}) };

      let upstream = await muxCall(`/u/${ka.wallet}/request`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-target-method": "POST",
          "x-target-path": "/v1/chat/completions",
          "x-fwd-content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

      // self-heal: mux рестартовал и потерял маппинг wallet→peerId → reattach и ретрай
      if (upstream.status === 404) {
        const ej = await upstream.clone().json().catch(() => null);
        if (ej?.error === "unknown_user") {
          await muxCall("/internal/attach", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ userId: ka.wallet, peerId: u.peerId }),
          });
          upstream = await muxCall(`/u/${ka.wallet}/request`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-target-method": "POST",
              "x-target-path": "/v1/chat/completions",
              "x-fwd-content-type": "application/json",
            },
            body: JSON.stringify(body),
          });
        }
      }
      console.log(`[gw] upstream status ${upstream.status}`);

      if (upstream.status === 402) {
        return json(res, 402, {
          error: { message: "Balance empty — top up in the cabinet.", code: "insufficient_balance" },
          topup_url: `${SITE_ORIGIN}/cabinet.html`,
        });
      }

      // проброс ответа (стрим как стрим)
      res.writeHead(upstream.status, {
        ...cors(),
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        ...(wantStream ? { "cache-control": "no-cache", "transfer-encoding": "chunked" } : {}),
      });
      const reader = (upstream.body)?.getReader?.();
      if (!reader) { res.end(await upstream.text()); return; }

      let usage = null;
      let tail = "";
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const s = decoder.decode(value, { stream: true });
        res.write(Buffer.from(s, "utf8"));
        tail = (tail + s).slice(-4000); // usage в хвосте SSE
      }
      res.end();

      // balanced-brace extraction: usage содержит вложенные объекты (prompt_tokens_details)
      const ui = tail.lastIndexOf('"usage"');
      if (ui >= 0) {
        const b0 = tail.indexOf("{", ui);
        if (b0 > 0) {
          let depth = 0;
          for (let i = b0; i < tail.length; i++) {
            if (tail[i] === "{") depth++;
            else if (tail[i] === "}") { depth--; if (depth === 0) { try { usage = JSON.parse(tail.slice(b0, i + 1)); } catch {} break; } }
          }
        }
      }
      if (usage || !wantStream) {
        const u2 = usage ?? (() => { try { return JSON.parse(tail).usage; } catch { return null; } })();
        if (u2) db.prepare("INSERT INTO usage VALUES (?,?,?,?,?,?,?,?,?)").run(
          randomBytes(8).toString("hex"), ka.wallet, ka.keyId, body.model ?? "?",
          u2.prompt_tokens ?? 0, u2.completion_tokens ?? 0,
          u2.prompt_tokens_details?.cached_tokens ?? 0, 200, Date.now());
      }
      return;
    }

    json(res, 404, { error: "not_found" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) json(res, 502, { error: { message: msg } }); else res.end();
  }
}).listen(PORT, HOST, () => console.log(`[gw] on http://${HOST}:${PORT}`));
