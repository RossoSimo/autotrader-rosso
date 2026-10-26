import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  readonly file: string;
}

/** Masks every known secret value, as a last line of defence for anything that reaches a log or a message. */
export function makeRedactor(secrets: string[]): (text: string) => string {
  const values = secrets.filter((s) => s && s.length >= 4).sort((a, b) => b.length - a.length);
  return (text) => values.reduce((t, v) => t.split(v).join("***"), text);
}

export function createLogger(file: string, redact: (t: string) => string, echo = true): Logger {
  mkdirSync(dirname(file), { recursive: true });
  // Synchronous appends: if the process is killed, everything logged so far is on disk.
  const write = (level: string, msg: string) => {
    const line = `${new Date().toISOString()} ${level} ${redact(msg)}`;
    appendFileSync(file, line + "\n");
    if (echo) console.log(line);
  };
  return {
    file,
    info: (m) => write("INFO ", m),
    warn: (m) => write("WARN ", m),
    error: (m) => write("ERROR", m),
  };
}
