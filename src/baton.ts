import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Baton } from "./types";

export type BatonRead = { kind: "ok"; baton: Baton } | { kind: "missing" } | { kind: "corrupt"; error: string };

export function readBaton(path: string): BatonRead {
  if (!existsSync(path)) return { kind: "missing" };
  try {
    const b = JSON.parse(readFileSync(path, "utf8"));
    if (b?.version !== 1 || typeof b.runId !== "string" || !/^\d{4}-\d{2}-\d{2}-\d{4}$/.test(b.runId)) {
      return { kind: "corrupt", error: "unexpected structure" };
    }
    if (typeof b.planNext !== "string" || typeof b.summary !== "string") return { kind: "corrupt", error: "missing fields" };
    return { kind: "ok", baton: b };
  } catch (e) {
    return { kind: "corrupt", error: (e as Error).message };
  }
}

/** Temp file + rename, so a crash never leaves a half-written baton. Also keeps a copy in history. */
export function writeBaton(path: string, historyDir: string, baton: Baton) {
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(historyDir, { recursive: true });
  const text = JSON.stringify(baton, null, 2);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
  // A --force rerun of the same slot must not overwrite the earlier copy.
  let copy = join(historyDir, `${baton.runId}.json`);
  for (let n = 2; existsSync(copy); n++) copy = join(historyDir, `${baton.runId}.${n}.json`);
  writeFileSync(copy, text);
}
