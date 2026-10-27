import { join, normalize } from "node:path";
import type { Paths } from "../config";
import type { Broker } from "../types";
import { buildState } from "./state";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

export interface DashboardOptions {
  paths: Paths;
  staticDir: string;
  broker: Broker;
  fake: boolean;
  port: number;
  redact: (t: string) => string;
}

/** Read-only: it never places orders or touches the lock. Bound to localhost because it has no login. */
export function serveDashboard(o: DashboardOptions) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: o.port,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
      if (url.pathname === "/api/state") {
        const state = await buildState(o.paths, o.broker, new Date(), { fake: o.fake, redact: o.redact });
        return Response.json(state, { headers: { "Cache-Control": "no-store" } });
      }
      const rel = url.pathname === "/" ? "index.html" : normalize(url.pathname.slice(1));
      const ext = rel.slice(rel.lastIndexOf("."));
      if (rel.startsWith("..") || !TYPES[ext]) return new Response("Not found", { status: 404 });
      const file = Bun.file(join(o.staticDir, rel));
      if (!(await file.exists())) return new Response("Not found", { status: 404 });
      return new Response(file, { headers: { "Content-Type": TYPES[ext]!, "Cache-Control": "no-store" } });
    },
  });
  console.log(`Dashboard${o.fake ? " (fake broker)" : ""} on http://${server.hostname}:${server.port}`);
  return server;
}
