// Devil's-advocate tests: real processes, real kills, real races. Fake broker and brain throughout.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBaton } from "../src/baton";
import { ClaudeBrain } from "../src/brain/claude";
import { AlpacaBroker } from "../src/broker/alpaca";
import { FakeBroker } from "../src/broker/fake";
import { makePaths } from "../src/config";
import { readLock } from "../src/lock";
import { runOnce } from "../src/run";
import { dueSlot, makeSlot } from "../src/slots";
import type { BrokerOrder, OrderRequest } from "../src/types";
import { setup } from "./helpers";

const CHILD = join(import.meta.dir, "fixtures", "child-run.ts");
const FAKE_CLAUDE = join(import.meta.dir, "fixtures", "fake-claude.ts");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "autotrader-adv-"));
  const paths = makePaths(root);
  const broker = new FakeBroker(paths.fakeBroker); // seeded before any child starts
  const messages = () =>
    existsSync(join(root, "messages.jsonl"))
      ? readFileSync(join(root, "messages.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).text as string)
      : [];
  return { root, paths, broker, messages };
}

function spawnRun(root: string, time: string, ...flags: string[]) {
  return Bun.spawn(["bun", CHILD, root, "2026-09-24", time, ...flags], { stdout: "pipe", stderr: "pipe" });
}

async function result(p: ReturnType<typeof spawnRun>): Promise<string> {
  const out = await new Response(p.stdout).text();
  await p.exited;
  const last = out.trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(last).status;
  } catch {
    return `no-result (exit ${p.exitCode}): ${out.slice(-300)} ${await new Response(p.stderr).text()}`;
  }
}

async function waitFor(cond: () => boolean, ms: number, what: string) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(2);
  }
}

async function deadPid(): Promise<number> {
  const p = Bun.spawn(["bun", "-e", "0"]);
  await p.exited;
  return p.pid;
}

describe("1. killed by PID right after the first order", () => {
  test("relaunch reconciles and the broker ends with exactly one order per ticker", async () => {
    const s = sandbox();
    const victim = spawnRun(s.root, "15:40", "--pause-after-first");
    await waitFor(() => existsSync(join(s.root, "first-order-sent")), 15_000, "first order");
    process.kill(victim.pid, "SIGKILL");
    await victim.exited;

    expect(s.broker.load().orders.map((o) => o.clientOrderId)).toEqual(["2026-09-24-1540-SPY-buy"]);
    const lock = readLock(s.paths.lock);
    expect(lock !== null && lock !== "unreadable" && lock.pid).toBe(victim.pid);

    expect(await result(spawnRun(s.root, "15:40"))).toBe("done");
    const ids = s.broker.load().orders.map((o) => o.clientOrderId).sort();
    expect(ids).toEqual(["2026-09-24-1540-GLD-buy", "2026-09-24-1540-SPY-buy"]);
    const alert = s.messages().find((m) => m.includes("interrupted"))!;
    expect(alert).toContain("SPY-buy] went out");
    expect(existsSync(s.paths.lock)).toBe(false);
  }, 30_000);
});

describe("2. two launches of the same slot", () => {
  test("half a second apart while the first is still running: one runs, the other is refused", async () => {
    const s = sandbox();
    const a = spawnRun(s.root, "15:40", "--slow-ms", "800");
    await sleep(500);
    const b = spawnRun(s.root, "15:40", "--slow-ms", "800");
    const statuses = (await Promise.all([result(a), result(b)])).sort();
    expect(statuses).toEqual(["done", "locked"]);
    expect(s.broker.load().orders).toHaveLength(2);
  }, 30_000);

  test("launched together over a dead run's lock: still only one gets through", async () => {
    // The dangerous case: both see a stale lock and both try to take it over.
    for (let round = 0; round < 3; round++) {
      const s = sandbox();
      const pid = await deadPid();
      writeFileSync(s.paths.lock, JSON.stringify({ runId: "2026-09-24-0900", pid, startedAt: new Date().toISOString(), planned: [] }));
      const runs = Array.from({ length: 6 }, () => spawnRun(s.root, "15:40", "--slow-ms", "300"));
      const statuses = await Promise.all(runs.map(result));
      expect(statuses.filter((x) => x === "done")).toHaveLength(1);
      expect(statuses.filter((x) => x !== "done").every((x) => x === "locked" || x === "skipped")).toBe(true);
      expect(s.broker.load().orders).toHaveLength(2);
    }
  }, 120_000);

  test("second launch arriving just after the first finished does not redo the run", async () => {
    const s = sandbox();
    expect(await result(spawnRun(s.root, "15:40"))).toBe("done");
    expect(await result(spawnRun(s.root, "15:40"))).toBe("skipped");
    expect(s.messages().filter((m) => m.startsWith("run 2026-09-24-1540"))).toHaveLength(1);
  }, 30_000);
});

