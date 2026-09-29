/**
 * Sender profile for this browser.
 * There is no account yet. The shape is versioned so a later account can
 * store the same origin on the server and stop reading this key.
 *
 * { version: 1, originId: "<city id>" }
 */

export const SENDER_PROFILE_KEY = "on-the-way-sender";
export const SENDER_PROFILE_VERSION = 1;

export function serializeSenderProfile(originId) {
  return JSON.stringify({
    version: SENDER_PROFILE_VERSION,
    originId,
  });
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
  return { version: SENDER_PROFILE_VERSION, originId: data.originId };
}

/** Returns a city id only when `known` accepts it. Otherwise the profile is unset. */
export function resolveOriginId(raw, known) {
  const profile = parseSenderProfile(raw);
  if (!profile) return null;
  return known(profile.originId) ? profile.originId : null;
}
