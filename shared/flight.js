/**
 * Flight duration and position.
 *
 * The server stores departedAt and arrivesAt. Progress is the fraction of
 * that window that has elapsed. The pigeon sits on the great circle from
 * the stored origin to the stored destination, even when an older letter
 * still has several courier legs saved on it. The client only draws that
 * position — it never decides when a letter lands.
 *
 * romantic-slow (default): postal waiting, not a sped-up flight.
 *   city (< 80 km): about 1 day (26–28 hours before a small fixed wobble)
 *   domestic (same country): 2–3 days, longer hops closer to 3
 *   nearby (same continent, under 6000 km, another country): 4–6 days
 *   far (another continent, or same continent beyond 6000 km):
 *     days = clamp(7 + 7 * (km - 6500) / 12500, 7, 14)
 *     6500 km is 7 days, 19000 km is 14 days.
 *   A coordinate hash adds about ±2 hours in a city and ±4 hours otherwise.
 *   The same endpoints always get the same wobble, and the result stays
 *   inside that band. Taipei → London (about 9781 km) lands in 8–10 days.
 *
 * playable-fast (testing):
 *   seconds = clamp(12 * sqrt(distanceKm), 25, 18 * 60)
 *   Same-city hops land in tens of seconds, cross-city in a few minutes,
 *   and intercontinental flights stop at 18 minutes (inside 10–20).
 */

export const DEFAULT_PACE = "romantic-slow";

const DAY = 24 * 60 * 60;

export const PACES = {
  "playable-fast": {
    id: "playable-fast",
    label: "可玩快",
    factor: 12,
    minSeconds: 25,
    maxSeconds: 18 * 60,
  },
  "romantic-slow": {
    id: "romantic-slow",
    label: "浪漫慢",
  },
};

/** Countries in the demo pool. Places carry a country; recipients also carry a continent. */
const COUNTRY_CONTINENT = {
  台灣: "亞洲",
  日本: "亞洲",
  韓國: "亞洲",
  香港: "亞洲",
  新加坡: "亞洲",
  泰國: "亞洲",
  葡萄牙: "歐洲",
  法國: "歐洲",
  英國: "歐洲",
  德國: "歐洲",
  義大利: "歐洲",
  埃及: "非洲",
  南非: "非洲",
  肯亞: "非洲",
  美國: "美洲",
  加拿大: "美洲",
  墨西哥: "美洲",
  巴西: "美洲",
  澳洲: "大洋洲",
  紐西蘭: "大洋洲",
};

export function continentOf(point) {
  if (!point) return null;
  if (point.continent) return point.continent;
  if (point.country && COUNTRY_CONTINENT[point.country]) return COUNTRY_CONTINENT[point.country];
  return null;
}

const EARTH_RADIUS_KM = 6371.0088;

export function toRad(deg) {
  return (deg * Math.PI) / 180;
}

export function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function haversineKm(lat1, lng1, lat2, lng2) {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lng2 - lng1);
  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Stable wobble in seconds, centered on zero.
 * City routes stay within about two hours; everything else within about four.
 */
export function routeJitterSeconds(from, to, distanceKm) {
  if (!from || !to || !Number.isFinite(Number(from.lat)) || !Number.isFinite(Number(to.lat))) {
    return 0;
  }
  const key = [from.lat, from.lng, to.lat, to.lng].map((n) => Number(n).toFixed(4)).join("|");
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const centered = ((hash >>> 0) / 4294967295) * 2 - 1;
  const cap = distanceKm < 80 ? 2 * 60 * 60 : 4 * 60 * 60;
  return Math.round(centered * cap);
}

/**
 * city | domestic | region | far.
 * Without endpoints, distance stands in for geography:
 * under 900 km domestic, under 6000 km nearby, otherwise far.
 */
export function postalBand(distanceKm, from, to) {
  const km = Math.max(0, Number(distanceKm) || 0);
  const sameCountry = Boolean(from?.country && to?.country && from.country === to.country);
  const fromContinent = continentOf(from);
  const toContinent = continentOf(to);
  const sameContinent = Boolean(fromContinent && toContinent && fromContinent === toContinent);
  const knownGeo = Boolean(from?.country || to?.country || fromContinent || toContinent);
  if (km < 80) return "city";
  if (sameCountry || (!knownGeo && km < 900)) return "domestic";
  if ((sameContinent && km < 6000) || (!knownGeo && km < 6000)) return "region";
  return "far";
}

function postalDays(distanceKm, from, to) {
  const km = Math.max(0, Number(distanceKm) || 0);
  const band = postalBand(km, from, to);
  if (band === "city") {
    return { band, min: 1, max: 1.25, days: 26 / 24 + (km / 80) * (2 / 24) };
  }
  if (band === "domestic") {
    const t = clamp((Math.log(km) - Math.log(80)) / (Math.log(5000) - Math.log(80)), 0, 1);
    return { band, min: 2, max: 3, days: 2.25 + t * 0.5 };
  }
  if (band === "region") {
    const t = clamp(
      (Math.log(Math.max(km, 300)) - Math.log(300)) / (Math.log(6000) - Math.log(300)),
      0,
      1,
    );
    return { band, min: 4, max: 6, days: 4.35 + t * 1.3 };
  }
  const days = 7 + 7 * clamp((km - 6500) / 12500, 0, 1);
  return { band, min: 7, max: 14, days };
}

