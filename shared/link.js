import { describeFlight } from "./flight.js";

/**
 * Public links use 32 random bytes, encoded without padding.
 * That is 43 characters and not a counter, so neighboring letters
 * cannot be found by adding one.
 */
export const PUBLIC_TOKEN_BYTES = 32;
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

export const FRIEND_OPEN_DAYS = 14;
export const FRIEND_OPEN_MS = FRIEND_OPEN_DAYS * 24 * 60 * 60 * 1000;

export const RETURNED_NOTE = "這封信已經退回郵局";
export const RETURNED_DETAIL = "送到之後過了十四天，這條連結就收回了。";
export const INVITE_LINE = "也寄一封給遠方的陌生人";

export function isPublicToken(value) {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

export function mintToken(fill) {
  if (typeof fill !== "function") throw new Error("無法產生連結");
  const bytes = fill(PUBLIC_TOKEN_BYTES);
  const buffer = Buffer.from(bytes);
  if (buffer.length < PUBLIC_TOKEN_BYTES) throw new Error("無法產生連結");
  const token = buffer.subarray(0, PUBLIC_TOKEN_BYTES).toString("base64url");
  if (!isPublicToken(token)) throw new Error("無法產生連結");
  return token;
}

export function mintUniqueToken(taken, fill) {
  const used = taken instanceof Set ? taken : new Set(taken || []);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const token = mintToken(fill);
    if (!used.has(token)) return token;
  }
  throw new Error("無法產生連結");
}

/**
 * Every posted letter gets a share code. A letter to a friend also gets
 * a second code, the one the sender hands over. Drafts may carry the
 * codes already, but they are not published until the letter is posted.
 */
export function assignLetterLinks(letter, taken, fill) {
  const used = new Set(taken || []);
  const audience = letter?.audience === "friend" ? "friend" : "stranger";
  let shareToken = isPublicToken(letter?.shareToken) ? letter.shareToken : "";
  if (!shareToken) shareToken = mintUniqueToken(used, fill);
  used.add(shareToken);
  let friendToken = null;
  if (audience === "friend") {
    friendToken = isPublicToken(letter?.friendToken) ? letter.friendToken : "";
    if (!friendToken) friendToken = mintUniqueToken(used, fill);
  }
  return {
    ...letter,
    audience,
    shareToken,
    friendToken,
  };
}

export function friendOpenState(letter, nowMs) {
  if (!letter || letter.audience !== "friend" || !isPublicToken(letter.friendToken)) return "missing";
  if (letter.status === "draft" || !letter.departedAt || !letter.arrivesAt) return "unsent";
  const flight = describeFlight(letter, nowMs);
  if (flight.status !== "delivered") return "traveling";
  const arrivedAt = Date.parse(letter.deliveredAt || letter.arrivesAt);
  if (!Number.isFinite(arrivedAt)) return "traveling";
  if (nowMs > arrivedAt + FRIEND_OPEN_MS) return "returned";
  return "arrived";
}

function round(value, digits) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function publicPoint(point, personal) {
  if (!point) return null;
  const city = point.city || point.name || "";
  return {
    id: point.cityId || point.id || null,
    cityId: point.cityId || point.id || null,
    name: personal ? (point.name || city) : city,
    city,
    country: point.country || "",
    continent: point.continent || null,
    lat: point.lat,
    lng: point.lng,
  };
}

/**
 * What the friend may see. While the pigeon is flying there is no letter
 * face. After fourteen days there is only the returned slip.
 * The mailbox id, the sender id, and the stored file name stay off this object.
 */
export function projectFriendOpen(letter, nowMs) {
  const state = friendOpenState(letter, nowMs);
  if (state === "missing" || state === "unsent") return null;
  if (state === "returned") {
    return { state: "returned", note: RETURNED_NOTE, detail: RETURNED_DETAIL };
  }
  const flight = describeFlight(letter, nowMs);
  const arrived = state === "arrived";
  return {
    state,
    from: publicPoint(letter.from, false),
    to: publicPoint(letter.to, true),
    distanceKm: letter.distanceKm,
    pace: letter.pace,
    durationSeconds: letter.durationSeconds,
    departedAt: letter.departedAt,
    arrivesAt: letter.arrivesAt,
    deliveredAt: arrived ? (letter.deliveredAt || letter.arrivesAt) : null,
    progress: flight.progress,
    position: {
      lat: round(flight.position.lat, 6),
      lng: round(flight.position.lng, 6),
    },
    remainingKm: round(flight.remainingKm, 3),
    etaSeconds: flight.etaSeconds == null ? null : Math.max(0, Math.round(flight.etaSeconds)),
    closesAt: new Date(Date.parse(letter.arrivesAt) + FRIEND_OPEN_MS).toISOString(),
    serverNow: new Date(nowMs).toISOString(),
    imageUrl: arrived ? `/api/open/${letter.friendToken}/image` : null,
    note: arrived ? (letter.note || "") : "",
  };
}

export function shareCities(letter) {
  return {
    fromCity: letter?.from?.city || letter?.from?.name || "",
    toCity: letter?.to?.city || letter?.to?.name || "",
    fromCountry: letter?.from?.country || "",
    toCountry: letter?.to?.country || "",
  };
}

/** A posted letter can be shared. A draft cannot, even if it already has a code. */
export function sharePublished(letter) {
  if (!letter || !isPublicToken(letter.shareToken)) return false;
  if (letter.status === "draft" || !letter.departedAt || !letter.arrivesAt) return false;
  return letter.status === "in_flight"
    || letter.status === "awaiting_receipt"
    || letter.status === "delivered";
}