describe("3. broker times out during the send", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("the real Alpaca client gives up on a 30 s hang instead of hanging the run, without leaking keys", async () => {
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(new Response("{}")), 30_000);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(init.signal!.reason);
        });
      })) as typeof fetch;
    const broker = new AlpacaBroker("PKKEYID1234", "SECRETSECRET99");
    const started = Date.now();
    const err: Error = await broker.submitOrder({ symbol: "SPY", side: "buy", qty: 1, clientOrderId: "x" }).then(
      () => new Error("expected a rejection"),
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(err.message).not.toContain("PKKEYID1234");
    expect(err.message).not.toContain("SECRETSECRET99");
  }, 40_000);

  class TimeoutBroker extends FakeBroker {
    constructor(file: string, private mode: "order-landed" | "never-arrived" | "broker-gone") {
      super(file);
    }
    gone = false;
    async submitOrder(req: OrderRequest): Promise<BrokerOrder> {
      if (this.mode === "order-landed") await super.submitOrder(req); // Alpaca got it, the response was lost
      if (this.mode === "broker-gone") this.gone = true;
      throw new Error("Alpaca POST /orders: network error (TimeoutError)");
    }
    async getOrderByClientId(id: string) {
      if (this.gone) throw new Error("Alpaca GET order: network error (TimeoutError)");
      return super.getOrderByClientId(id);
    }
  }

  test("order landed but the response timed out: reported as sent, not as failed", async () => {
    const t = setup();
    const broker = new TimeoutBroker(t.paths.fakeBroker, "order-landed");
    const r = await runOnce(makeSlot("2026-09-24", "15:40"), false, t.deps({ broker }));
    expect(r.status).toBe("done");
    if (r.status !== "done") return;
    expect(broker.load().orders).toHaveLength(2);
    for (const o of r.baton.ordersSubmitted) expect(o.outcome).not.toContain("FAILED");
    expect(t.notifier.messages.at(-1)).not.toContain("FAILED");
  });

  test("order never arrived: reported as not sent, after checking Alpaca", async () => {
    const t = setup();
    const broker = new TimeoutBroker(t.paths.fakeBroker, "never-arrived");
    const r = await runOnce(makeSlot("2026-09-24", "15:40"), false, t.deps({ broker }));
    expect(r.status).toBe("done");
    if (r.status !== "done") return;
    expect(broker.load().orders).toHaveLength(0);
    for (const o of r.baton.ordersSubmitted) expect(o.outcome).toContain("not at Alpaca");
  });

  test("broker gone even for the check: outcome is UNKNOWN and the next run reconciles it", async () => {
    const t = setup();
    const broker = new TimeoutBroker(t.paths.fakeBroker, "broker-gone");
    const r = await runOnce(makeSlot("2026-09-24", "15:40"), false, t.deps({ broker }));
    expect(r.status).toBe("done");
    if (r.status !== "done") return;
    // SPY was sent into the void: unknown. GLD's pre-send check already failed, so it provably never left.
    const [spy, gld] = r.baton.ordersSubmitted;
    expect(spy!.outcome).toContain("UNKNOWN");
    expect(gld!.outcome).toContain("not sent");
    const lock = readLock(t.paths.lock);
    expect(lock !== null && lock !== "unreadable" && lock.planned.map((p) => p.symbol)).toEqual(["SPY"]);

    const next = await runOnce(makeSlot("2026-09-24", "18:30"), false, t.deps());
    expect(next.status).toBe("done");
    expect(t.notifier.messages.some((m) => m.includes("SPY-buy] never reached Alpaca"))).toBe(true);
  });
});

