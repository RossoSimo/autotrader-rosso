import { MAX_TICKERS, MAX_WEIGHT, STOP_LOSS, UNIVERSE } from "./config";
import type { Account, Baton, BrokerOrder, Clock, Position, Slot } from "./types";

const SLOT_DUTY: Record<Slot["name"], string> = {
  briefing: "Read the account and set the plan for the day. Do NOT propose orders: any order will be rejected.",
  opening: "The US market just opened. Enter or adjust positions.",
  "mid-session": "Check positions mid-session; consider protecting losers.",
  // Scheduled 20 minutes before the US close, but it can start late: marketOpen and nowUtc are the truth.
  closing: "Closing run, scheduled shortly before the US close. Close out the day and write the report.",
};

export interface PromptContext {
  slot: Slot;
  now: Date;
  baton: Baton | null;
  batonNote: string;
  alerts: string[];
  account: Account;
  positions: Position[];
  recentOrders: BrokerOrder[];
  clock: Clock;
  prices: Record<string, number>;
}

export function buildPrompt(c: PromptContext): string {
  const state = {
    run: { id: c.slot.runId, name: c.slot.name, nowUtc: c.now.toISOString(), duty: SLOT_DUTY[c.slot.name] },
    marketOpen: c.clock.isOpen,
    account: c.account,
    latestPrices: c.prices,
    positions: c.positions.map((p) => ({ ...p, pnlFromCostPct: +((p.currentPrice / p.avgEntryPrice - 1) * 100).toFixed(2) })),
    ordersLast48h: c.recentOrders.map(({ clientOrderId, symbol, side, qty, filledQty, status, submittedAt }) => ({
      clientOrderId, symbol, side, qty, filledQty, status, submittedAt,
    })),
    previousRunBaton: c.baton ?? c.batonNote,
    alertsThisRun: c.alerts,
  };
  return [
    "You are the decision step of an unattended PAPER trading program. You have no tools and no memory beyond what is below.",
    "Answer only with the JSON object required by the schema. Write everything in English.",
    "- orders: each with symbol, side (buy|sell), qty (whole shares), why (one sentence). Empty array to hold.",
    "- reasoning: 3 to 5 sentences.",
    "- planNext: what the next run should check.",
    "",
    "The program enforces these rules in code and rejects anything that breaks them:",
    `universe ${UNIVERSE.join(" ")}; at most ${MAX_TICKERS} tickers; at most ${MAX_WEIGHT * 100}% of equity per ticker;`,
    `no shorts, no leverage (cash only), whole shares; no orders at the briefing or with the market closed;`,
    `positions at ${STOP_LOSS * 100}% or worse from cost basis are sold automatically.`,
    "",
    "Current state (JSON):",
    JSON.stringify(state, null, 2),
  ].join("\n");
}
