import { tmpdir } from "node:os";
import { BRAIN_TIMEOUT_MS } from "../config";
import type { Brain, Decision } from "../types";
import { DECISION_SCHEMA, parseDecision } from "./schema";

/** Claude Code headless: one-shot, no tools, no saved session, fixed JSON schema. */
export class ClaudeBrain implements Brain {
  constructor(private model?: string, private command: string[] = ["claude"]) {}

  async decide(prompt: string): Promise<Decision> {
    const args = [
      ...this.command, "-p",
      "--output-format", "json",
      "--json-schema", JSON.stringify(DECISION_SCHEMA),
      "--tools", "",
      "--no-session-persistence",
      "--strict-mcp-config",
    ];
    if (this.model) args.push("--model", this.model);
    // Neutral cwd so no project CLAUDE.md or settings leak into the decision.
    const proc = Bun.spawn(args, { cwd: tmpdir(), stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), BRAIN_TIMEOUT_MS);
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (code !== 0) throw new Error(`claude exited with code ${code}: ${(err || out).slice(0, 300)}`);
    let envelope: any;
    try {
      envelope = JSON.parse(out);
    } catch {
      throw new Error(`claude output is not JSON: ${out.slice(0, 200)}`);
    }
    if (envelope.is_error) throw new Error(`claude reported an error: ${String(envelope.result).slice(0, 300)}`);
    const payload = envelope.structured_output ?? safeJson(envelope.result);
    return parseDecision(payload);
  }
}

function safeJson(s: unknown): unknown {
  if (typeof s !== "string") return s;
  try {
    return JSON.parse(s.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw new Error(`claude result is not valid JSON: ${s.slice(0, 200)}`);
  }
}
