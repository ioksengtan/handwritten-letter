import assert from "node:assert/strict";
import test from "node:test";
import { flightDurationSeconds, haversineKm } from "../shared/flight.js";
import { CITIES, RECIPIENTS, findCity, findRecipient, pickRecipient } from "../shared/recipients.js";

test("the pool spans continents", () => {
  assert.ok(RECIPIENTS.length >= 12 && RECIPIENTS.length <= 24);
  const continents = new Set(RECIPIENTS.map((recipient) => recipient.continent));
  assert.ok(continents.has("亞洲"));
  assert.ok(continents.has("歐洲"));
  assert.ok(continents.has("非洲"));
  assert.ok(continents.has("美洲"));
  assert.ok(continents.has("大洋洲"));
  assert.equal(CITIES.length, RECIPIENTS.length);
  assert.equal(new Set(RECIPIENTS.map((recipient) => recipient.cityId)).size, RECIPIENTS.length);
});

test("a draw skips the sender city and the person just drawn", () => {
  const taipei = findCity("taipei");
  const first = pickRecipient({ from: taipei, random: () => 0 });
  assert.notEqual(first.cityId, "taipei");
  assert.ok(haversineKm(taipei.lat, taipei.lng, first.lat, first.lng) >= 30);

  const second = pickRecipient({
    from: taipei,
    excludeIds: [first.id],
    random: () => 0,
  });
  assert.notEqual(second.id, first.id);

  const far = pickRecipient({ from: taipei, random: () => 0.999 });
  assert.ok(findRecipient(far.id));
  const seconds = flightDurationSeconds(
    haversineKm(taipei.lat, taipei.lng, far.lat, far.lng),
    "playable-fast",
  );
  assert.ok(seconds >= 25 && seconds <= 18 * 60);
});
