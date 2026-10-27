import type { SlotName } from "./config";

export type Side = "buy" | "sell";

export interface Account {
  equity: number;
  cash: number;
  buyingPower: number;
  lastEquity: number;
  status: string;
}

export interface Position {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
}

export interface BrokerOrder {
  id: string;
  clientOrderId: string;
  symbol: string;
  side: Side;
  qty: number;
  filledQty: number;
  filledAvgPrice: number | null;
  status: string;
  submittedAt: string;
}

export interface Clock {
  isOpen: boolean;
  timestamp: string;
  nextOpen: string;
  nextClose: string;
}

export interface OrderRequest {
  symbol: string;
  side: Side;
  qty: number;
  clientOrderId: string;
}

/** Thrown when the broker refuses a client_order_id it has already seen. */
export class DuplicateOrderError extends Error {}

export interface Broker {
  getAccount(): Promise<Account>;
  getPositions(): Promise<Position[]>;
  getOrders(since: Date): Promise<BrokerOrder[]>;
  getClock(): Promise<Clock>;
  getOrderByClientId(clientOrderId: string): Promise<BrokerOrder | null>;
  submitOrder(req: OrderRequest): Promise<BrokerOrder>;
  getLatestPrices(symbols: string[]): Promise<Record<string, number>>;
}

export interface ProposedOrder {
  symbol: string;
  side: Side;
  qty: number;
  why: string;
}

export interface Decision {
  orders: ProposedOrder[];
  reasoning: string;
  planNext: string;
}

export interface Brain {
  decide(prompt: string): Promise<Decision>;
}

export interface Notifier {
  /** Must never throw: returns false if the message did not go through. */
  send(text: string): Promise<boolean>;
}

export interface Slot {
  date: string; // YYYY-MM-DD, Rome
  time: string; // HH:MM slot label (usual Rome time; see SLOTS for when it really fires)
  name: SlotName;
  runId: string; // YYYY-MM-DD-HHMM
}

export interface BatonOrder {
  clientOrderId: string;
  symbol: string;
  side: Side;
  qty: number;
  why: string;
  outcome: string;
}

export interface Baton {
  version: 1;
  runId: string;
  slotName: SlotName;
  finishedAt: string;
  summary: string;
  reasoning: string;
  planNext: string;
  ordersSubmitted: BatonOrder[];
  ordersRejected: { symbol: string; side: string; qty: number; reason: string }[];
  alerts: string[];
  account: { equity: number; cash: number; dayPnl: number; positions: string[] };
}
