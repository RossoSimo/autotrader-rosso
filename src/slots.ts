import { SLOTS, type SlotName } from "./config";
import type { Slot } from "./types";

const romeFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Rome",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function romeNow(now: Date): { date: string; time: string } {
  const p = Object.fromEntries(romeFormat.formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

export function makeSlot(date: string, time: string): Slot {
  const def = SLOTS.find((s) => s.time === time);
  if (!def) throw new Error(`Unknown slot ${time}. Valid: ${SLOTS.map((s) => s.time).join(", ")}`);
  return { date, time, name: def.name, runId: `${date}-${time.replace(":", "")}` };
}

export function slotNameOf(runId: string): SlotName | undefined {
  const hhmm = runId.slice(11);
  return SLOTS.find((s) => s.time.replace(":", "") === hhmm)?.name;
}

/** Calendar arithmetic on YYYY-MM-DD strings; UTC avoids DST shifts. */
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function isWeekday(date: string): boolean {
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
  return wd !== 0 && wd !== 6;
}

function minutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h! * 60 + m!;
}

/** Most recent slot of today at or before now (null if before the first slot). */
export function latestSlotToday(now: Date): Slot | null {
  const { date, time } = romeNow(now);
  const past = SLOTS.filter((s) => s.time <= time);
  return past.length ? makeSlot(date, past[past.length - 1]!.time) : null;
}

/** The slot the scheduler should fire now, if any: weekday, and within the grace window. */
export function dueSlot(now: Date, graceMinutes: number): Slot | null {
  const slot = latestSlotToday(now);
  if (!slot || !isWeekday(slot.date)) return null;
  const late = minutes(romeNow(now).time) - minutes(slot.time);
  return late <= graceMinutes ? slot : null;
}

/** Weekday slots strictly between two run ids. */
export function missedSlots(lastRunId: string, currentRunId: string): Slot[] {
  const out: Slot[] = [];
  let date = lastRunId.slice(0, 10);
  const endDate = currentRunId.slice(0, 10);
  for (let guard = 0; date <= endDate && guard < 400; guard++, date = addDays(date, 1)) {
    if (!isWeekday(date)) continue;
    for (const s of SLOTS) {
      const slot = makeSlot(date, s.time);
      if (slot.runId > lastRunId && slot.runId < currentRunId) out.push(slot);
    }
  }
  return out;
}

export function nextSlot(after: Slot): Slot {
  let date = after.date;
  for (let i = 0; i < 10; i++, date = addDays(date, 1)) {
    if (!isWeekday(date)) continue;
    for (const s of SLOTS) {
      const slot = makeSlot(date, s.time);
      if (slot.runId > after.runId) return slot;
    }
  }
  throw new Error("unreachable: no next slot within 10 days");
}
