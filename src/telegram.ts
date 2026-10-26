import type { Logger } from "./log";
import type { Notifier } from "./types";

export class TelegramNotifier implements Notifier {
  constructor(private token: string, private chatId: string, private log: Logger) {}

  async send(text: string): Promise<boolean> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        this.log.warn(`Telegram did not accept the message: HTTP ${res.status}`);
        return false;
      }
      return true;
    } catch (e) {
      // Never log the error object: the request URL contains the bot token.
      this.log.warn(`Telegram unreachable (${(e as Error).name}); the run continues`);
      return false;
    }
  }
}

/** Used when Telegram is not configured: the message only goes to the log. */
export class LogNotifier implements Notifier {
  constructor(private log: Logger) {}
  async send(text: string): Promise<boolean> {
    this.log.info(`[telegram not configured] message:\n${text}`);
    return true;
  }
}
