import { join, resolve } from "node:path";
import { readBaton } from "./baton";
import { ClaudeBrain } from "./brain/claude";
import { FakeBrain } from "./brain/fake";
import { AlpacaBroker } from "./broker/alpaca";
import { FakeBroker } from "./broker/fake";
import { assertPaperOnly, makePaths, SCHEDULE_GRACE_MINUTES } from "./config";
import { readLock } from "./lock";
import { createLogger, makeRedactor, type Logger } from "./log";
import { formatAlert } from "./report";
import { runOnce } from "./run";
import { loadSecrets, secretValues, type Secrets } from "./secrets-loader";
import { dueSlot, latestSlotToday, makeSlot, romeNow } from "./slots";
import { LogNotifier, TelegramNotifier } from "./telegram";
import type { Broker, Notifier } from "./types";

const ROOT = resolve(import.meta.dir, "..");
const paths = makePaths(ROOT);

function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  const flag = (name: string) => rest.includes(name);
  const value = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  return { command, fake: flag("--fake"), force: flag("--force"), slot: value("--slot") };
}

function makeBroker(fake: boolean, s: Secrets): Broker {
  return fake ? new FakeBroker(paths.fakeBroker) : new AlpacaBroker(s.alpacaKeyId, s.alpacaSecretKey);
}

function makeNotifier(s: Secrets, log: Logger): Notifier {
  return s.telegramBotToken && s.telegramChatId ? new TelegramNotifier(s.telegramBotToken, s.telegramChatId, log) : new LogNotifier(log);
}

async function once(args: ReturnType<typeof parseArgs>, secrets: Secrets, redact: (t: string) => string): Promise<number> {
  const now = new Date();
  const slot = args.slot ? makeSlot(romeNow(now).date, args.slot) : latestSlotToday(now);
  if (!slot) {
    console.log("No scheduled run yet today (the first is at 09:00 Rome). Use --slot to choose one.");
    return 1;
  }
  const log = createLogger(join(paths.logsDir, `run-${slot.runId}.log`), redact);
  const notifier = makeNotifier(secrets, log);
  let broker: Broker;
  try {
    broker = makeBroker(args.fake, secrets);
  } catch (e) {
    log.error(`configuration error, run not started: ${(e as Error).message}`);
    await notifier.send(formatAlert(slot.runId, [`Run not started: ${(e as Error).message}`]));
    return 1;
  }
  try {
    const result = await runOnce(slot, args.force, {
      paths,
      broker,
      brain: args.fake ? new FakeBrain() : new ClaudeBrain(process.env.CLAUDE_MODEL),
      notifier,
      log,
      now: () => new Date(),
    });
    if (result.status !== "done") console.log(`${result.status}: ${result.reason}`);
    return result.status === "locked" ? 1 : 0;
  } catch (e) {
    // The lock stays on purpose: the next run will find it and reconcile with Alpaca.
    const msg = redact(e instanceof Error ? e.stack ?? e.message : String(e));
    log.error(`run crashed: ${msg}`);
    await notifier.send(formatAlert(slot.runId, [`Run crashed: ${msg.split("\n")[0]}`, "The lock was left in place; the next run will reconcile."]));
    return 1;
  }
}

async function schedule(args: ReturnType<typeof parseArgs>, redact: (t: string) => string) {
  const log = createLogger(join(paths.logsDir, "scheduler.log"), redact);
  log.info(`scheduler started${args.fake ? " (fake)" : ""}; checking every 30 seconds`);
  const attempted = new Set<string>();
  let running = false;
  const tick = async () => {
    if (running) return;
    const slot = dueSlot(new Date(), SCHEDULE_GRACE_MINUTES);
    if (!slot || attempted.has(slot.runId)) return;
    const b = readBaton(paths.baton);
    if (b.kind === "ok" && b.baton.runId >= slot.runId) return;
    attempted.add(slot.runId);
    running = true;
    log.info(`launching run ${slot.runId} (${slot.name})`);
    // Each run is a fresh process, so it starts with no memory.
    const cmd = ["bun", join(ROOT, "src", "cli.ts"), "once", "--slot", slot.time, ...(args.fake ? ["--fake"] : [])];
    const proc = Bun.spawn(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
    const code = await proc.exited;
    log.info(`run ${slot.runId} exited with code ${code}`);
    running = false;
  };
  await tick();
  setInterval(() => void tick(), 30_000);
}

async function status(args: ReturnType<typeof parseArgs>, secrets: Secrets, redact: (t: string) => string) {
  const lock = readLock(paths.lock);
  console.log("Lock:", lock === null ? "none" : lock === "unreadable" ? "present but unreadable" : `run ${lock.runId}, pid ${lock.pid}, started ${lock.startedAt}, ${lock.planned.length} planned order(s)`);
  const b = readBaton(paths.baton);
  if (b.kind === "ok") {
    console.log(`Last baton: ${b.baton.runId} (${b.baton.slotName}), finished ${b.baton.finishedAt}`);
    console.log(`  ${b.baton.summary}`);
    console.log(`  Plan next: ${b.baton.planNext}`);
  } else console.log("Last baton:", b.kind === "missing" ? "none" : `corrupted (${b.error})`);
  try {
    const broker = makeBroker(args.fake, secrets);
    const [a, ps, c] = await Promise.all([broker.getAccount(), broker.getPositions(), broker.getClock()]);
    console.log(`Account${args.fake ? " (fake)" : ""}: equity $${a.equity.toFixed(2)}, cash $${a.cash.toFixed(2)}, day P&L $${(a.equity - a.lastEquity).toFixed(2)}, market ${c.isOpen ? "open" : "closed"}`);
    for (const p of ps) console.log(`  ${p.symbol}: ${p.qty} @ ${p.avgEntryPrice.toFixed(2)} → ${p.currentPrice.toFixed(2)} (${((p.currentPrice / p.avgEntryPrice - 1) * 100).toFixed(2)}%)`);
  } catch (e) {
    console.log(`Account: unavailable (${redact(e instanceof Error ? e.message : String(e))})`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const secrets = await loadSecrets(ROOT);
  const redact = makeRedactor(secretValues(secrets));
  try {
    assertPaperOnly([secrets.alpacaBaseUrl]);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  switch (args.command) {
    case "once":
      process.exit(await once(args, secrets, redact));
    case "schedule":
      return schedule(args, redact);
    case "status":
      return status(args, secrets, redact);
    default:
      console.log("Usage: bun src/cli.ts <once|schedule|status> [--fake] [--slot HH:MM] [--force]");
      process.exit(1);
  }
}

await main();
