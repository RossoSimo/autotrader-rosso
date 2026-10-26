import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { LOCK_STALE_MINUTES } from "./config";
import type { Broker, Side } from "./types";

export interface PlannedOrder {
  clientOrderId: string;
  symbol: string;
  side: Side;
  qty: number;
}

export interface LockData {
  runId: string;
  pid: number;
  startedAt: string;
  /** Written before each submission, so a crash leaves a list of what might have gone out. */
  planned: PlannedOrder[];
}

export type AcquireResult =
  | { ok: true; previous: LockData | "unreadable" | null }
  | { ok: false; reason: string };

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLock(path: string): LockData | "unreadable" | null {
  if (!existsSync(path)) return null;
  try {
    const d = JSON.parse(readFileSync(path, "utf8"));
    if (typeof d?.runId !== "string" || !Array.isArray(d?.planned)) return "unreadable";
    return d;
  } catch {
    return "unreadable";
  }
}

export function acquireLock(path: string, mine: LockData, now: Date): AcquireResult {
  mkdirSync(dirname(path), { recursive: true });
  const previous = readLock(path);
  if (previous && previous !== "unreadable") {
    const ageMin = (now.getTime() - new Date(previous.startedAt).getTime()) / 60_000;
    // Our own pid means an earlier run in this same process died; runs in one process never overlap.
    if (previous.pid !== process.pid && pidAlive(previous.pid) && ageMin < LOCK_STALE_MINUTES) {
      return { ok: false, reason: `run ${previous.runId} (pid ${previous.pid}) is still running` };
    }
  }
  if (previous) rmSync(path, { force: true });
  try {
    // "wx" fails if another process created the lock between our check and now.
    const fd = openSync(path, "wx");
    writeFileSync(fd, JSON.stringify(mine, null, 2));
    closeSync(fd);
  } catch {
    return { ok: false, reason: "another run grabbed the lock at the same moment" };
  }
  return { ok: true, previous };
}

export function updateLock(path: string, data: LockData) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

export function releaseLock(path: string) {
  rmSync(path, { force: true });
}

/** Asks the broker which of the interrupted run's planned orders actually went out. */
export async function reconcile(broker: Broker, previous: LockData | "unreadable"): Promise<string[]> {
  if (previous === "unreadable") return ["The lock file was unreadable, so the planned orders are unknown; check recent orders at Alpaca."];
  const lines = [`Previous run ${previous.runId} (started ${previous.startedAt}) was interrupted.`];
  if (!previous.planned.length) lines.push("It had not planned any order yet: nothing went out.");
  for (const p of previous.planned) {
    const o = await broker.getOrderByClientId(p.clientOrderId);
    lines.push(
      o
        ? `${p.side.toUpperCase()} ${p.qty} ${p.symbol} [${p.clientOrderId}] went out: status ${o.status}, filled ${o.filledQty}.`
        : `${p.side.toUpperCase()} ${p.qty} ${p.symbol} [${p.clientOrderId}] never reached Alpaca.`,
    );
  }
  return lines;
}
