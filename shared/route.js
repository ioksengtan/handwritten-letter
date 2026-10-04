import { DEFAULT_PACE, flightDurationSeconds, haversineKm } from "./flight.js";
import { findRecipient } from "./recipients.js";

/**
 * One carrier pigeon from the sender's region to the recipient's city.
 * The duration is still the postal formula on the great-circle distance.
 * The trip is not split into road, train, and plane.
 */

const BACKGROUND_PAIRS = [
  ["seoyeon", "camille", 0.12],
  ["ellen", "noah", 0.27],
  ["nadia", "sari", 0.39],
  ["owen", "aoi", 0.51],
  ["lucia", "mina", 0.62],
  ["lindiwe", "ellen", 0.73],
  ["sophie", "yu-an", 0.84],
  ["arun", "jonas", 0.93],
];

function round(value, digits) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function asPoint(point) {
  return {
    name: point.name,
    lat: round(point.lat, 6),
    lng: round(point.lng, 6),
  };
}

export function planCourier({ from, to, pace = DEFAULT_PACE }) {
  const origin = { ...from, name: from.city || from.name };
  const dest = { ...to, name: to.city || to.name };
  const directKm = haversineKm(origin.lat, origin.lng, dest.lat, dest.lng);
  const durationSeconds = flightDurationSeconds(directKm, pace, { from: origin, to: dest });
  const fromPoint = asPoint(origin);
  const toPoint = asPoint(dest);
  const distanceKm = round(directKm, 3);
  return {
    distanceKm,
    durationSeconds,
    pace,
    from: fromPoint,
    to: toPoint,
    legs: [{
      mode: "pigeon",
      from: fromPoint,
      to: toPoint,
      distanceKm,
      durationSeconds,
    }],
  };
}

const backgroundMemo = new Map();

export function backgroundPlans(pace = DEFAULT_PACE) {
  if (backgroundMemo.has(pace)) return backgroundMemo.get(pace);
  const plans = BACKGROUND_PAIRS.map(([fromId, toId, offset]) => {
    const from = findRecipient(fromId);
    const to = findRecipient(toId);
    const plan = planCourier({
      from: { name: from.city, country: from.country, continent: from.continent, lat: from.lat, lng: from.lng },
      to: { name: to.city, country: to.country, continent: to.continent, lat: to.lat, lng: to.lng },
      pace,
    });
    return {
      id: `bg-${from.cityId}-${to.cityId}`,
      offset,
      plan,
    };
  });
  backgroundMemo.set(pace, plans);
  return plans;
}

export function backgroundSnapshots(nowMs, plans = backgroundPlans()) {
  return plans.map((item) => {
    const dur = item.plan.durationSeconds;
    const elapsed = ((nowMs / 1000) + item.offset * dur) % dur;
    const start = nowMs - elapsed * 1000;
    return {
      id: item.id,
      kind: "background",
      from: item.plan.from,
      to: item.plan.to,
      departedAt: new Date(start).toISOString(),
      arrivesAt: new Date(start + dur * 1000).toISOString(),
    };
  });
}
