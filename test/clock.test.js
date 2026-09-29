import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { formatCountdown, formatSpan } from "../shared/clock.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function formatInZone(timeZone, iso) {
  const script = `
    import { browserTimeZone, formatArrival, formatPostalDate, formatPostalStamp } from "./shared/clock.js";
    const iso = ${JSON.stringify(iso)};
    process.stdout.write(JSON.stringify({
      zone: browserTimeZone(),
      stamp: formatPostalStamp(iso),
      date: formatPostalDate(iso),
      arrival: formatArrival(iso),
    }));
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    env: { ...process.env, TZ: timeZone },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  return JSON.parse(run.stdout);
}

test("a letter sent at Taipei noon shows afternoon, not early morning", () => {
  // 台北中午 = 世界標準時間凌晨 4 點。瀏覽器時區若是台北，不該顯示成上午 4 點。
  const noonUtc = "2026-09-24T04:00:00.000Z";
  const taipei = formatInZone("Asia/Taipei", noonUtc);
  assert.equal(taipei.zone, "Asia/Taipei");
  assert.match(taipei.stamp, /下午|中午/);
  assert.match(taipei.stamp, /12/);
  assert.doesNotMatch(taipei.stamp, /上午/);
  assert.doesNotMatch(taipei.stamp, /凌晨/);

  const utc = formatInZone("UTC", noonUtc);
  assert.equal(utc.zone, "UTC");
  assert.match(utc.stamp, /上午/);
  assert.match(utc.stamp, /4/);
  assert.notEqual(taipei.stamp, utc.stamp);
});

test("a multi-day wait is spoken in days and hours", () => {
  const seconds = 8 * 86400 + 5 * 3600 + 40 * 60;
  assert.equal(formatCountdown(seconds), "還有 8 天 5 小時");
  assert.equal(formatSpan(seconds), "8 天 5 小時");
  assert.equal(formatCountdown(26 * 3600), "還有 1 天 2 小時");
  assert.equal(formatCountdown(86400), "還有 1 天");
  assert.equal(formatCountdown(90), "還有 1 分 30 秒");
  assert.equal(formatCountdown(0.2), "即將抵達");
  assert.equal(formatSpan(27), "27 秒");
  assert.equal(formatSpan(3 * 60 + 27), "3 分 27 秒");
  assert.equal(formatSpan(18 * 60), "18 分鐘");
});

test("the calendar day follows the browser zone", () => {
  // 世界標準時間 9/23 16:30 在台北已是 9/24 凌晨。
  const iso = "2026-09-23T16:30:00.000Z";
  const taipei = formatInZone("Asia/Taipei", iso);
  assert.match(taipei.date, /9\/24/);
  assert.match(taipei.stamp, /上午|凌晨/);
  const utc = formatInZone("UTC", iso);
  assert.match(utc.date, /9\/23/);
});

test("the expected arrival includes the calendar day in the browser zone", () => {
  const iso = "2026-10-07T07:20:00.000Z";
  const taipei = formatInZone("Asia/Taipei", iso);
  assert.equal(taipei.arrival, "10月7日 下午3:20");
  const utc = formatInZone("UTC", iso);
  assert.equal(utc.arrival, "10月7日 上午7:20");
  assert.notEqual(taipei.arrival, utc.arrival);
});
