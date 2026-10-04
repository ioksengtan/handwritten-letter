import assert from "node:assert/strict";
import test from "node:test";
import { formatSlipArrival, formatZonedDay, zoneForPlace } from "../shared/slip.js";

test("the counter slip names the destination date and local time", () => {
  // 2026-10-14 18:00 UTC is 14 October, 2:00 p.m. in New York (summer time).
  const slip = formatSlipArrival("2026-10-14T18:00:00.000Z", {
    city: "紐約",
    cityId: "new-york",
  });
  assert.equal(slip.sentence, "預計 10 月 14 日抵達紐約");
  assert.match(slip.localTime, /^當地時間 /);
  assert.match(slip.localTime, /2:00/);
  assert.match(slip.localTime, /下午/);
});

test("an unknown destination does not claim a local time", () => {
  const slip = formatSlipArrival("2026-10-14T18:00:00.000Z", {
    city: "海市",
    id: "nowhere",
  });
  assert.equal(slip.sentence, "");
  assert.equal(slip.localTime, "");
  assert.equal(zoneForPlace({ id: "taipei101" }), "Asia/Taipei");
  assert.equal(formatZonedDay("2026-10-14T18:00:00.000Z", "America/New_York"), "10.14");
  assert.equal(formatZonedDay("2026-10-14T18:00:00.000Z", ""), "");
});
