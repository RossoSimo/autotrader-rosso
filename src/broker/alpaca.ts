import { DATA_BASE_URL, PAPER_BASE_URL } from "../config";
import {
  DuplicateOrderError,
  type Account,
  type Broker,
  type BrokerOrder,
  type Clock,
  type OrderRequest,
  type Position,
} from "../types";

const TIMEOUT_MS = 15_000;

export class AlpacaBroker implements Broker {
  constructor(private keyId: string, private secretKey: string) {
    if (!keyId || !secretKey) throw new Error("Alpaca keys missing in secrets.ts");
  }

  private async call(base: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
    let res: Response;
    try {
      res = await fetch(base + path, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          "APCA-API-KEY-ID": this.keyId,
          "APCA-API-SECRET-KEY": this.secretKey,
          "Content-Type": "application/json",
        },
      });
    } catch (e) {
      // Only the path and the error name: never the request, which carries the keys.
      throw new Error(`Alpaca ${init.method ?? "GET"} ${path}: network error (${(e as Error).name})`);
    }
    const text = await res.text();
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, body };
  }

  private async get(path: string, base = PAPER_BASE_URL): Promise<any> {
    const r = await this.call(base, path);
    if (r.status >= 400) throw new Error(`Alpaca GET ${path}: HTTP ${r.status} ${brief(r.body)}`);
    return r.body;
  }

  async getAccount(): Promise<Account> {
    const a = await this.get("/account");
    return {
      equity: +a.equity,
      cash: +a.cash,
      buyingPower: +a.buying_power,
      lastEquity: +a.last_equity,
      status: a.status,
    };
  }

  async getPositions(): Promise<Position[]> {
    const ps: any[] = await this.get("/positions");
    return ps.map((p) => ({
      symbol: p.symbol,
      qty: +p.qty,
      avgEntryPrice: +p.avg_entry_price,
      currentPrice: +p.current_price,
      marketValue: +p.market_value,
    }));
  }

  async getOrders(since: Date): Promise<BrokerOrder[]> {
    const q = new URLSearchParams({ status: "all", after: since.toISOString(), limit: "500", direction: "desc" });
    const os: any[] = await this.get(`/orders?${q}`);
    return os.map(toOrder);
  }

  async getClock(): Promise<Clock> {
    const c = await this.get("/clock");
    return { isOpen: !!c.is_open, timestamp: c.timestamp, nextOpen: c.next_open, nextClose: c.next_close };
  }

  async getOrderByClientId(clientOrderId: string): Promise<BrokerOrder | null> {
    const path = `/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`;
    const r = await this.call(PAPER_BASE_URL, path);
    if (r.status === 404) return null;
    if (r.status >= 400) throw new Error(`Alpaca GET order ${clientOrderId}: HTTP ${r.status} ${brief(r.body)}`);
    return toOrder(r.body);
  }

  async submitOrder(req: OrderRequest): Promise<BrokerOrder> {
    const r = await this.call(PAPER_BASE_URL, "/orders", {
      method: "POST",
      body: JSON.stringify({
        symbol: req.symbol,
        qty: String(req.qty),
        side: req.side,
        type: "market",
        time_in_force: "day",
        client_order_id: req.clientOrderId,
      }),
    });
    if (r.status === 422 && /client_order_id/i.test(brief(r.body))) {
      throw new DuplicateOrderError(`Alpaca already has an order with id ${req.clientOrderId}`);
    }
    if (r.status >= 400) throw new Error(`Alpaca rejected ${req.clientOrderId}: HTTP ${r.status} ${brief(r.body)}`);
    return toOrder(r.body);
  }

  async getLatestPrices(symbols: string[]): Promise<Record<string, number>> {
    if (!symbols.length) return {};
    const q = new URLSearchParams({ symbols: symbols.join(","), feed: "iex" });
    const body = await this.get(`/stocks/trades/latest?${q}`, DATA_BASE_URL);
    const out: Record<string, number> = {};
    for (const [sym, t] of Object.entries<any>(body?.trades ?? {})) out[sym] = +t.p;
    return out;
  }
}

function toOrder(o: any): BrokerOrder {
  return {
    id: o.id,
    clientOrderId: o.client_order_id,
    symbol: o.symbol,
    side: o.side,
    qty: +o.qty,
    filledQty: +(o.filled_qty ?? 0),
    filledAvgPrice: o.filled_avg_price == null ? null : +o.filled_avg_price,
    status: o.status,
    submittedAt: o.submitted_at,
  };
}

function brief(body: unknown): string {
  const s = typeof body === "string" ? body : JSON.stringify(body);
  return (s ?? "").slice(0, 200);
}
