import { readBaton, writeBaton } from "./baton";
import { applyCage } from "./cage";
import { UNIVERSE, type Paths } from "./config";
import { acquireLock, reconcile, releaseLock, updateLock, type LockData } from "./lock";
import type { Logger } from "./log";
import { buildPrompt } from "./prompt";
import { dayPnl, formatAlert, formatReport } from "./report";
import { missedSlots, nextSlot, romeFireTime } from "./slots";
import {
  DuplicateOrderError,
  type Account,
  type Baton,
  type BatonOrder,
  type Brain,
  type Broker,
  type BrokerOrder,
  type Clock,
  type Decision,
  type Notifier,
  type Position,
  type Slot,
} from "./types";

export interface RunDeps {
  paths: Paths;
  broker: Broker;
  brain: Brain;
  notifier: Notifier;
  log: Logger;
  now: () => Date;
  /** Test seam: lets a test kill the run right after an order went out. */
  afterSubmit?: (order: BrokerOrder) => void | Promise<void>;
}

export type RunResult =
  | { status: "done"; baton: Baton; alerts: string[] }
  | { status: "skipped"; reason: string }
  | { status: "locked"; reason: string };

export function clientOrderId(runId: string, symbol: string, side: string): string {
  return `${runId}-${symbol}-${side}`;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runOnce(slot: Slot, force: boolean, d: RunDeps): Promise<RunResult> {
  const { paths, broker, brain, notifier, log } = d;
  const runId = slot.runId;
  const alerts: string[] = [];
  const alert = async (lines: string[]) => {
    alerts.push(...lines);
    for (const l of lines) log.warn(`ALERT ${l}`);
    if (!(await notifier.send(formatAlert(runId, lines)))) log.warn("alert could not be delivered to Telegram");
  };

  log.info(`run ${runId} (${slot.name}) starting${force ? " with --force" : ""}`);

  const early = readBaton(paths.baton);
  if (!force && early.kind === "ok" && early.baton.runId >= runId) {
    const reason = `baton already covers run ${early.baton.runId}; use --force to redo ${runId}`;
    log.info(`skipped: ${reason}`);
    return { status: "skipped", reason };
  }

  // Step 1: lock, reconciling first if the previous run died halfway.
  const lock: LockData = { runId, pid: process.pid, startedAt: d.now().toISOString(), planned: [] };
  const acquired = acquireLock(paths.lock, lock, d.now());
  if (!acquired.ok) {
    log.warn(`not starting: ${acquired.reason}`);
    await alert([`Run not started: ${acquired.reason}.`]);
    return { status: "locked", reason: acquired.reason };
  }
  if (acquired.previous) {
    let lines: string[];
    try {
      lines = await reconcile(broker, acquired.previous);
    } catch (e) {
      lines = ["Previous run was interrupted, and reconciliation with Alpaca failed: " + errMsg(e)];
    }
    await alert(lines);
  }

  // Step 2: baton.
  const read = readBaton(paths.baton);
  const baton = read.kind === "ok" ? read.baton : null;
  let batonNote = "No previous baton: this is the first run.";
  if (read.kind === "corrupt") {
    batonNote = "The previous baton was corrupted and has been ignored.";
    await alert([`Baton is corrupted (${read.error}); treating it as no baton and relying on Alpaca only.`]);
  } else if (baton) {
    batonNote = `Previous run ${baton.runId}.`;
    const missed = missedSlots(baton.runId, runId);
    if (missed.length) {
      const shown = missed.slice(0, 12).map((s) => `${s.date} ${romeFireTime(s)} ${s.name}`);
      if (missed.length > 12) shown.push(`...and ${missed.length - 12} more`);
      await alert([
        `Missed ${missed.length} scheduled run(s) since ${baton.runId} (machine off or offline). They will not be run late:`,
        ...shown,
      ]);
    }
  }

  // Step 3: the truth about the money.
  let account: Account, positions: Position[], recentOrders: BrokerOrder[], clock: Clock;
  try {
    [account, positions, recentOrders, clock] = await Promise.all([
      broker.getAccount(),
      broker.getPositions(),
      broker.getOrders(new Date(d.now().getTime() - 48 * 3600_000)),
      broker.getClock(),
    ]);
  } catch (e) {
    await alert([`Broker error, no decision taken: ${errMsg(e)}`]);
    const failed: Decision = {
      orders: [],
      reasoning: `The run could not read the account from Alpaca (${errMsg(e)}). No decision was taken and no order was sent.`,
      planNext: baton?.planNext ?? "Read the account from Alpaca; the previous run could not reach it.",
    };
    return finish(slot, d, failed, [], [], null, alerts);
  }
  log.info(`account equity ${account.equity} cash ${account.cash}; ${positions.length} positions; market ${clock.isOpen ? "open" : "closed"}`);
  let prices: Record<string, number> = {};
  try {
    prices = await broker.getLatestPrices([...UNIVERSE]);
  } catch (e) {
    log.warn(`could not fetch prices (${errMsg(e)}); buys without a known price will be rejected`);
  }

  // Step 4: the brain.
  let decision: Decision;
  try {
    decision = await brain.decide(buildPrompt({ slot, now: d.now(), baton, batonNote, alerts, account, positions, recentOrders, clock, prices }));
    log.info(`brain proposed ${decision.orders.length} order(s): ${JSON.stringify(decision.orders)}`);
  } catch (e) {
    await alert([`Brain error: ${errMsg(e)}. Proceeding with no proposed orders; cage rules (stop loss) still apply.`]);
    decision = {
      orders: [],
      reasoning: `The brain failed (${errMsg(e)}), so no discretionary order was considered. Only the cage's automatic rules were applied.`,
      planNext: baton?.planNext ?? "Re-assess the account; the brain failed in the previous run.",
    };
  }

  // Step 5: the cage.
  const cage = applyCage({ proposed: decision.orders, slotName: slot.name, marketOpen: clock.isOpen, account, positions, recentOrders, prices });
  const rejected = cage.rejected.map((r) => ({ symbol: r.order.symbol, side: r.order.side, qty: r.order.qty, reason: r.reason }));
  for (const r of rejected) log.warn(`REJECTED ${r.side} ${r.qty} ${r.symbol}: ${r.reason}`);

  // Step 6: submit with deterministic ids.
  const submitted: BatonOrder[] = [];
  let unresolved = false;
  for (const o of cage.admitted) {
    const id = clientOrderId(runId, o.symbol, o.side);
    const rec: BatonOrder = { clientOrderId: id, symbol: o.symbol, side: o.side, qty: o.qty, why: o.why, outcome: "" };
    submitted.push(rec);
    let placed: BrokerOrder | undefined;
    try {
      const existing = await broker.getOrderByClientId(id);
      if (existing) {
        rec.outcome = `already at Alpaca (${existing.status}), not resent`;
        log.warn(`${id} already exists at Alpaca with status ${existing.status}: not resent`);
        continue;
      }
      lock.planned.push({ clientOrderId: id, symbol: o.symbol, side: o.side, qty: o.qty });
      updateLock(paths.lock, lock);
      placed = await broker.submitOrder({ symbol: o.symbol, side: o.side, qty: o.qty, clientOrderId: id });
      rec.outcome = `submitted (${placed.status})`;
      log.info(`SUBMITTED ${id} ${o.side} ${o.qty} ${o.symbol}${o.forced ? " [forced stop loss]" : ""}: ${placed.status}`);
    } catch (e) {
      if (e instanceof DuplicateOrderError) {
        rec.outcome = "rejected by Alpaca as duplicate id, not resent";
        log.warn(`${id}: ${e.message}`);
      } else if (!lock.planned.some((p) => p.clientOrderId === id)) {
        rec.outcome = `FAILED at broker, not sent: ${errMsg(e)}`;
        await alert([`Broker error before sending ${id} (it was not sent): ${errMsg(e)}`]);
      } else {
        // A timeout or 5xx says nothing about whether Alpaca kept the order: ask it.
        rec.outcome = await settleAfterError(broker, id, e, log);
        if (rec.outcome.startsWith("UNKNOWN")) unresolved = true;
        await alert([`Broker error sending ${id}: ${errMsg(e)}. Outcome: ${rec.outcome}`]);
      }
    }
    if (placed) await d.afterSubmit?.(placed);
  }

  let after: Account = account;
  try {
    after = await broker.getAccount();
  } catch (e) {
    log.warn(`could not refresh account after orders: ${errMsg(e)}`);
  }
  const held = positions.map((p) => `${p.qty} ${p.symbol}`);
  if (unresolved) await alert(["Some order outcomes are UNKNOWN: the lock is kept so the next run reconciles them with Alpaca."]);
  return finish(slot, d, decision, submitted, rejected, { account: after, positions: held }, alerts, unresolved);
}

async function settleAfterError(broker: Broker, id: string, e: unknown, log: Logger): Promise<string> {
  try {
    const found = await broker.getOrderByClientId(id);
    if (found) {
      log.warn(`${id}: send reported "${errMsg(e)}" but Alpaca has the order (${found.status})`);
      return `submitted (${found.status}), confirmed at Alpaca after a send error`;
    }
    return `FAILED at broker: ${errMsg(e)}; checked afterwards, the order is not at Alpaca`;
  } catch (e2) {
    return `UNKNOWN: send failed (${errMsg(e)}) and Alpaca could not be checked (${errMsg(e2)})`;
  }
}

async function finish(
  slot: Slot,
  d: RunDeps,
  decision: Decision,
  submitted: BatonOrder[],
  rejected: Baton["ordersRejected"],
  snap: { account: Account; positions: string[] } | null,
  alerts: string[],
  keepLock = false,
): Promise<RunResult> {
  const sent = submitted.filter((s) => s.outcome.startsWith("submitted")).length;
  const baton: Baton = {
    version: 1,
    runId: slot.runId,
    slotName: slot.name,
    finishedAt: d.now().toISOString(),
    summary:
      `${slot.name} run ${slot.runId}: ${sent} order(s) sent, ${submitted.length - sent} not sent or already present, ` +
      `${rejected.length} rejected by the cage, ${alerts.length} alert line(s).`,
    reasoning: decision.reasoning,
    planNext: decision.planNext,
    ordersSubmitted: submitted,
    ordersRejected: rejected,
    alerts,
    account: snap
      ? { equity: snap.account.equity, cash: snap.account.cash, dayPnl: dayPnl(snap.account), positions: snap.positions }
      : { equity: 0, cash: 0, dayPnl: 0, positions: ["unknown: broker unavailable"] },
  };

  // Step 7: baton, atomically.
  writeBaton(d.paths.baton, d.paths.historyDir, baton);
  d.log.info(`baton written: ${baton.summary}`);

  // Step 8: report, then release.
  const report = formatReport({ slot, submitted, rejected, reasoning: decision.reasoning, account: snap?.account ?? null, next: nextSlot(slot) });
  if (!(await d.notifier.send(report))) d.log.warn("end-of-run report could not be delivered to Telegram");
  if (keepLock) d.log.warn("lock kept on purpose: the next run will reconcile the UNKNOWN orders");
  else releaseLock(d.paths.lock);
  d.log.info(`run ${slot.runId} finished`);
  return { status: "done", baton, alerts };
}
