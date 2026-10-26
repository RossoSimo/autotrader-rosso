import type { Account, BatonOrder, Slot } from "./types";

export interface RunOutcome {
  slot: Slot;
  submitted: BatonOrder[];
  rejected: { symbol: string; side: string; qty: number; reason: string }[];
  reasoning: string;
  account: Account | null;
  next: Slot;
}

const usd = (x: number) => `${x < 0 ? "-" : ""}$${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function dayPnl(a: Account): number {
  return a.equity - a.lastEquity;
}

export function firstSentences(text: string, n: number): string {
  const parts = text.match(/[^.!?]+[.!?]+(\s|$)/g);
  return parts ? parts.slice(0, n).join("").trim() : text.trim();
}

export function formatAlert(runId: string, lines: string[]): string {
  return [`⚠ run ${runId}`, ...lines].join("\n");
}

export function formatReport(o: RunOutcome): string {
  const lines = [`run ${o.slot.runId} · ${o.slot.name}`];
  lines.push(o.submitted.length ? "Orders:" : "Orders: none submitted.");
  for (const s of o.submitted) lines.push(`• ${s.side.toUpperCase()} ${s.qty} ${s.symbol}: ${s.outcome}. ${s.why}`);
  if (o.rejected.length) {
    lines.push("Rejected:");
    for (const r of o.rejected) lines.push(`• ${r.side.toUpperCase()} ${r.qty} ${r.symbol}: ${r.reason}`);
  }
  lines.push(`Rationale: ${firstSentences(o.reasoning, 2)}`);
  if (o.account) {
    const pnl = dayPnl(o.account);
    const pnlPct = o.account.lastEquity ? (pnl / o.account.lastEquity) * 100 : 0;
    lines.push(`Account: equity ${usd(o.account.equity)} · cash ${usd(o.account.cash)} · day P&L ${pnl >= 0 ? "+" : ""}${usd(pnl)} (${pnlPct.toFixed(2)}%)`);
  } else {
    lines.push("Account: unavailable (broker error).");
  }
  lines.push(`Next run: ${o.next.date} ${o.next.time} (${o.next.name})`);
  return lines.join("\n");
}
