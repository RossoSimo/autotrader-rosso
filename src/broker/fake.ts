import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DuplicateOrderError,
  type Account,
  type Broker,
  type BrokerOrder,
  type Clock,
  type OrderRequest,
  type Position,
} from "../types";

export interface FakeState {
  cash: number;
  lastEquity: number;
  marketOpen: boolean;
  prices: Record<string, number>;
  positions: Record<string, { qty: number; avgEntryPrice: number }>;
  orders: BrokerOrder[];
}

export const DEFAULT_FAKE_STATE: FakeState = {
  cash: 100_000,
  lastEquity: 100_000,
  marketOpen: true,
  prices: { SPY: 500, QQQ: 430, IWM: 210, AAPL: 220, MSFT: 420, NVDA: 120, GLD: 230, TLT: 95, TSLA: 250, XYZ: 10 },
  positions: {},
  orders: [],
};

/** Same interface as Alpaca, persisted to a JSON file so state survives across processes. Fills market orders instantly. */
export class FakeBroker implements Broker {
  constructor(private file: string, seed: Partial<FakeState> = {}) {
    if (!existsSync(file)) this.save({ ...structuredClone(DEFAULT_FAKE_STATE), ...seed });
  }

  load(): FakeState {
    return JSON.parse(readFileSync(this.file, "utf8"));
  }

  save(s: FakeState) {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, this.file);
  }

  private equity(s: FakeState): number {
    return s.cash + Object.entries(s.positions).reduce((sum, [sym, p]) => sum + p.qty * (s.prices[sym] ?? 0), 0);
  }

  async getAccount(): Promise<Account> {
    const s = this.load();
    const equity = this.equity(s);
    return { equity, cash: s.cash, buyingPower: s.cash, lastEquity: s.lastEquity, status: "ACTIVE" };
  }

  async getPositions(): Promise<Position[]> {
    const s = this.load();
    return Object.entries(s.positions).map(([symbol, p]) => {
      const currentPrice = s.prices[symbol] ?? p.avgEntryPrice;
      return { symbol, qty: p.qty, avgEntryPrice: p.avgEntryPrice, currentPrice, marketValue: p.qty * currentPrice };
    });
  }

  async getOrders(since: Date): Promise<BrokerOrder[]> {
    return this.load().orders.filter((o) => new Date(o.submittedAt) >= since);
  }

  async getClock(): Promise<Clock> {
    const s = this.load();
    const now = new Date().toISOString();
    return { isOpen: s.marketOpen, timestamp: now, nextOpen: now, nextClose: now };
  }

  async getOrderByClientId(id: string): Promise<BrokerOrder | null> {
    return this.load().orders.find((o) => o.clientOrderId === id) ?? null;
  }

  async submitOrder(req: OrderRequest): Promise<BrokerOrder> {
    const s = this.load();
    if (s.orders.some((o) => o.clientOrderId === req.clientOrderId)) {
      throw new DuplicateOrderError(`fake broker already has an order with id ${req.clientOrderId}`);
    }
    const price = s.prices[req.symbol];
    if (price === undefined) throw new Error(`fake broker: unknown symbol ${req.symbol}`);
    const pos = s.positions[req.symbol] ?? { qty: 0, avgEntryPrice: 0 };
    if (req.side === "buy") {
      if (req.qty * price > s.cash) throw new Error("fake broker: insufficient buying power");
      pos.avgEntryPrice = (pos.qty * pos.avgEntryPrice + req.qty * price) / (pos.qty + req.qty);
      pos.qty += req.qty;
      s.cash -= req.qty * price;
    } else {
      if (req.qty > pos.qty) throw new Error("fake broker: cannot sell more than held");
      pos.qty -= req.qty;
      s.cash += req.qty * price;
    }
    if (pos.qty > 0) s.positions[req.symbol] = pos;
    else delete s.positions[req.symbol];
    const order: BrokerOrder = {
      id: crypto.randomUUID(),
      clientOrderId: req.clientOrderId,
      symbol: req.symbol,
      side: req.side,
      qty: req.qty,
      filledQty: req.qty,
      filledAvgPrice: price,
      status: "filled",
      submittedAt: new Date().toISOString(),
    };
    s.orders.push(order);
    this.save(s);
    return order;
  }

  async getLatestPrices(symbols: string[]): Promise<Record<string, number>> {
    const s = this.load();
    return Object.fromEntries(symbols.filter((x) => x in s.prices).map((x) => [x, s.prices[x]!]));
  }
}
