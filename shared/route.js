import { flightDurationSeconds, haversineKm } from "./flight.js";
import { findRecipient } from "./recipients.js";

/**
 * Simplified hub-and-spoke mail route. Not an airline schedule.
 *
 * - under 80 km: one road leg
 * - same country, under 700 km: one train leg
 * - longer domestic, or any international hop: road to the nearest
 *   major airport, plane to the destination airport, road to the door
 *
 * Total seconds still come from the playable-fast (or romantic-slow)
 * formula on the direct great-circle distance. Short legs keep a
 * minimum slice of that time so a mode change is visible; the long
 * leg takes the rest.
 */

export const SHORT_KM = 80;
export const TRAIN_MAX_KM = 700;
const MIN_TRANSFER_KM = 4;

export const MODE_LABEL = {
  road: "公路",
  train: "火車",
  plane: "飛機",
};

export const MODE_COLOR = {
  road: "#c47b3a",
  train: "#2f7d5a",
  plane: "#3d6cb5",
};

export const HUBS = [
  { id: "TPE", name: "桃園機場", country: "台灣", lat: 25.0777, lng: 121.2328 },
  { id: "RMQ", name: "台中機場", country: "台灣", lat: 24.2647, lng: 120.621 },
  { id: "KHH", name: "高雄機場", country: "台灣", lat: 22.5771, lng: 120.35 },
  { id: "HND", name: "羽田機場", country: "日本", lat: 35.5494, lng: 139.7798 },
  { id: "ICN", name: "仁川機場", country: "韓國", lat: 37.4602, lng: 126.4407 },
  { id: "HKG", name: "香港機場", country: "香港", lat: 22.308, lng: 113.9185 },
  { id: "SIN", name: "樟宜機場", country: "新加坡", lat: 1.3644, lng: 103.9915 },
  { id: "BKK", name: "素萬那普機場", country: "泰國", lat: 13.69, lng: 100.7501 },
  { id: "LIS", name: "里斯本機場", country: "葡萄牙", lat: 38.7742, lng: -9.1342 },
  { id: "CDG", name: "戴高樂機場", country: "法國", lat: 49.0097, lng: 2.5479 },
  { id: "LHR", name: "希斯洛機場", country: "英國", lat: 51.47, lng: -0.4543 },
  { id: "BER", name: "柏林機場", country: "德國", lat: 52.3667, lng: 13.5033 },
  { id: "FCO", name: "羅馬機場", country: "義大利", lat: 41.8003, lng: 12.2389 },
  { id: "CAI", name: "開羅機場", country: "埃及", lat: 30.1219, lng: 31.4056 },
  { id: "CPT", name: "開普敦機場", country: "南非", lat: -33.9715, lng: 18.6021 },
  { id: "NBO", name: "奈洛比機場", country: "肯亞", lat: -1.3192, lng: 36.9278 },
  { id: "JFK", name: "甘迺迪機場", country: "美國", lat: 40.6413, lng: -73.7781 },
  { id: "LAX", name: "洛杉磯機場", country: "美國", lat: 33.9416, lng: -118.4085 },
  { id: "MEX", name: "墨西哥城機場", country: "墨西哥", lat: 19.4363, lng: -99.0721 },
  { id: "GIG", name: "里約機場", country: "巴西", lat: -22.8099, lng: -43.2505 },
  { id: "YVR", name: "溫哥華機場", country: "加拿大", lat: 49.1947, lng: -123.1792 },
  { id: "SYD", name: "雪梨機場", country: "澳洲", lat: -33.9399, lng: 151.1753 },
  { id: "AKL", name: "奧克蘭機場", country: "紐西蘭", lat: -37.0082, lng: 174.785 },
];

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

function makeLeg(mode, from, to) {
  return {
    mode,
    from: asPoint(from),
    to: asPoint(to),
    distanceKm: round(haversineKm(from.lat, from.lng, to.lat, to.lng), 3),
    durationSeconds: 0,
  };
}

export function nearestHub(point, hubs = HUBS) {
  let best = hubs[0];
  let bestKm = Infinity;
  for (const hub of hubs) {
    const km = haversineKm(point.lat, point.lng, hub.lat, hub.lng);
    if (km < bestKm) {
      best = hub;
      bestKm = km;
    }
  }
  return best;
}

