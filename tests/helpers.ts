import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeBrain } from "../src/brain/fake";
import { FakeBroker, type FakeState } from "../src/broker/fake";
import { makePaths } from "../src/config";
import { createLogger } from "../src/log";
import type { RunDeps } from "../src/run";
import type { Decision, Notifier } from "../src/types";

export class RecordingNotifier implements Notifier {
  messages: string[] = [];
  constructor(private works = true) {}
  async send(text: string) {
    this.messages.push(text);
    return this.works;
  }
}

export function setup(opts: { seed?: Partial<FakeState>; answer?: Decision; telegramWorks?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "autotrader-test-"));
  const paths = makePaths(root);
  const broker = new FakeBroker(paths.fakeBroker, opts.seed);
  const notifier = new RecordingNotifier(opts.telegramWorks ?? true);
  const logFile = join(paths.logsDir, "test.log");
  const deps = (extra: Partial<RunDeps> = {}): RunDeps => ({
    paths,
    broker,
    brain: new FakeBrain(opts.answer),
    notifier,
    log: createLogger(logFile, (t) => t, false),
    now: () => new Date("2026-09-24T13:41:00Z"),
    ...extra,
  });
  return { root, paths, broker, notifier, deps, readLog: () => readFileSync(logFile, "utf8") };
}
