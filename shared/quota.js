import { normalizeSenderId } from "./profile.js";

/**
 * 參考 Postcrossing，上限 10 封。
 * https://www.postcrossing.com/help/how-many-postcards-can-i-send
 * The steps below match that public table only up to ten letters in flight.
 * Postcrossing's own maximum is 100 traveling. Ten is our cap, not their rule.
 * There is no expiry: a letter always arrives.
 *
 * Delivered 0–4 → 5, 5–14 → 6, 15–24 → 7, 25–34 → 8, 35–49 → 9, 50+ → 10.
 */

export const SLOT_CAP = 10;

const SLOT_STEPS = [
  { delivered: 50, slots: 10 },
  { delivered: 35, slots: 9 },
  { delivered: 25, slots: 8 },
  { delivered: 15, slots: 7 },
  { delivered: 5, slots: 6 },
  { delivered: 0, slots: 5 },
];

export function slotLimit(delivered) {
  const count = Math.max(0, Math.floor(Number(delivered) || 0));
  for (const step of SLOT_STEPS) {
    if (count >= step.delivered) return step.slots;
  }
  return 5;
}

/** How many more deliveries open the next slot. Null once the cap is reached. */
export function deliveriesUntilNextSlot(delivered) {
  const count = Math.max(0, Math.floor(Number(delivered) || 0));
  if (count >= 50) return null;
  const gates = [5, 15, 25, 35, 50];
  const next = gates.find((gate) => gate > count);
  return next - count;
}

export function nextSlotNote(delivered) {
  const more = deliveriesUntilNextSlot(delivered);
  if (more == null) return "";
  return `再送達 ${more} 封就多一格`;
}

export function quotaFullError(limit) {
  return `路上已經有 ${limit} 封信。等最早的那封送到，才能再寄。`;
}

export function remainingLabel(remaining) {
  const left = Math.max(0, Math.min(SLOT_CAP, Number(remaining) || 0));
  return `還可寄 ${left} 封`;
}

/** Gentle line for a full sheet. `arrivalText` is already in the browser's zone. */
export function quotaWaitMessage(arrivalText) {
  if (!arrivalText) return "最早的那封送到之後，就能再寄。";
  return `最早的一封會在${arrivalText}送到，到了就能再寄。`;
}

/**
 * Count this browser sender's letters.
 * Letters with no senderId do not count, in flight or delivered.
 * Drafts do not count. Pace does not change the table.
 */
export function quotaSnapshot(letters, senderId) {
  const id = normalizeSenderId(senderId);
  const mine = [];
  let delivered = 0;
  if (id) {
    for (const letter of letters || []) {
      if (letter?.senderId !== id) continue;
      if (letter.status === "in_flight") mine.push(letter);
      else if (letter.status === "delivered") delivered += 1;
    }
  }
  let soonest = null;
  for (const letter of mine) {
    const time = Date.parse(letter.arrivesAt);
    if (!Number.isFinite(time)) continue;
    if (soonest == null || time < soonest) soonest = time;
  }
  const limit = slotLimit(delivered);
  const inFlight = mine.length;
  return {
    limit,
    delivered,
    inFlight,
    remaining: Math.max(0, limit - inFlight),
    full: inFlight >= limit,
    soonestArrivesAt: soonest == null ? null : new Date(soonest).toISOString(),
    nextNote: nextSlotNote(delivered),
  };
}
