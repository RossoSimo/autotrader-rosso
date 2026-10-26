// A real, separate run process with the fake broker and brain, wired exactly like `cli.ts once --fake`,
// plus knobs that let a test kill it at a precise moment.
// Usage: bun child-run.ts <root> <date> <HH:MM> [--pause-after-first] [--slow-ms N] [--huge-reasoning-mb N] [--force]
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAKE_DECISION, FakeBrain } from "../../src/brain/fake";
import { FakeBroker } from "../../src/broker/fake";
import { makePaths } from "../../src/config";
import { createLogger } from "../../src/log";
import { runOnce } from "../../src/run";
import { makeSlot } from "../../src/slots";
import type { OrderRequest } from "../../src/types";

const [root, date, time, ...rest] = process.argv.slice(2) as [string, string, string, ...string[]];
const opt = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? Number(rest[i + 1]) : 0;
};
const pauseAfterFirst = rest.includes("--pause-after-first");
const slowMs = opt("--slow-ms");
const hugeMb = opt("--huge-reasoning-mb");

const paths = makePaths(root);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class TestBroker extends FakeBroker {
  private submits = 0;
  async getAccount() {
    if (slowMs) await sleep(slowMs);
    return super.getAccount();
  }
  async submitOrder(req: OrderRequest) {
    if (slowMs) await sleep(slowMs);
    const o = await super.submitOrder(req);
    if (pauseAfterFirst && ++this.submits === 1) {
      writeFileSync(join(root, "first-order-sent"), req.clientOrderId);
      await new Promise(() => {}); // hang until the test kills us
    }
    return o;
  }
}

const answer = hugeMb ? { ...FAKE_DECISION, reasoning: "A".repeat(hugeMb * 1024 * 1024) + "." } : FAKE_DECISION;
const slot = makeSlot(date, time);
const log = createLogger(join(paths.logsDir, `run-${slot.runId}.log`), (t) => t, false);
const notifier = {
  async send(text: string) {
    appendFileSync(join(root, "messages.jsonl"), JSON.stringify({ pid: process.pid, text: text.slice(0, 2000) }) + "\n");
    return true;
  },
};

try {
  const r = await runOnce(slot, rest.includes("--force"), {
    paths,
    broker: new TestBroker(paths.fakeBroker),
    brain: new FakeBrain(answer),
    notifier,
    log,
    now: () => new Date(),
  });
  console.log(JSON.stringify({ status: r.status }));
} catch (e) {
  console.log(JSON.stringify({ status: "crashed", error: String(e) }));
  process.exit(1);
}
