import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function formatInZone(timeZone, iso) {
  const script = `
    import { browserTimeZone, formatPostalDate, formatPostalStamp } from "./shared/clock.js";
    const iso = ${JSON.stringify(iso)};
    process.stdout.write(JSON.stringify({
      zone: browserTimeZone(),
      stamp: formatPostalStamp(iso),
      date: formatPostalDate(iso),
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

test("the calendar day follows the browser zone", () => {
  // 世界標準時間 9/23 16:30 在台北已是 9/24 凌晨。
  const iso = "2026-09-23T16:30:00.000Z";
  const taipei = formatInZone("Asia/Taipei", iso);
  assert.match(taipei.date, /9\/24/);
  assert.match(taipei.stamp, /上午|凌晨/);
  const utc = formatInZone("UTC", iso);
  assert.match(utc.date, /9\/23/);
});
