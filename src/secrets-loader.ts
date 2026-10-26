import { existsSync } from "node:fs";
import { join } from "node:path";

export interface Secrets {
  alpacaKeyId: string;
  alpacaSecretKey: string;
  telegramBotToken: string;
  telegramChatId: string;
  /** Optional; only accepted if it equals the paper endpoint. */
  alpacaBaseUrl?: string;
}

const EMPTY: Secrets = { alpacaKeyId: "", alpacaSecretKey: "", telegramBotToken: "", telegramChatId: "" };

export async function loadSecrets(root: string): Promise<Secrets> {
  const file = join(root, "secrets.ts");
  if (!existsSync(file)) return { ...EMPTY };
  const mod = await import(file);
  return { ...EMPTY, ...(mod.default ?? {}) };
}

export function secretValues(s: Secrets): string[] {
  return [s.alpacaKeyId, s.alpacaSecretKey, s.telegramBotToken];
}
