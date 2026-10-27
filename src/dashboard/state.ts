import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readBaton } from "../baton";
import { MAX_TICKERS, MAX_WEIGHT, SCHEDULE_GRACE_MINUTES, SLOTS, STOP_LOSS, UNIVERSE, type Paths } from "../config";
import { readLock } from "../lock";
import { firesAt, isWeekday, makeSlot, missedSlots, nextSlot, romeNow, zonedInstant, zonedNow } from "../slots";
import type { Baton, Broker, Slot } from "../types";

export type SlotStatus = "done" | "running" | "due" | "missed" | "upcoming" | "skipped" | "off";

export interface DaySlot {
  runId: string;
  name: Slot["name"];
  label: string;
  firesAt: string;
  rome: string;
  newYork: string;
  status: SlotStatus;
}

export interface RunRow {
  runId: string;
  file: string;
  slotName: Slot["name"];
  finishedAt: string;
  equity: number;
  cash: number;
  dayPnl: number;
  positions: string[];
  sent: number;
  notSent: number;
  rejected: number;
  alerts: string[];
  summary: string;
  reasoning: string;
  planNext: string;
  ordersSubmitted: Baton["ordersSubmitted"];
  ordersRejected: Baton["ordersRejected"];
}

export interface DashboardState {
  now: string;
  fake: boolean;
  rules: { universe: readonly string[]; maxTickers: number; maxWeight: number; stopLoss: number; graceMinutes: number };
  day: {
    date: string;
    weekday: boolean;
    /** The US regular session in Rome wall-clock time for this date. */
    market: { openRome: string; closeRome: string; open: string; close: string };
    slots: DaySlot[];
  };
  next: DaySlot;
  missed: { runId: string; name: string; rome: string }[];
  lock: { state: "none" } | { state: "unreadable" } | { state: "held"; runId: string; pid: number; startedAt: string; planned: number };
  baton: { state: "missing" } | { state: "corrupt"; error: string } | { state: "ok"; runId: string };
  runs: RunRow[];
  broker:
    | { ok: false; error: string }
    | {
        ok: true;
        account: { equity: number; cash: number; lastEquity: number; buyingPower: number; status: string };
        clock: { isOpen: boolean; nextOpen: string; nextClose: string };
        positions: { symbol: string; qty: number; avgEntryPrice: number; currentPrice: number; marketValue: number; weight: number; fromCost: number }[];
        orders: { clientOrderId: string; symbol: string; side: string; qty: number; filledQty: number; filledAvgPrice: number | null; status: string; submittedAt: string }[];
      };
}

function daySlot(slot: Slot, status: SlotStatus): DaySlot {
  const at = firesAt(slot);
  return {
    runId: slot.runId,
    name: slot.name,
    label: slot.time,
    firesAt: at.toISOString(),
    rome: romeNow(at).time,
    newYork: zonedNow(at, "America/New_York").time,
    status,
  };
}

/** Every baton in history, oldest first; a --force rerun ("<runId>.2.json") sorts after its first copy. */
export function readRuns(historyDir: string): RunRow[] {
  if (!existsSync(historyDir)) return [];
  const files = readdirSync(historyDir).filter((f) => /^\d{4}-\d{2}-\d{2}-\d{4}(\.\d+)?\.json$/.test(f));
  const key = (f: string) => {
    const [id, n] = f.replace(/\.json$/, "").split(".");
    return `${id}.${String(n ?? 1).padStart(4, "0")}`;
  };
  files.sort((a, b) => (key(a) < key(b) ? -1 : 1));
  const out: RunRow[] = [];
  for (const file of files) {
    const r = readBaton(join(historyDir, file));
    if (r.kind !== "ok") continue;
    const b = r.baton;
    const sent = b.ordersSubmitted.filter((o) => o.outcome.startsWith("submitted")).length;
    out.push({
      runId: b.runId,
      file,
      slotName: b.slotName,
      finishedAt: b.finishedAt,
      equity: b.account.equity,
      cash: b.account.cash,
      dayPnl: b.account.dayPnl,
      positions: b.account.positions,
      sent,
      notSent: b.ordersSubmitted.length - sent,
      rejected: b.ordersRejected.length,
      alerts: b.alerts,
      summary: b.summary,
      reasoning: b.reasoning,
      planNext: b.planNext,
      ordersSubmitted: b.ordersSubmitted,
      ordersRejected: b.ordersRejected,
    });
  }
  return out;
}

