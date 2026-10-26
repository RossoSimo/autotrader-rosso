import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { readLock } from "../src/lock";
import { runOnce } from "../src/run";
import { makeSlot } from "../src/slots";
import { setup } from "./helpers";

const opening = makeSlot("2026-09-24", "15:40");

describe("contract tests", () => {
  test("1. same run launched twice -> only one order per ticker", async () => {
    const t = setup();
    const first = await runOnce(opening, false, t.deps());
    expect(first.status).toBe("done");

    const second = await runOnce(opening, false, t.deps());
    expect(second.status).toBe("skipped");

    const forced = await runOnce(opening, true, t.deps());
    expect(forced.status).toBe("done");
    if (forced.status === "done") {
      expect(forced.baton.ordersSubmitted.every((o) => o.outcome.includes("already at Alpaca"))).toBe(true);
    }

    const orders = t.broker.load().orders;
    expect(orders.map((o) => o.clientOrderId).sort()).toEqual(["2026-09-24-1540-GLD-buy", "2026-09-24-1540-SPY-buy"]);
    expect(t.readLog()).toContain("not resent");
  });

  test("2. killed after the first order -> next run reconciles and does not buy again", async () => {
    const t = setup();
    const crash = t.deps({
      afterSubmit: () => {
        throw new Error("simulated kill");
      },
    });
    await expect(runOnce(opening, false, crash)).rejects.toThrow("simulated kill");
    const lock = readLock(t.paths.lock);
    expect(lock && lock !== "unreadable" && lock.planned.map((p) => p.symbol)).toEqual(["SPY"]);
    expect(existsSync(t.paths.baton)).toBe(false);

    const next = await runOnce(opening, false, t.deps());
    expect(next.status).toBe("done");
    const alert = t.notifier.messages.find((m) => m.startsWith("⚠") && m.includes("interrupted"));
    expect(alert).toContain("2026-09-24-1540-SPY-buy] went out");

    const orders = t.broker.load().orders;
    expect(orders.filter((o) => o.symbol === "SPY")).toHaveLength(1);
    expect(orders.filter((o) => o.symbol === "GLD")).toHaveLength(1);
    expect(existsSync(t.paths.lock)).toBe(false);
  });

  test("3. baton from 09:00 then nothing until 21:40 -> 15:40 and 18:30 flagged as missed", async () => {
    const t = setup();
    const brief = await runOnce(makeSlot("2026-09-24", "09:00"), false, t.deps());
    expect(brief.status).toBe("done");
    if (brief.status === "done") {
      expect(brief.baton.ordersSubmitted).toHaveLength(0);
      expect(brief.baton.ordersRejected.every((r) => r.reason.includes("briefing"))).toBe(true);
    }

    const close = await runOnce(makeSlot("2026-09-24", "21:40"), false, t.deps());
    expect(close.status).toBe("done");
    const alert = t.notifier.messages.find((m) => m.includes("Missed"))!;
    expect(alert).toStartWith("⚠ run 2026-09-24-2140");
    expect(alert).toContain("2026-09-24 15:40 opening");
    expect(alert).toContain("2026-09-24 18:30 mid-session");
    expect(alert).not.toContain("09:00");
    expect(alert).toContain("Missed 2 scheduled run(s)");
  });

  test("4. ticker outside the universe, or 40% of the account on one ticker -> rejected", async () => {
    const t = setup({
      answer: {
        orders: [
          { symbol: "XYZ", side: "buy", qty: 10, why: "Not allowed." },
          { symbol: "NVDA", side: "buy", qty: 334, why: "Way too big (40%)." },
          { symbol: "AAPL", side: "buy", qty: 10, why: "Fine." },
        ],
        reasoning: "Testing the cage. Two of these must fail.",
        planNext: "Nothing.",
      },
    });
    const r = await runOnce(opening, false, t.deps());
    expect(r.status).toBe("done");
    if (r.status !== "done") return;
    const reasons = Object.fromEntries(r.baton.ordersRejected.map((x) => [x.symbol, x.reason]));
    expect(reasons.XYZ).toContain("not in the allowed universe");
    expect(reasons.NVDA).toContain("max 20.0%");
    expect(t.broker.load().orders.map((o) => o.symbol)).toEqual(["AAPL"]);
    const report = t.notifier.messages.at(-1)!;
    expect(report).toContain("XYZ: XYZ is not in the allowed universe");
    expect(report).toContain("NVDA: NVDA would be");
    expect(t.readLog()).toContain("REJECTED buy 10 XYZ");
  });

  test("5. position at -4% -> the cage sells it even if the model says hold", async () => {
    const t = setup({
      seed: {
        cash: 90_000,
        positions: { SPY: { qty: 20, avgEntryPrice: 500 } },
        prices: { SPY: 480, GLD: 230 },
      },
      answer: { orders: [], reasoning: "Hold everything. Nothing to do.", planNext: "Check SPY." },
    });
    const r = await runOnce(opening, false, t.deps());
    expect(r.status).toBe("done");
    const orders = t.broker.load().orders;
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ symbol: "SPY", side: "sell", qty: 20, clientOrderId: "2026-09-24-1540-SPY-sell" });
    expect(t.broker.load().positions.SPY).toBeUndefined();
    expect(t.notifier.messages.at(-1)).toContain("Stop loss: -4.0%");
  });

  test("6. corrupted baton -> counts as no baton, run proceeds with the broker", async () => {
    const t = setup();
    mkdirSync(dirname(t.paths.baton), { recursive: true });
    writeFileSync(t.paths.baton, '{"version": 1, "runId": "2026-09-2');
    const r = await runOnce(opening, false, t.deps());
    expect(r.status).toBe("done");
    expect(t.notifier.messages.some((m) => m.startsWith("⚠") && m.includes("corrupted"))).toBe(true);
    expect(t.broker.load().orders).toHaveLength(2);
    expect(JSON.parse(readFileSync(t.paths.baton, "utf8")).runId).toBe("2026-09-24-1540");
    expect(readdirSync(t.paths.historyDir)).toEqual(["2026-09-24-1540.json"]);
  });
});

