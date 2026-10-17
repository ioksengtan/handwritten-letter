import assert from "node:assert/strict";
import test from "node:test";
import { personRecipient, pickPerson, sameHomeCity } from "../shared/matching.js";
import { findCity } from "../shared/recipients.js";

function person(id, cityId) {
  return { id, nickname: id, cityId, createdAt: "2026-10-01T00:00:00.000Z" };
}

test("a real draw needs two people, skips self, and avoids the last person when it can", () => {
  assert.equal(pickPerson({ senders: [], selfId: "live-sender-a1" }), null);
  assert.equal(pickPerson({ senders: [person("live-sender-a1")], selfId: "live-sender-a1" }), null);

  const pair = [
    person("live-sender-a1", "taipei"),
    person("live-sender-b1", "hong-kong"),
  ];
  const only = pickPerson({ senders: pair, selfId: "live-sender-a1", random: () => 0 });
  assert.equal(only.id, "live-sender-b1");
  const still = pickPerson({
    senders: pair,
    selfId: "live-sender-a1",
    excludeIds: ["live-sender-b1"],
    random: () => 0,
  });
  assert.equal(still.id, "live-sender-b1");

  const three = [...pair, person("live-sender-c1", "seoul")];
  const first = pickPerson({ senders: three, selfId: "live-sender-a1", random: () => 0 });
  assert.equal(first.id, "live-sender-b1");
  const next = pickPerson({
    senders: three,
    selfId: "live-sender-a1",
    excludeIds: ["live-sender-b1"],
    random: () => 0,
  });
  assert.equal(next.id, "live-sender-c1");
  assert.notEqual(next.id, "live-sender-a1");
});

test("someone who blocked this sender, or who lives in the same city, is not drawn", () => {
  const senders = [
    person("live-sender-a1", "taipei"),
    person("live-sender-b1", "hong-kong"),
    person("live-sender-c1", "seoul"),
  ];
  const blocked = pickPerson({
    senders,
    selfId: "live-sender-a1",
    blockedIds: ["live-sender-b1"],
    random: () => 0,
  });
  assert.equal(blocked.id, "live-sender-c1");
  assert.equal(pickPerson({
    senders: senders.slice(0, 2),
    selfId: "live-sender-a1",
    blockedIds: ["live-sender-b1"],
  }), null);

  const taipei = findCity("taipei");
  assert.equal(sameHomeCity(taipei, taipei), true);
  assert.equal(sameHomeCity(taipei, findCity("hong-kong")), false);
  const skipped = pickPerson({
    senders,
    selfId: "live-sender-a1",
    skipIds: ["live-sender-b1", "live-sender-a1"],
    random: () => 0,
  });
  assert.equal(skipped.id, "live-sender-c1");

  const addressed = personRecipient(senders[1], findCity("hong-kong"));
  assert.equal(addressed.demo, false);
  assert.equal(addressed.name, "live-sender-b1");
  assert.equal(addressed.city, "香港");
  assert.equal(addressed.cityId, "hong-kong");
});
