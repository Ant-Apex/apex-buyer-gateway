/**
 * ▲ Append-only лэджер списаний. JSONL per day + running hash chain.
 * Юзер может сверить свою выписку с on-chain settle и SpendingAuth metadataHash.
 * Контент промптов сюда НЕ попадает никогда — только платёжная арифметика.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LedgerRow {
  id: string;
  userId: string;
  peerId: string;
  requestId?: string;
  usdcAmount?: bigint;
  cumulativeAmount?: bigint;
  ts: number;
  prevHash?: string;
  hash?: string;
}

function dayFile(dataDir: string): string {
  const d = new Date().toISOString().slice(0, 10);
  const dir = join(dataDir, "ledger");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${d}.jsonl`);
}

function lastHash(file: string): string {
  if (!existsSync(file)) return "0".repeat(64);
  // хвост файла: последняя непустая строка
  const buf = readFileSync(file);
  let end = buf.length - 1;
  while (end >= 0 && buf[end] === 10) end--;
  if (end < 0) return "0".repeat(64);
  let start = end;
  while (start >= 0 && buf[start] !== 10) start--;
  try {
    const row = JSON.parse(buf.subarray(start + 1, end + 1).toString("utf8"));
    return row.hash ?? "0".repeat(64);
  } catch { return "0".repeat(64); }
}

export function appendLedger(dataDir: string, row: Omit<LedgerRow, "prevHash" | "hash">): void {
  const file = dayFile(dataDir);
  const prevHash = lastHash(file);
  const payload = JSON.stringify({ ...row, usdcAmount: row.usdcAmount?.toString(), cumulativeAmount: row.cumulativeAmount?.toString(), prevHash });
  const hash = createHash("sha256").update(payload).digest("hex");
  appendFileSync(file, payload.slice(0, -1) + `,"hash":"${hash}"}\n`);
}

/** Суточный корень для публичной публикации (transparency). */
export function dayRoot(dataDir: string, day: string): string | null {
  const file = join(dataDir, "ledger", `${day}.jsonl`);
  if (!existsSync(file)) return null;
  return lastHash(file);
}
