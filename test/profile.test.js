import assert from "node:assert/strict";
import test from "node:test";
import {
  SENDER_PROFILE_VERSION,
  parseSenderProfile,
  resolveOriginId,
  serializeSenderProfile,
} from "../shared/profile.js";
import { POST_IRREVOCABLE } from "../shared/slip.js";
import { CITIES, findCity } from "../shared/recipients.js";

test("a sender profile round-trips and rejects anything that is not a known city", () => {
  for (const city of CITIES) {
    const raw = serializeSenderProfile(city.id);
    assert.equal(parseSenderProfile(raw).version, SENDER_PROFILE_VERSION);
    assert.equal(resolveOriginId(raw, (id) => findCity(id)), city.id);
  }
  assert.equal(resolveOriginId(serializeSenderProfile("taipei101"), (id) => findCity(id)), null);
  assert.equal(parseSenderProfile(""), null);
  assert.equal(parseSenderProfile("{"), null);
  assert.equal(parseSenderProfile("{}"), null);
  assert.equal(parseSenderProfile(JSON.stringify({ version: 2, originId: "taipei" })), null);
  assert.equal(parseSenderProfile(JSON.stringify({ version: 1 })), null);
});

test("the counter slip says a posted letter cannot be taken back or changed", () => {
  assert.match(POST_IRREVOCABLE, /不能收回/);
  assert.match(POST_IRREVOCABLE, /不能再改/);
  assert.equal(POST_IRREVOCABLE.includes("扔"), false);
});
