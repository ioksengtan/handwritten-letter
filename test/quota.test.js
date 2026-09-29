import assert from "node:assert/strict";
import test from "node:test";
import {
  IN_FLIGHT_LIMIT,
  QUOTA_FULL_ERROR,
  quotaSnapshot,
  quotaWaitMessage,
  remainingLabel,
} from "../shared/quota.js";

function letter(patch) {
  return {
    status: "in_flight",
    senderId: "browser-sender-01",
    arrivesAt: "2026-10-10T04:00:00.000Z",
    ...patch,
  };
}

test("only this sender's in-flight letters fill the five slots", () => {
  const letters = [
    letter({}),
    letter({ arrivesAt: "2026-10-08T01:00:00.000Z" }),
    letter({ status: "delivered" }),
    letter({ status: "draft", arrivesAt: null }),
    letter({ senderId: "browser-sender-02" }),
    letter({ senderId: null }),
    letter({ senderId: undefined }),
  ];
  const quota = quotaSnapshot(letters, "browser-sender-01");
  assert.equal(IN_FLIGHT_LIMIT, 5);
  assert.equal(quota.inFlight, 2);
  assert.equal(quota.remaining, 3);
  assert.equal(quota.full, false);
  assert.equal(quota.soonestArrivesAt, "2026-10-08T01:00:00.000Z");
  assert.equal(remainingLabel(quota.remaining), "還可寄 3 封");
  assert.equal(quotaSnapshot(letters, "browser-sender-02").inFlight, 1);
  assert.equal(quotaSnapshot(letters, null).inFlight, 0);
});

test("a full sheet names the wait, and the cap ignores pace", () => {
  const letters = ["playable-fast", "romantic-slow", "playable-fast", "romantic-slow", "playable-fast"].map((pace, index) => (
    letter({
      pace,
      arrivesAt: new Date(Date.parse("2026-10-01T00:00:00.000Z") + index * 3600_000).toISOString(),
    })
  ));
  const quota = quotaSnapshot(letters, "browser-sender-01");
  assert.equal(quota.full, true);
  assert.equal(quota.remaining, 0);
  assert.equal(remainingLabel(0), "還可寄 0 封");
  assert.match(QUOTA_FULL_ERROR, /五封/);
  assert.match(QUOTA_FULL_ERROR, /送到/);
  assert.equal(quota.soonestArrivesAt, "2026-10-01T00:00:00.000Z");
  assert.match(quotaWaitMessage("10月1日 上午8:00"), /10月1日 上午8:00/);
  assert.match(quotaWaitMessage("10月1日 上午8:00"), /就能再寄/);
  assert.match(quotaWaitMessage(""), /送到之後/);
});
