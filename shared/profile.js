/**
 * Sender profile for this browser.
 * There is still no account, no email, and no password. The shape is
 * versioned so a later account can store the same origin on the server
 * and stop reading this key.
 *
 * { version: 1, originId, senderId, nickname, ofAge: true }
 *
 * senderId is created with the region and sent on every letter. Letters
 * mailed before this field existed have no senderId and do not count
 * toward the in-flight limit. A new browser, or a new id, starts over.
 * nickname and ofAge were added later. Older profiles still parse; the
 * page asks for them once, and keeps the same sender id and region.
 */

import { findContactKinds } from "./contact.js";

export const SENDER_PROFILE_KEY = "on-the-way-sender";
export const SENDER_PROFILE_VERSION = 1;
export const AGE_REQUIRED = "未滿 16 歲不能使用。";

export function normalizeSenderId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/.test(id)) return null;
  return id;
}

/** A short display name. Contact details are rejected by the caller. */
export function normalizeNickname(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 20) return null;
  if (/[\u0000-\u001f]/.test(name)) return null;
  if (!/^[\p{L}\p{N}]+(?:[ .・·'’-][\p{L}\p{N}]+)*$/u.test(name)) return null;
  if (findContactKinds(name).length) return null;
  return name;
}

export function serializeSenderProfile(originId, senderId, extras = {}) {
  const body = {
    version: SENDER_PROFILE_VERSION,
    originId,
  };
  const id = normalizeSenderId(senderId);
  if (id) body.senderId = id;
  const nickname = normalizeNickname(extras.nickname);
  if (nickname) body.nickname = nickname;
  if (extras.ofAge === true) body.ofAge = true;
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
    nickname: normalizeNickname(data.nickname),
    ofAge: data.ofAge === true,
  };
}

/** Returns a city id only when `known` accepts it. Otherwise the profile is unset. */
export function resolveOriginId(raw, known) {
  const profile = parseSenderProfile(raw);
  if (!profile) return null;
  return known(profile.originId) ? profile.originId : null;
}
