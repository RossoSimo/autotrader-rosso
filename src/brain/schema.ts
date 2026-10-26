import type { Decision, ProposedOrder } from "../types";

export const DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["orders", "reasoning", "planNext"],
  properties: {
    orders: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["symbol", "side", "qty", "why"],
        properties: {
          symbol: { type: "string" },
          side: { type: "string", enum: ["buy", "sell"] },
          qty: { type: "integer", minimum: 1 },
          why: { type: "string", description: "One sentence, in English." },
        },
      },
    },
    reasoning: { type: "string", description: "3 to 5 sentences, in English." },
    planNext: { type: "string", description: "What the next run should check, in English." },
  },
} as const;

/** The CLI enforces the schema too, but nothing from the model is trusted without a check here. */
export function parseDecision(raw: unknown): Decision {
  if (!raw || typeof raw !== "object") throw new Error("brain output is not an object");
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.orders)) throw new Error("brain output: orders must be an array");
  if (typeof r.reasoning !== "string" || !r.reasoning.trim()) throw new Error("brain output: reasoning missing");
  if (typeof r.planNext !== "string" || !r.planNext.trim()) throw new Error("brain output: planNext missing");
  const orders = r.orders.map((o, i): ProposedOrder => {
    const x = (o ?? {}) as Record<string, unknown>;
    if (typeof x.symbol !== "string") throw new Error(`brain output: orders[${i}].symbol not a string`);
    if (x.side !== "buy" && x.side !== "sell") throw new Error(`brain output: orders[${i}].side invalid`);
    if (typeof x.qty !== "number" || !Number.isFinite(x.qty)) throw new Error(`brain output: orders[${i}].qty not a number`);
    // Fractional or non-positive quantities are left for the cage to reject with a visible reason.
    return { symbol: x.symbol.trim().toUpperCase(), side: x.side, qty: x.qty, why: String(x.why ?? "").trim() };
  });
  return { orders, reasoning: r.reasoning.trim(), planNext: r.planNext.trim() };
}
