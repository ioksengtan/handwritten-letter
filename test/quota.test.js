import assert from "node:assert/strict";
import test from "node:test";
import {
  SLOT_CAP,
  deliveriesUntilNextSlot,
  nextSlotNote,
  quotaFullError,
  quotaSnapshot,
  quotaWaitMessage,
  remainingLabel,
  slotLimit,
} from "../shared/quota.js";

function letter(patch) {
  return {
    status: "in_flight",
    senderId: "browser-sender-01",
    arrivesAt: "2026-10-10T04:00:00.000Z",
    ...patch,
  };
}

function delivered(count, senderId = "browser-sender-01") {
  return Array.from({ length: count }, () => letter({ status: "delivered", arrivesAt: "2026-09-01T00:00:00.000Z", senderId }));
}

test("only this sender's in-flight letters fill the slots", () => {
  const letters = [
    letter({}),
    letter({ arrivesAt: "2026-10-08T01:00:00.000Z" }),
    letter({ status: "delivered" }),
    letter({ status: "draft", arrivesAt: null }),
    letter({ senderId: "browser-sender-02" }),
    letter({ status: "delivered", senderId: "browser-sender-02" }),
    letter({ status: "delivered", senderId: null }),
    letter({ senderId: null }),
    letter({ senderId: undefined }),
  ];
  const quota = quotaSnapshot(letters, "browser-sender-01");
  assert.equal(quota.delivered, 1);
  assert.equal(quota.limit, 5);
  assert.equal(quota.inFlight, 2);
  assert.equal(quota.remaining, 3);
  assert.equal(quota.full, false);
  assert.equal(quota.soonestArrivesAt, "2026-10-08T01:00:00.000Z");
  assert.equal(remainingLabel(quota.remaining), "還可寄 3 封");
  assert.equal(quota.nextNote, "再送達 4 封就多一格");
  assert.equal(quotaSnapshot(letters, "browser-sender-02").inFlight, 1);
  assert.equal(quotaSnapshot(letters, "browser-sender-02").delivered, 1);
  assert.equal(quotaSnapshot(letters, null).inFlight, 0);
  assert.equal(quotaSnapshot(letters, null).delivered, 0);
});

test("each delivered-count boundary sets the slot count and fifty is the cap of ten", () => {
  const table = [
    [0, 5, 5],
    [4, 5, 1],
    [5, 6, 10],
    [14, 6, 1],
    [15, 7, 10],
    [24, 7, 1],
    [25, 8, 10],
    [34, 8, 1],
    [35, 9, 15],
    [49, 9, 1],
    [50, 10, null],
    [99, 10, null],
    [150, 10, null],
  ];
  for (const [deliveredCount, slots, untilNext] of table) {
    assert.equal(slotLimit(deliveredCount), slots, `delivered ${deliveredCount}`);
    assert.equal(deliveriesUntilNextSlot(deliveredCount), untilNext, `next after ${deliveredCount}`);
    assert.ok(slots <= SLOT_CAP);
    const quota = quotaSnapshot(delivered(deliveredCount), "browser-sender-01");
    assert.equal(quota.limit, slots);
    assert.equal(quota.delivered, deliveredCount);
    assert.equal(quota.inFlight, 0);
    assert.equal(quota.full, false);
    if (untilNext == null) assert.equal(quota.nextNote, "");
    else assert.equal(quota.nextNote, `再送達 ${untilNext} 封就多一格`);
  }
  assert.equal(slotLimit(50), 10);
  assert.equal(slotLimit(1000), 10);
});

test("a full sheet names the wait, and five deliveries open a sixth slot", () => {
  const flying = ["playable-fast", "romantic-slow", "playable-fast", "romantic-slow", "playable-fast"].map((pace, index) => (
    letter({
      pace,
      arrivesAt: new Date(Date.parse("2026-10-01T00:00:00.000Z") + index * 3600_000).toISOString(),
    })
  ));
  const blocked = quotaSnapshot(flying, "browser-sender-01");
  assert.equal(blocked.full, true);
  assert.equal(blocked.limit, 5);
  assert.equal(remainingLabel(0), "還可寄 0 封");
  assert.match(quotaFullError(blocked.limit), /5 封/);
  assert.match(quotaFullError(6), /6 封/);
  assert.match(quotaFullError(blocked.limit), /送到/);
  assert.equal(blocked.soonestArrivesAt, "2026-10-01T00:00:00.000Z");
  assert.match(quotaWaitMessage("10月1日 上午8:00"), /10月1日 上午8:00/);
  assert.match(quotaWaitMessage("10月1日 上午8:00"), /就能再寄/);
  assert.match(quotaWaitMessage(""), /送到之後/);

  const opened = quotaSnapshot([...flying, ...delivered(5)], "browser-sender-01");
  assert.equal(opened.delivered, 5);
  assert.equal(opened.limit, 6);
  assert.equal(opened.inFlight, 5);
  assert.equal(opened.full, false);
  assert.equal(opened.remaining, 1);
  assert.equal(opened.nextNote, "再送達 10 封就多一格");

  const capped = quotaSnapshot([...Array.from({ length: 10 }, () => letter({})), ...delivered(50)], "browser-sender-01");
  assert.equal(capped.limit, 10);
  assert.equal(capped.full, true);
  assert.equal(capped.nextNote, "");
  assert.equal(quotaFullError(capped.limit), "路上已經有 10 封信。等最早的那封送到，才能再寄。");
});
