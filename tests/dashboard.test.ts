import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runOnce } from "../src/run";
import { buildState } from "../src/dashboard/state";
import { makeSlot } from "../src/slots";
import type { Broker } from "../src/types";
import { setup } from "./helpers";

const opts = { fake: true, redact: (t: string) => t };

describe("dashboard state", () => {
  test("autumn gap: market slots shown at their real Rome time, the US session an hour early", async () => {
    const t = setup();
    const s = await buildState(t.paths, t.broker, new Date("2026-10-27T13:00:00Z"), opts); // 14:00 Rome
    expect(s.day.market).toMatchObject({ openRome: "14:30", closeRome: "21:00" });
    expect(s.day.slots.map((x) => `${x.rome} ${x.status}`)).toEqual(["09:00 missed", "14:40 upcoming", "17:30 upcoming", "20:40 upcoming"]);
    expect(s.next.runId).toBe("2026-10-27-1540");
  });

  test("a slot already run early is done and not next; missed runs since the baton are listed", async () => {
    const t = setup();
    expect((await runOnce(makeSlot("2026-09-24", "09:00"), false, t.deps())).status).toBe("done");
    expect((await runOnce(makeSlot("2026-09-24", "18:30"), false, t.deps())).status).toBe("done");
    const s = await buildState(t.paths, t.broker, new Date("2026-09-24T13:00:00Z"), opts); // 15:00 Rome, before the opening
    expect(s.day.slots.map((x) => x.status)).toEqual(["done", "skipped", "done", "upcoming"]);
    expect(s.next.runId).toBe("2026-09-24-2140");

    const later = await buildState(t.paths, t.broker, new Date("2026-09-25T13:00:00Z"), opts); // next day, 15:00 Rome
    expect(later.missed.map((m) => m.runId)).toEqual(["2026-09-24-2140", "2026-09-25-0900"]);
    expect(later.runs.map((r) => r.runId)).toEqual(["2026-09-24-0900", "2026-09-24-1830"]);
  });

  test("weekend: no runs today, the next is Monday's briefing", async () => {
    const t = setup();
    const s = await buildState(t.paths, t.broker, new Date("2026-09-26T10:00:00Z"), opts);
    expect(s.day.weekday).toBe(false);
    expect(s.day.slots.every((x) => x.status === "off")).toBe(true);
    expect(s.next.runId).toBe("2026-09-28-0900");
  });

  test("a broker failure is reported in the block, redacted, and the rest still renders", async () => {
    const t = setup();
    const fail = async () => { throw new Error("network error with KEY123"); };
    const down = { getAccount: fail, getPositions: fail, getOrders: fail, getClock: fail } as unknown as Broker;
    const s = await buildState(t.paths, down, new Date("2026-09-24T13:00:00Z"), { fake: false, redact: (x) => x.replace("KEY123", "***") });
    expect(s.broker).toEqual({ ok: false, error: "network error with ***" });
    expect(s.day.slots).toHaveLength(4);
  });

  test("a corrupt history file is skipped", async () => {
    const t = setup();
    await runOnce(makeSlot("2026-09-24", "09:00"), false, t.deps());
    writeFileSync(join(t.paths.historyDir, "2026-09-24-1540.json"), "{ not json");
    const s = await buildState(t.paths, t.broker, new Date("2026-09-24T13:00:00Z"), opts);
    expect(s.runs.map((r) => r.runId)).toEqual(["2026-09-24-0900"]);
  });
});
