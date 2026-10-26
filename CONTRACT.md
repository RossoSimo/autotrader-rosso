You are working in this folder, which is empty. Build from scratch an agent that does **paper trading on its own**, at fixed times, with nobody in front of the screen. Read everything before writing a single line.

## Goal

A program that wakes up 4 times a day, looks at the account, decides whether to buy or sell, executes, leaves a note for the next run, and notifies me on Telegram.
I don't care whether it makes money. I care that it **never makes the same mistake twice** and that it **always tells me the truth** about what it did and what broke.

## Non-negotiable constraints

1. **Paper trading only.** Endpoint `https://paper-api.alpaca.markets/v2`, hard-coded.
If someone configures the live endpoint, the program refuses to start.
2. **Every run starts with no memory.** It is a new process: it remembers nothing.
It rebuilds its context from two sources only:

   - **Alpaca** = the truth about the money (account, positions, orders from the last 48 hours, market open or not)
   - **the baton** `state/baton.json` = the truth about the intentions of the previous run

3. **Never the same order twice.** Even if the run dies halfway through, even if I launch it twice.
4. **The keys are never visible**: they live in `secrets.ts` (git-ignored), never in logs, never in messages, never printed to screen. Create `secrets.example.ts` with empty fields.

## Tools

- Bun + TypeScript, **zero external dependencies** (only `fetch` and Bun's APIs).
- The brain is **Claude Code in headless mode** (`claude -p`, with my subscription), with no tools, and a **fixed-schema JSON** response. No chat, no sessions.
- Broker: Alpaca REST API v2. Channel: a Telegram bot.

## The steps of a run, in this order

1. If `state/run.lock` exists, the previous run died halfway: **reconcile with Alpaca** (which of its orders actually went out) and alert me on Telegram. Then create your own lock.
2. Read the baton. If the last run is too old, **tell me which scheduled runs were missed** (machine off or offline). Don't run them late to catch up: an order from hours ago no longer makes sense.
3. Ask Alpaca for account, positions, recent orders, and market clock.
4. Ask the brain for a decision. It receives baton + account state, and responds with:
`orders` (symbol, side, quantity, why in one sentence), `reasoning` (3–5 sentences), `planNext` (what to check at the next run). All in English.
5. Pass the decision through the **cage** (below). The model proposes, the code disposes.
6. Submit the admitted orders, each with a **deterministic id**:
`YYYY-MM-DD-HHMM-SYMBOL-side` (e.g. `2026-09-24-1540-SPY-buy`).
Same run + same ticker + same side = same id, so Alpaca rejects the duplicate on its own.
Before submitting, if Alpaca already has an order with that id, don't resend it and write it in the log.
7. Write the new baton **atomically** (temp file + rename), in plain English, and keep a copy in `state/history/`.
8. Send me the report on Telegram and remove the lock.

## The scheduled runs (Rome time, US market 15:30–22:00)

| Time | Name | What it does |
| --- | --- | --- |
| 09:00 | briefing | reads the account and sets the plan. **No orders.** |
| 15:40 | opening | enters or adjusts |
| 18:30 | mid-session | checks, stop loss |
| 21:40 | closing | closes the day and writes the report |

`bun run schedule` checks the time every 30 seconds and launches the run that is due, only if it is newer than the last baton. `bun run once` immediately launches today's most recent scheduled run (`--slot 15:40` to choose it, `--force` to redo it). `bun run status` prints lock, last baton, account.

## The cage (rules in the code, not in the model's prompt)

- fixed universe: SPY QQQ IWM AAPL MSFT NVDA GLD TLT TSLA — everything else is rejected
- maximum 5 tickers in the portfolio, maximum 20% of the account per ticker
- stop loss at −3% from the cost basis: sells **even if the model doesn't ask for it**
- no shorts, no leverage, whole shares only
- no orders during the briefing or when the market is closed

Every rejected order goes in the log and in the message, with the reason.

## Telegram

Every message carries the run id (`run 2026-09-24-1540`), the same as the log file.

- **End of run**: orders submitted, orders rejected and why, rationale in 2 lines, account and day's P&L, next scheduled run.
- **Alerts** (separate message, with ⚠): previous run interrupted, missed runs, broker or brain error.
- If Telegram doesn't respond, the run doesn't stop: it writes it in the log.

## To test it without money and without network

- A **fake broker** persisted to file, with the same interface as the real one.
- A **fake brain** that always responds the same thing.
- A `--fake` option on every command to use both.

## Tests that must pass (with fake broker and brain)

1. Same run launched twice → only one order per ticker.
2. Process killed after the first order → the next run finds the lock, reconciles, doesn't buy again.
3. Baton from 09:00 and then nothing until 21:40 → flags 15:40 and 18:30 as missed.
4. The model proposes a ticker outside the universe, or 40% of the account on one ticker → rejected.
5. Position at −4% → the cage sells it even if the model says to hold.
6. Corrupted baton → counts as "no baton", the run proceeds with the broker.

## How you work

- Before writing code, show me the **plan in 10 lines** (files and responsibilities), then proceed without waiting for my confirmation.
- Small files, one per responsibility. Comments only where the why isn't obvious.
- At the end, run `bun test` and fix until it's green.
- Finish with a **report**: what you built, how to launch it, and the **known limitations** (written clearly, not hidden). Don't commit.
