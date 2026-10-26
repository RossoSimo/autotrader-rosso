import { MAX_TICKERS, MAX_WEIGHT, STOP_LOSS, UNIVERSE, type SlotName } from "./config";
import type { Account, BrokerOrder, Position, ProposedOrder } from "./types";

export interface CageInput {
  proposed: ProposedOrder[];
  slotName: SlotName;
  marketOpen: boolean;
  account: Account;
  positions: Position[];
  recentOrders: BrokerOrder[];
  prices: Record<string, number>;
}

export interface AdmittedOrder extends ProposedOrder {
  forced: boolean;
}

export interface Rejection {
  order: ProposedOrder;
  reason: string;
}

export interface CageResult {
  admitted: AdmittedOrder[];
  rejected: Rejection[];
}

const TERMINAL = new Set(["filled", "canceled", "expired", "rejected", "replaced", "done_for_day", "stopped", "suspended"]);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd = (x: number) => `$${x.toFixed(2)}`;

export function stopLossTriggered(p: Position): boolean {
  return p.qty > 0 && p.avgEntryPrice > 0 && p.currentPrice / p.avgEntryPrice - 1 <= STOP_LOSS;
}

/** The model proposes, the code disposes. Pure function: same input, same verdict. */
export function applyCage(input: CageInput): CageResult {
  const { account, positions, prices } = input;
  const admitted: AdmittedOrder[] = [];
  const rejected: Rejection[] = [];
  const reject = (order: ProposedOrder, reason: string) => rejected.push({ order, reason });

  const pos = new Map(positions.filter((p) => p.qty > 0).map((p) => [p.symbol, p]));
  const open = input.recentOrders.filter((o) => !TERMINAL.has(o.status));
  const pendingQty = (sym: string, side: string) =>
    open.filter((o) => o.symbol === sym && o.side === side).reduce((s, o) => s + o.qty - o.filledQty, 0);
  const priceOf = (sym: string) => prices[sym] ?? pos.get(sym)?.currentPrice;

  const forcedSells: AdmittedOrder[] = [...pos.values()].filter(stopLossTriggered).map((p) => ({
    symbol: p.symbol,
    side: "sell" as const,
    qty: p.qty - pendingQty(p.symbol, "sell"),
    why: `Stop loss: ${pct(p.currentPrice / p.avgEntryPrice - 1)} from cost basis ${usd(p.avgEntryPrice)} (forced by the cage).`,
    forced: true,
  })).filter((o) => o.qty > 0);

  if (input.slotName === "briefing" || !input.marketOpen) {
    const reason = input.slotName === "briefing" ? "no orders during the briefing" : "market is closed";
    for (const o of input.proposed) reject(o, reason);
    for (const o of forcedSells) reject(o, `${reason}; stop loss will be retried at the next run`);
    return { admitted, rejected };
  }

  admitted.push(...forcedSells);
  const stopped = new Set(forcedSells.map((o) => o.symbol));

  // Sells first, so a ticker being closed frees its slot before buys are counted.
  const ordered = [...input.proposed].sort((a, b) => (a.side === b.side ? 0 : a.side === "sell" ? -1 : 1));
  let cashLeft =
    account.cash -
    open.filter((o) => o.side === "buy").reduce((s, o) => s + (o.qty - o.filledQty) * (priceOf(o.symbol) ?? 0), 0);

  for (const o of ordered) {
    if (!(UNIVERSE as readonly string[]).includes(o.symbol)) {
      reject(o, `${o.symbol} is not in the allowed universe`);
      continue;
    }
    if (!Number.isInteger(o.qty) || o.qty <= 0) {
      reject(o, `quantity ${o.qty} is not a positive whole number of shares`);
      continue;
    }
    if (stopped.has(o.symbol)) {
      if (o.side === "buy") reject(o, `${o.symbol} is under stop loss and is being sold`);
      // A model sell of a stopped ticker is superseded by the full forced sell: nothing to report.
      continue;
    }
    if (admitted.some((a) => a.symbol === o.symbol && a.side === o.side)) {
      reject(o, `duplicate ${o.side} of ${o.symbol} in the same run`);
      continue;
    }
    if (admitted.some((a) => a.symbol === o.symbol)) {
      reject(o, `conflicting buy and sell of ${o.symbol} in the same run`);
      continue;
    }

    if (o.side === "sell") {
      const sellable = (pos.get(o.symbol)?.qty ?? 0) - pendingQty(o.symbol, "sell");
      if (sellable <= 0) reject(o, `no ${o.symbol} position to sell (no shorts)`);
      else if (o.qty > sellable) reject(o, `would go short: only ${sellable} ${o.symbol} sellable`);
      else admitted.push({ ...o, forced: false });
      continue;
    }

    const price = priceOf(o.symbol);
    if (!price || price <= 0) {
      reject(o, `no price available for ${o.symbol}`);
      continue;
    }
    const cost = o.qty * price;
    if (cost > cashLeft) {
      reject(o, `no leverage: costs ${usd(cost)} but only ${usd(Math.max(cashLeft, 0))} cash available`);
      continue;
    }
    const exposure = (pos.get(o.symbol)?.marketValue ?? 0) + pendingQty(o.symbol, "buy") * price + cost;
    if (exposure > MAX_WEIGHT * account.equity) {
      reject(o, `${o.symbol} would be ${pct(exposure / account.equity)} of the account (max ${pct(MAX_WEIGHT)})`);
      continue;
    }
    const fullyClosed = new Set(
      admitted.filter((a) => a.side === "sell" && a.qty >= (pos.get(a.symbol)?.qty ?? 0)).map((a) => a.symbol),
    );
    const tickers = new Set([
      ...[...pos.keys()].filter((s) => !fullyClosed.has(s)),
      ...open.filter((x) => x.side === "buy").map((x) => x.symbol),
      ...admitted.filter((a) => a.side === "buy").map((a) => a.symbol),
    ]);
    if (!tickers.has(o.symbol) && tickers.size >= MAX_TICKERS) {
      reject(o, `would hold more than ${MAX_TICKERS} tickers`);
      continue;
    }
    cashLeft -= cost;
    admitted.push({ ...o, forced: false });
  }
  return { admitted, rejected };
}
