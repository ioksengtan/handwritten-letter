import { haversineKm } from "./flight.js";

/**
 * A registered sender, addressed by nickname and city.
 * Coordinates are the city's, from the same list as the demo pool.
 */
export function personRecipient(sender, city) {
  return {
    id: sender.id,
    name: sender.nickname,
    city: city.name,
    cityId: city.id,
    country: city.country,
    continent: city.continent,
    lat: city.lat,
    lng: city.lng,
    demo: false,
  };
}

/** Same city, or closer than 30 km, so the pigeon would have nowhere to fly. */
export function sameHomeCity(from, city) {
  if (!from || !city) return false;
  if (from.id && city.id && from.id === city.id) return true;
  const numbers = [from.lat, from.lng, city.lat, city.lng];
  if (!numbers.every((value) => Number.isFinite(Number(value)))) return false;
  return haversineKm(from.lat, from.lng, city.lat, city.lng) < 30;
}

/**
 * Pick another real sender.
 * Returns null when fewer than two people are registered, nobody else is
 * eligible, or every other person has blocked this sender. The caller then
 * falls back to the demo list.
 * `excludeIds` are skipped when someone else is still available.
 */
export function pickPerson({
  senders = [],
  selfId = null,
  excludeIds = [],
  blockedIds = [],
  skipIds = [],
  random = Math.random,
} = {}) {
  const people = senders.filter((sender) => sender && sender.id);
  if (people.length < 2) return null;
  const blocked = new Set(blockedIds.filter(Boolean));
  const skip = new Set(skipIds.filter(Boolean));
  const others = people.filter((sender) => (
    sender.id !== selfId && !blocked.has(sender.id) && !skip.has(sender.id)
  ));
  if (!others.length) return null;
  const banned = new Set(excludeIds.filter(Boolean));
  let pool = others.filter((sender) => !banned.has(sender.id));
  if (!pool.length) pool = others;
  const roll = Math.abs(Number(random()));
  const fraction = Number.isFinite(roll) ? roll % 1 : 0;
  const index = Math.min(pool.length - 1, Math.floor(fraction * pool.length));
  return pool[index];
}
