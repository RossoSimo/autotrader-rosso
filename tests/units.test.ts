import { describe, expect, test } from "bun:test";
import { parseDecision } from "../src/brain/schema";
import { applyCage, type CageInput } from "../src/cage";
import { assertPaperOnly } from "../src/config";
import { makeRedactor } from "../src/log";
import { dueSlot, missedSlots, nextSlot, makeSlot } from "../src/slots";

const base: CageInput = {
  proposed: [],
  slotName: "opening",
  marketOpen: true,
  account: { equity: 100_000, cash: 100_000, buyingPower: 100_000, lastEquity: 100_000, status: "ACTIVE" },
  positions: [],
  recentOrders: [],
  prices: { SPY: 500, QQQ: 400, IWM: 200, AAPL: 200, MSFT: 400, NVDA: 100 },
};
const buy = (symbol: string, qty: number) => ({ symbol, side: "buy" as const, qty, why: "x" });
const pos = (symbol: string, qty: number, avg: number, cur: number) => ({ symbol, qty, avgEntryPrice: avg, currentPrice: cur, marketValue: qty * cur });

describe("cage", () => {
  test("whole shares only, no shorts", () => {
    const r = applyCage({ ...base, proposed: [buy("SPY", 1.5), { symbol: "QQQ", side: "sell", qty: 1, why: "x" }] });
    expect(r.admitted).toHaveLength(0);
    expect(r.rejected.map((x) => x.reason)).toEqual([expect.stringContaining("no shorts"), expect.stringContaining("whole number")]);
  });

  test("no leverage", () => {
    const r = applyCage({ ...base, account: { ...base.account, cash: 1000 }, proposed: [buy("SPY", 3)] });
    expect(r.rejected[0]!.reason).toContain("no leverage");
  });

  test("max 5 tickers", () => {
    const positions = ["SPY", "QQQ", "IWM", "AAPL", "MSFT"].map((s) => pos(s, 1, 100, 100));
    const r = applyCage({ ...base, positions, proposed: [buy("NVDA", 1), buy("SPY", 1)] });
    expect(r.admitted.map((a) => a.symbol)).toEqual(["SPY"]);
    expect(r.rejected[0]!.reason).toContain("more than 5 tickers");
  });

  test("20% cap counts the existing position", () => {
    const r = applyCage({ ...base, positions: [pos("SPY", 30, 500, 500)], proposed: [buy("SPY", 11)] });
    expect(r.rejected[0]!.reason).toContain("max 20.0%");
  });

  test("stop loss at exactly -3% triggers; buying a stopped ticker is rejected", () => {
    const r = applyCage({ ...base, positions: [pos("AAPL", 5, 200, 194)], proposed: [buy("AAPL", 1)] });
    expect(r.admitted).toEqual([expect.objectContaining({ symbol: "AAPL", side: "sell", qty: 5, forced: true })]);
    expect(r.rejected[0]!.reason).toContain("under stop loss");
  });

  test("briefing rejects everything, including the stop loss", () => {
    const r = applyCage({ ...base, slotName: "briefing", positions: [pos("AAPL", 5, 200, 150)], proposed: [buy("SPY", 1)] });
    expect(r.admitted).toHaveLength(0);
    expect(r.rejected).toHaveLength(2);
  });

  test("duplicate ticker+side in one decision is rejected", () => {
    const r = applyCage({ ...base, proposed: [buy("SPY", 1), buy("SPY", 2)] });
    expect(r.admitted).toHaveLength(1);
    expect(r.rejected[0]!.reason).toContain("duplicate");
  });
});

describe("slots", () => {
  test("missed slots skip weekends", () => {
    // Friday 21:40 -> Monday 15:40: only Monday 09:00 was missed.
    expect(missedSlots("2026-09-25-2140", "2026-09-28-1540").map((s) => s.runId)).toEqual(["2026-09-28-0900"]);
  });
  test("next slot after closing is the next weekday briefing", () => {
    expect(nextSlot(makeSlot("2026-09-25", "21:40")).runId).toBe("2026-09-28-0900");
  });
  test("due slot respects the grace window (Rome time, CEST = UTC+2)", () => {
    expect(dueSlot(new Date("2026-09-24T13:45:00Z"), 30)?.runId).toBe("2026-09-24-1540");
    expect(dueSlot(new Date("2026-09-24T15:00:00Z"), 30)).toBeNull();
    expect(dueSlot(new Date("2026-09-26T13:45:00Z"), 30)).toBeNull(); // Saturday
  });
});

describe("safety", () => {
  test("refuses the live endpoint", () => {
    expect(() => assertPaperOnly(["https://api.alpaca.markets/v2"], {})).toThrow("Refusing to start");
    expect(() => assertPaperOnly([undefined], { APCA_API_BASE_URL: "https://api.alpaca.markets" })).toThrow("Refusing");
    expect(() => assertPaperOnly(["https://paper-api.alpaca.markets/v2/"], {})).not.toThrow();
  });
  test("redactor masks secrets", () => {
    expect(makeRedactor(["PKSECRET123", ""])("key=PKSECRET123 ok")).toBe("key=*** ok");
  });
  test("brain output is validated", () => {
    expect(() => parseDecision({ orders: "SPY", reasoning: "a", planNext: "b" })).toThrow();
    expect(parseDecision({ orders: [{ symbol: " spy ", side: "buy", qty: 1, why: "w" }], reasoning: "a", planNext: "b" }).orders[0]!.symbol).toBe("SPY");
  });
});
