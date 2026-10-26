import type { Brain, Decision } from "../types";

export const FAKE_DECISION: Decision = {
  orders: [
    { symbol: "SPY", side: "buy", qty: 10, why: "Fake brain always builds a small core position in the index." },
    { symbol: "GLD", side: "buy", qty: 5, why: "Fake brain always adds a small hedge." },
  ],
  reasoning: "This is the fake brain. It always answers the same way. It is used to test the pipeline without a model.",
  planNext: "Check that the SPY and GLD orders were filled.",
};

export class FakeBrain implements Brain {
  constructor(private answer: Decision = FAKE_DECISION) {}
  async decide(): Promise<Decision> {
    return structuredClone(this.answer);
  }
}
