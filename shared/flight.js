/**
 * Flight duration and position.
 *
 * The server stores departedAt and arrivesAt. Progress is the fraction of
 * that window that has elapsed. The client only draws the great-circle
 * position for that fraction — it never decides when a letter lands.
 *
 * playable-fast (default):
 *   seconds = clamp(12 * sqrt(distanceKm), 25, 18 * 60)
 *   Same-city hops land in tens of seconds, cross-city in a few minutes,
 *   and intercontinental flights stop at 18 minutes (inside 10–20).
 *
 * romantic-slow (reserved pace, not the default):
 *   seconds = clamp(70 * sqrt(distanceKm), 3 * 60, 90 * 60)
 *   Ocean crossings sit around an hour.
 */

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
    factor: 70,
    minSeconds: 3 * 60,
    maxSeconds: 90 * 60,
  },
};

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

export function flightDurationSeconds(distanceKm, pace = "playable-fast") {
  const cfg = PACES[pace];
  if (!cfg) {
    throw new Error(`unknown pace: ${pace}`);
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
 */
export function describeFlight(letter, nowMs) {
  const origin = { lat: letter.from.lat, lng: letter.from.lng };
  const dest = { lat: letter.to.lat, lng: letter.to.lng };

  if (letter.status === "draft" || !letter.departedAt || !letter.arrivesAt) {
    return {
      status: "draft",
      progress: 0,
      position: origin,
      remainingKm: letter.distanceKm,
      etaSeconds: null,
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
    remainingKm: letter.distanceKm * (1 - progress),
    etaSeconds: arrived ? 0 : Math.max(0, (end - nowMs) / 1000),
  };
}