describe("4. the model answers badly (real ClaudeBrain parsing, stand-in claude binary)", () => {
  function brainSaying(stdout: string, exitCode = 0) {
    const file = join(mkdtempSync(join(tmpdir(), "fake-claude-")), "out.txt");
    writeFileSync(file, stdout);
    return new ClaudeBrain(undefined, ["bun", FAKE_CLAUDE, file, String(exitCode)]);
  }
  const envelope = (structured: unknown) => JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "", structured_output: structured });

  test("truncated JSON: brain error alert, no orders, run completes", async () => {
    const t = setup();
    const brain = brainSaying(envelope({ orders: [{ symbol: "SPY", side: "buy", qty: 10, why: "x" }], reasoning: "r", planNext: "p" }).slice(0, 60));
    const r = await runOnce(makeSlot("2026-09-24", "15:40"), false, t.deps({ brain }));
    expect(r.status).toBe("done");
    expect(t.broker.load().orders).toHaveLength(0);
    expect(t.notifier.messages.some((m) => m.startsWith("⚠") && m.includes("Brain error"))).toBe(true);
  });

  test("missing field: brain error alert, no orders, previous plan carried forward", async () => {
    const t = setup();
    const brain = brainSaying(envelope({ orders: [{ symbol: "SPY", side: "buy", qty: 10, why: "x" }], reasoning: "r" }));
    const r = await runOnce(makeSlot("2026-09-24", "15:40"), false, t.deps({ brain }));
    expect(r.status).toBe("done");
    expect(t.broker.load().orders).toHaveLength(0);
    expect(t.notifier.messages.some((m) => m.includes("planNext missing"))).toBe(true);
  });

  test("negative quantity: that order is rejected with a reason, the valid one goes through", async () => {
    const t = setup();
    const brain = brainSaying(
      envelope({
        orders: [
          { symbol: "SPY", side: "buy", qty: -5, why: "bad" },
          { symbol: "GLD", side: "buy", qty: 5, why: "good" },
        ],
        reasoning: "One bad, one good.",
        planNext: "p",
      }),
    );
    const r = await runOnce(makeSlot("2026-09-24", "15:40"), false, t.deps({ brain }));
    expect(r.status).toBe("done");
    if (r.status !== "done") return;
    expect(t.broker.load().orders.map((o) => o.symbol)).toEqual(["GLD"]);
    expect(r.baton.ordersRejected[0]).toMatchObject({ symbol: "SPY", qty: -5 });
    expect(r.baton.ordersRejected[0]!.reason).toContain("not a positive whole number");
  });

  test("claude exits non-zero: brain error alert, run completes", async () => {
    const t = setup();
    const r = await runOnce(makeSlot("2026-09-24", "15:40"), false, t.deps({ brain: brainSaying("rate limited", 1) }));
    expect(r.status).toBe("done");
    expect(t.notifier.messages.some((m) => m.includes("Brain error: claude exited with code 1"))).toBe(true);
  });
});

describe("5. killed while writing state/baton.json", () => {
  test("the baton on disk is never half-written, and the relaunch does not duplicate orders", async () => {
    const s = sandbox();
    expect(await result(spawnRun(s.root, "09:00"))).toBe("done");
    const before = readFileSync(s.paths.baton, "utf8");

    // A huge reasoning makes the baton write take long enough to kill the process in the middle of it.
    const victim = spawnRun(s.root, "15:40", "--huge-reasoning-mb", "150");
    await waitFor(() => existsSync(`${s.paths.baton}.tmp`), 60_000, "baton write to start");
    process.kill(victim.pid, "SIGKILL");
    await victim.exited;

    const after = readBaton(s.paths.baton);
    expect(after.kind).toBe("ok"); // either the old one or the new one, never garbage
    if (after.kind === "ok" && after.baton.runId === "2026-09-24-0900") expect(readFileSync(s.paths.baton, "utf8")).toBe(before);
    expect(s.broker.load().orders).toHaveLength(2);

    const status = await result(spawnRun(s.root, "15:40", "--force"));
    expect(status).toBe("done");
    expect(s.broker.load().orders).toHaveLength(2);
    expect(readBaton(s.paths.baton).kind).toBe("ok");
    expect(existsSync(s.paths.lock)).toBe(false);
  }, 90_000);
});

describe("6. the 21:40 run starts at 22:05 with the market closed", () => {
  const at2205 = new Date("2026-09-24T20:05:00Z"); // 22:05 in Rome (CEST)

  test("the scheduler still fires it (inside the grace window)", () => {
    expect(dueSlot(at2205, 30)?.runId).toBe("2026-09-24-2140");
  });

  test("no orders, not even the stop loss; the report says why; the model is not told a false time", async () => {
    const t = setup({
      seed: { marketOpen: false, cash: 90_000, positions: { TSLA: { qty: 10, avgEntryPrice: 300 } }, prices: { TSLA: 250, SPY: 500, GLD: 230 } },
    });
    let prompt = "";
    const brain = {
      decide: async (p: string) => {
        prompt = p;
        return { orders: [{ symbol: "SPY", side: "buy" as const, qty: 1, why: "x" }], reasoning: "Late run.", planNext: "p" };
      },
    };
    const r = await runOnce(makeSlot("2026-09-24", "21:40"), false, t.deps({ brain, now: () => at2205 }));
    expect(r.status).toBe("done");
    if (r.status !== "done") return;
    expect(t.broker.load().orders).toHaveLength(0);
    expect(r.baton.ordersRejected.map((x) => x.symbol).sort()).toEqual(["SPY", "TSLA"]);
    expect(r.baton.ordersRejected.every((x) => x.reason.includes("market is closed"))).toBe(true);
    expect(t.notifier.messages.at(-1)).toContain("market is closed");
    expect(prompt).toContain('"marketOpen": false');
    expect(prompt).not.toContain("closes in 20 minutes");
  });
});