function hubSpoke(from, to) {
  const hubA = nearestHub(from);
  const hubB = nearestHub(to);
  const airportA = { name: hubA.name, lat: hubA.lat, lng: hubA.lng };
  const airportB = { name: hubB.name, lat: hubB.lat, lng: hubB.lng };
  if (hubA.id === hubB.id) {
    const km = haversineKm(from.lat, from.lng, to.lat, to.lng);
    return [makeLeg(km < SHORT_KM ? "road" : "train", from, to)];
  }

  const legs = [];
  const toAirport = haversineKm(from.lat, from.lng, airportA.lat, airportA.lng);
  const fromAirport = haversineKm(airportB.lat, airportB.lng, to.lat, to.lng);
  if (toAirport >= MIN_TRANSFER_KM) legs.push(makeLeg("road", from, airportA));
  const planeFrom = toAirport >= MIN_TRANSFER_KM ? airportA : from;
  const planeTo = fromAirport >= MIN_TRANSFER_KM ? airportB : to;
  legs.push(makeLeg("plane", planeFrom, planeTo));
  if (fromAirport >= MIN_TRANSFER_KM) legs.push(makeLeg("road", airportB, to));
  return legs;
}

function assignDurations(legs, totalSeconds) {
  const total = Math.max(legs.length, Math.round(totalSeconds));
  if (legs.length === 1) {
    legs[0].durationSeconds = total;
    return;
  }
  let floor = Math.min(48, Math.max(24, Math.round(total * 0.1)));
  const others = legs.length - 1;
  if (floor * others > total - others) {
    floor = Math.max(1, Math.floor((total - others) / others));
  }
  if (total - floor * others < Math.round(total * 0.5)) {
    floor = Math.max(1, Math.floor((total * 0.5) / others));
  }
  let primary = 0;
  for (let i = 1; i < legs.length; i += 1) {
    if (legs[i].distanceKm > legs[primary].distanceKm) primary = i;
  }
  let used = 0;
  for (let i = 0; i < legs.length; i += 1) {
    if (i === primary) continue;
    legs[i].durationSeconds = floor;
    used += floor;
  }
  legs[primary].durationSeconds = total - used;
}

export function planCourier({ from, to, pace = "playable-fast" }) {
  const origin = { ...from, name: from.city || from.name };
  const dest = { ...to, name: to.city || to.name };
  const directKm = haversineKm(origin.lat, origin.lng, dest.lat, dest.lng);
  const durationSeconds = flightDurationSeconds(directKm, pace);
  const sameCountry = Boolean(origin.country && dest.country && origin.country === dest.country);
  let legs;
  if (directKm < SHORT_KM) {
    legs = [makeLeg("road", origin, dest)];
  } else if (sameCountry && directKm < TRAIN_MAX_KM) {
    legs = [makeLeg("train", origin, dest)];
  } else {
    legs = hubSpoke(origin, dest);
  }
  assignDurations(legs, durationSeconds);
  return {
    distanceKm: round(directKm, 3),
    durationSeconds,
    pace,
    legs,
  };
}

export function legVia(legs) {
  return legs.map((leg) => `${MODE_LABEL[leg.mode]}到${leg.to.name}`).join(" → ");
}

let backgroundMemo = null;

export function backgroundPlans() {
  if (backgroundMemo) return backgroundMemo;
  backgroundMemo = BACKGROUND_PAIRS.map(([fromId, toId, offset]) => {
    const from = findRecipient(fromId);
    const to = findRecipient(toId);
    const plan = planCourier({
      from: { name: from.city, country: from.country, lat: from.lat, lng: from.lng },
      to: { name: to.city, country: to.country, lat: to.lat, lng: to.lng },
    });
    return {
      id: `bg-${from.cityId}-${to.cityId}`,
      offset,
      plan,
    };
  });
  return backgroundMemo;
}

export function backgroundSnapshots(nowMs, plans = backgroundPlans()) {
  return plans.map((item) => {
    const dur = item.plan.durationSeconds;
    const elapsed = ((nowMs / 1000) + item.offset * dur) % dur;
    const start = nowMs - elapsed * 1000;
    return {
      id: item.id,
      kind: "background",
      legs: item.plan.legs,
      departedAt: new Date(start).toISOString(),
      arrivesAt: new Date(start + dur * 1000).toISOString(),
    };
  });
}
