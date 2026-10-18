import { contactRefusal } from "./contact.js";
import { haversineKm } from "./flight.js";
import { findCity } from "./recipients.js";
import { planCourier } from "./route.js";

/** A friend's name on the envelope. Longer than this does not fit the slip. */
export const FRIEND_NAME_MAX = 24;

/**
 * A person, not a city id. Blank, control characters, and markup are refused
 * so the name can be written on paper without becoming a page of its own.
 */
export function normalizeFriendName(raw) {
  if (typeof raw !== "string") return null;
  if (/[\u0000-\u001f<>]/.test(raw)) return null;
  const name = raw.replace(/[ \t\u3000]+/g, " ").trim();
  const length = [...name].length;
  if (!length || length > FRIEND_NAME_MAX) return null;
  return name;
}

/** Destination stored on the letter. `id` stays the city id so old geometry still resolves. */
export function friendPlace(city, name) {
  return {
    id: city.id,
    name,
    city: city.name,
    cityId: city.id,
    country: city.country,
    continent: city.continent,
    lat: city.lat,
    lng: city.lng,
    kind: "friend",
  };
}

/**
 * A letter addressed to someone the sender named, in a city from the existing list.
 * Duration is the same postal formula as a letter to a stranger in that city.
 */
export function planFriendLetter({ from, cityId, friendName, pace } = {}) {
  const name = normalizeFriendName(friendName);
  if (!name) return { error: "請寫下朋友的稱呼" };
  const refusal = contactRefusal(name);
  if (refusal.kinds.length) return { error: refusal.error, reasons: refusal.kinds };
  const city = findCity(cityId);
  if (!city) return { error: "請選擇朋友所在的城市" };
  if (!from || !Number.isFinite(Number(from.lat)) || !Number.isFinite(Number(from.lng))) {
    return { error: "找不到寄出地" };
  }
  if (from.id === city.id) return { error: "請選擇不同的寄出地與收件地" };
  const distance = haversineKm(from.lat, from.lng, city.lat, city.lng);
  if (distance < 0.05) return { error: "請選擇不同的寄出地與收件地" };
  const to = friendPlace(city, name);
  let plan;
  try {
    plan = planCourier({ from, to, pace });
  } catch {
    return { error: "不認識的飛行節奏" };
  }
  return {
    from,
    to,
    audience: "friend",
    distanceKm: plan.distanceKm,
    durationSeconds: plan.durationSeconds,
    legs: plan.legs,
    pace: plan.pace,
  };
}
