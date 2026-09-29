/**
 * Sender profile for this browser.
 * There is no account yet. The shape is versioned so a later account can
 * store the same origin on the server and stop reading this key.
 *
 * { version: 1, originId: "<city id>", senderId: "<browser id>" }
 *
 * senderId is created with the region and sent on every letter. Letters
 * mailed before this field existed have no senderId and do not count
 * toward the in-flight limit. A new browser, or a new id, starts over.
 */

export const SENDER_PROFILE_KEY = "on-the-way-sender";
export const SENDER_PROFILE_VERSION = 1;

export function normalizeSenderId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/.test(id)) return null;
  return id;
}

export function serializeSenderProfile(originId, senderId) {
  const body = {
    version: SENDER_PROFILE_VERSION,
    originId,
  };
  const id = normalizeSenderId(senderId);
  if (id) body.senderId = id;
  return JSON.stringify(body);
}

export function parseSenderProfile(raw) {
  if (typeof raw !== "string" || !raw) return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || data.version !== SENDER_PROFILE_VERSION) return null;
  if (typeof data.originId !== "string" || !data.originId) return null;
  return {
    version: SENDER_PROFILE_VERSION,
    originId: data.originId,
    senderId: normalizeSenderId(data.senderId),
  };
}

/** Returns a city id only when `known` accepts it. Otherwise the profile is unset. */
export function resolveOriginId(raw, known) {
  const profile = parseSenderProfile(raw);
  if (!profile) return null;
  return known(profile.originId) ? profile.originId : null;
}