describe("other guarantees", () => {
  test("market closed -> no orders, but the run completes", async () => {
    const t = setup({ seed: { marketOpen: false } });
    const r = await runOnce(opening, false, t.deps());
    expect(r.status).toBe("done");
    expect(t.broker.load().orders).toHaveLength(0);
    expect(t.notifier.messages.at(-1)).toContain("market is closed");
  });

  test("Telegram down -> the run still finishes and writes it in the log", async () => {
    const t = setup({ telegramWorks: false });
    const r = await runOnce(opening, false, t.deps());
    expect(r.status).toBe("done");
    expect(existsSync(t.paths.lock)).toBe(false);
    expect(t.readLog()).toContain("could not be delivered to Telegram");
  });

  test("brain failure -> alert, no discretionary orders, stop loss still applies", async () => {
    const t = setup({ seed: { cash: 90_000, positions: { TLT: { qty: 10, avgEntryPrice: 100 } }, prices: { TLT: 95 } } });
    const failing = { decide: async (): Promise<never> => { throw new Error("model timeout"); } };
    const r = await runOnce(opening, false, t.deps({ brain: failing }));
    expect(r.status).toBe("done");
    expect(t.notifier.messages.some((m) => m.startsWith("⚠") && m.includes("Brain error: model timeout"))).toBe(true);
    expect(t.broker.load().orders.map((o) => `${o.side} ${o.symbol}`)).toEqual(["sell TLT"]);
  });

  test("every message carries the run id", async () => {
    const t = setup();
    mkdirSync(dirname(t.paths.baton), { recursive: true });
    writeFileSync(t.paths.baton, "garbage");
    await runOnce(opening, false, t.deps());
    expect(t.notifier.messages.length).toBeGreaterThan(1);
    for (const m of t.notifier.messages) expect(m).toContain("run 2026-09-24-1540");
  });
});