export async function buildState(paths: Paths, broker: Broker, now: Date, opts: { fake: boolean; redact: (t: string) => string }): Promise<DashboardState> {
  const { date } = romeNow(now);
  const weekday = isWeekday(date);
  const runs = readRuns(paths.historyDir);
  const doneIds = new Set(runs.map((r) => r.runId));
  const lockRaw = readLock(paths.lock);
  const runningId = lockRaw && lockRaw !== "unreadable" ? lockRaw.runId : null;
  const read = readBaton(paths.baton);
  // The scheduler never fires a slot the baton already covers (see schedule() in cli.ts).
  const covered = read.kind === "ok" ? read.baton.runId : "";

  const statusOf = (slot: Slot): SlotStatus => {
    if (!isWeekday(slot.date)) return "off";
    if (doneIds.has(slot.runId)) return "done";
    if (slot.runId === runningId) return "running";
    const late = (now.getTime() - firesAt(slot).getTime()) / 60_000;
    if (late < 0) return slot.runId <= covered ? "skipped" : "upcoming";
    return late <= SCHEDULE_GRACE_MINUTES ? "due" : "missed";
  };
  const today = SLOTS.map((s) => makeSlot(date, s.time));
  const slots = today.map((s) => daySlot(s, statusOf(s)));

  // A slot the baton already covers (a manual early run) is skipped by the scheduler, so it is not "next".
  let upcoming = weekday ? today.find((s) => firesAt(s) > now && s.runId > covered) : undefined;
  upcoming ??= nextSlot(makeSlot(date, SLOTS[SLOTS.length - 1]!.time));

  const missed =
    read.kind === "ok"
      ? missedSlots(read.baton.runId, upcoming.runId)
          .filter((s) => !doneIds.has(s.runId) && statusOf(s) === "missed")
          .map((s) => ({ runId: s.runId, name: s.name, rome: `${s.date} ${romeNow(firesAt(s)).time}` }))
      : [];

  let brokerState: DashboardState["broker"];
  try {
    const [account, positions, orders, clock] = await Promise.all([
      broker.getAccount(),
      broker.getPositions(),
      broker.getOrders(new Date(now.getTime() - 48 * 3600_000)),
      broker.getClock(),
    ]);
    brokerState = {
      ok: true,
      account: { equity: account.equity, cash: account.cash, lastEquity: account.lastEquity, buyingPower: account.buyingPower, status: account.status },
      clock: { isOpen: clock.isOpen, nextOpen: clock.nextOpen, nextClose: clock.nextClose },
      positions: positions
        .map((p) => ({
          ...p,
          weight: account.equity ? p.marketValue / account.equity : 0,
          fromCost: p.avgEntryPrice ? p.currentPrice / p.avgEntryPrice - 1 : 0,
        }))
        .sort((a, b) => b.marketValue - a.marketValue),
      orders: orders.map(({ clientOrderId, symbol, side, qty, filledQty, filledAvgPrice, status, submittedAt }) => ({
        clientOrderId, symbol, side, qty, filledQty, filledAvgPrice, status, submittedAt,
      })),
    };
  } catch (e) {
    brokerState = { ok: false, error: opts.redact(e instanceof Error ? e.message : String(e)) };
  }

  return {
    now: now.toISOString(),
    fake: opts.fake,
    rules: { universe: UNIVERSE, maxTickers: MAX_TICKERS, maxWeight: MAX_WEIGHT, stopLoss: STOP_LOSS, graceMinutes: SCHEDULE_GRACE_MINUTES },
    day: {
      date,
      weekday,
      market: {
        open: zonedInstant(date, "09:30", "America/New_York").toISOString(),
        close: zonedInstant(date, "16:00", "America/New_York").toISOString(),
        openRome: romeNow(zonedInstant(date, "09:30", "America/New_York")).time,
        closeRome: romeNow(zonedInstant(date, "16:00", "America/New_York")).time,
      },
      slots,
    },
    next: daySlot(upcoming, "upcoming"),
    missed,
    lock:
      lockRaw === null
        ? { state: "none" }
        : lockRaw === "unreadable"
          ? { state: "unreadable" }
          : { state: "held", runId: lockRaw.runId, pid: lockRaw.pid, startedAt: lockRaw.startedAt, planned: lockRaw.planned.length },
    baton: read.kind === "ok" ? { state: "ok", runId: read.baton.runId } : read.kind === "corrupt" ? { state: "corrupt", error: read.error } : { state: "missing" },
    runs,
    broker: brokerState,
  };
}