export function flightDurationSeconds(distanceKm, pace = DEFAULT_PACE, ends = null) {
  const cfg = PACES[pace];
  if (!cfg) {
    throw new Error(`unknown pace: ${pace}`);
  }
  if (pace === "romantic-slow") {
    const km = Number.isFinite(distanceKm) && distanceKm > 0 ? distanceKm : 0;
    const postal = postalDays(km, ends?.from, ends?.to);
    let seconds = Math.round(postal.days * DAY);
    if (ends?.vary !== false) seconds += routeJitterSeconds(ends?.from, ends?.to, km);
    return Math.round(clamp(seconds, postal.min * DAY, postal.max * DAY));
  }
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
    return cfg.minSeconds;
  }
  const raw = cfg.factor * Math.sqrt(distanceKm);
  return Math.round(clamp(raw, cfg.minSeconds, cfg.maxSeconds));
}

function angularDistance(φ1, λ1, φ2, λ2) {
  const Δφ = φ2 - φ1;
  const Δλ = λ2 - λ1;
  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Great-circle point at fraction t (0 = origin, 1 = destination). */
export function interpolate(lat1, lng1, lat2, lng2, t) {
  const φ1 = toRad(lat1);
  const λ1 = toRad(lng1);
  const φ2 = toRad(lat2);
  const λ2 = toRad(lng2);
  const δ = angularDistance(φ1, λ1, φ2, λ2);
  if (δ < 1e-8) return { lat: lat1, lng: lng1 };
  const sinδ = Math.sin(δ);
  const A = Math.sin((1 - t) * δ) / sinδ;
  const B = Math.sin(t * δ) / sinδ;
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);
  return {
    lat: toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))),
    lng: toDeg(Math.atan2(y, x)),
  };
}

/** Initial bearing in degrees, 0 = north, clockwise. */
export function bearingDegrees(lat1, lng1, lat2, lng2) {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lng2 - lng1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function samplePath(from, to, segments = 72) {
  const points = [];
  const n = Math.max(1, segments);
  for (let i = 0; i <= n; i += 1) {
    points.push(interpolate(from.lat, from.lng, to.lat, to.lng, i / n));
  }
  return points;
}

/** Shift longitude so it sits within 180° of `originLng` (short way around). */
export function alignLongitude(lng, originLng) {
  let next = lng;
  while (next - originLng > 180) next -= 360;
  while (originLng - next > 180) next += 360;
  return next;
}

/**
 * Rewrite a path so consecutive longitudes take the short way.
 * Leaflet can then draw Pacific crossings without jumping the long way
 * across the map.
 */
export function unwrapLongitudes(points) {
  if (!points.length) return [];
  const out = [{ lat: points[0].lat, lng: points[0].lng }];
  for (let i = 1; i < points.length; i += 1) {
    out.push({
      lat: points[i].lat,
      lng: alignLongitude(points[i].lng, out[i - 1].lng),
    });
  }
  return out;
}

/**
 * Derive live flight fields from stored timestamps.
 * `nowMs` is injectable so tests can move the clock without sleeping.
 * Stored legs, including an older multi-leg courier, do not move the pigeon.
 */
export function describeFlight(letter, nowMs) {
  const origin = { lat: letter.from.lat, lng: letter.from.lng };
  const dest = { lat: letter.to.lat, lng: letter.to.lng };
  const distanceKm = Number.isFinite(letter.distanceKm)
    ? letter.distanceKm
    : haversineKm(origin.lat, origin.lng, dest.lat, dest.lng);

  if (letter.status === "draft" || !letter.departedAt || !letter.arrivesAt) {
    return {
      status: "draft",
      progress: 0,
      position: origin,
      remainingKm: distanceKm,
      etaSeconds: null,
      mode: null,
      legIndex: null,
    };
  }

  const start = Date.parse(letter.departedAt);
  const end = Date.parse(letter.arrivesAt);
  const span = Math.max(1, end - start);
  let progress = (nowMs - start) / span;
  if (letter.status === "delivered") progress = 1;
  progress = clamp(progress, 0, 1);
  const arrived = letter.status === "delivered" || progress >= 1;

  return {
    status: arrived ? "delivered" : "in_flight",
    progress,
    position: interpolate(origin.lat, origin.lng, dest.lat, dest.lng, progress),
    remainingKm: arrived ? 0 : distanceKm * (1 - progress),
    etaSeconds: arrived ? 0 : Math.max(0, (end - nowMs) / 1000),
    mode: "pigeon",
    legIndex: null,
  };
}
