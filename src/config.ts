import { join } from "node:path";

export const PAPER_BASE_URL = "https://paper-api.alpaca.markets/v2";
export const DATA_BASE_URL = "https://data.alpaca.markets/v2";

export const UNIVERSE = ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "GLD", "TLT", "TSLA"] as const;
export const MAX_TICKERS = 5;
export const MAX_WEIGHT = 0.2;
export const STOP_LOSS = -0.03;

export type SlotName = "briefing" | "opening" | "mid-session" | "closing";
export const SLOTS: { time: string; name: SlotName }[] = [
  { time: "09:00", name: "briefing" },
  { time: "15:40", name: "opening" },
  { time: "18:30", name: "mid-session" },
  { time: "21:40", name: "closing" },
];

/** The scheduler only fires a slot this many minutes after its time; later it counts as missed. */
export const SCHEDULE_GRACE_MINUTES = 30;
/** A lock older than this is considered dead even if its pid looks alive (pids get reused). */
export const LOCK_STALE_MINUTES = 15;
export const BRAIN_TIMEOUT_MS = 180_000;

export interface Paths {
  stateDir: string;
  logsDir: string;
  baton: string;
  lock: string;
  historyDir: string;
  fakeBroker: string;
}

export function makePaths(root: string): Paths {
  const stateDir = join(root, "state");
  return {
    stateDir,
    logsDir: join(root, "logs"),
    baton: join(stateDir, "baton.json"),
    lock: join(stateDir, "run.lock"),
    historyDir: join(stateDir, "history"),
    fakeBroker: join(stateDir, "fake-broker.json"),
  };
}

const URL_ENV_VARS = ["APCA_API_BASE_URL", "ALPACA_BASE_URL", "ALPACA_ENDPOINT"];

/** Refuses to start if anyone tried to point the program at a non-paper endpoint. */
export function assertPaperOnly(configuredUrls: (string | undefined)[], env: Record<string, string | undefined> = process.env) {
  const candidates = [...configuredUrls, ...URL_ENV_VARS.map((k) => env[k])];
  for (const url of candidates) {
    if (url === undefined || url === "") continue;
    if (url.replace(/\/+$/, "") !== PAPER_BASE_URL) {
      throw new Error(`Refusing to start: endpoint "${url}" is not the paper endpoint ${PAPER_BASE_URL}`);
    }
  }
}
