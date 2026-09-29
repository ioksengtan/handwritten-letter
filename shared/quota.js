import { normalizeSenderId } from "./profile.js";

/** How many of one sender's letters may be in flight at once. Any pace. */
export const IN_FLIGHT_LIMIT = 5;

export const QUOTA_FULL_ERROR = "路上已經有五封信。等最早的那封送到，才能再寄。";

export function remainingLabel(remaining) {
  const left = Math.max(0, Math.min(IN_FLIGHT_LIMIT, Number(remaining) || 0));
  return `還可寄 ${left} 封`;
}

/** Gentle line for a full sheet. `arrivalText` is already in the browser's zone. */
export function quotaWaitMessage(arrivalText) {
  if (!arrivalText) return "最早的那封送到之後，就能再寄。";
  return `最早的一封會在${arrivalText}送到，到了就能再寄。`;
}

/**
 * Count in-flight letters for one browser sender.
 * Letters with no senderId (mailed before this field) do not count.
 * Delivered letters and drafts do not count. Pace does not change the cap.
 */
export function quotaSnapshot(letters, senderId) {
  const id = normalizeSenderId(senderId);
  const mine = [];
  if (id) {
    for (const letter of letters || []) {
      if (letter?.status !== "in_flight") continue;
      if (letter.senderId !== id) continue;
      mine.push(letter);
    }
  }
  let soonest = null;
  for (const letter of mine) {
    const time = Date.parse(letter.arrivesAt);
    if (!Number.isFinite(time)) continue;
    if (soonest == null || time < soonest) soonest = time;
  }
  const inFlight = mine.length;
  return {
    limit: IN_FLIGHT_LIMIT,
    inFlight,
    remaining: Math.max(0, IN_FLIGHT_LIMIT - inFlight),
    full: inFlight >= IN_FLIGHT_LIMIT,
    soonestArrivesAt: soonest == null ? null : new Date(soonest).toISOString(),
  };
}
