import assert from "node:assert/strict";
import test from "node:test";
import { findRecipient } from "../shared/recipients.js";
import { CITIES } from "../shared/recipients.js";
import {
  LAND_RADIUS_KM,
  collectPassport,
  nearestGazetteer,
  planStops,
  postmarkSvg,
  revealStops,
} from "../shared/marks.js";

const taipei = CITIES.find((city) => city.id === "taipei");
const tokyo = CITIES.find((city) => city.id === "tokyo");
const london = findRecipient("ellen");
const newYork = findRecipient("noah");

test("taipei to london stamps the ends and land cities, and skips the ocean", () => {
  const stops = planStops(taipei, london);
  assert.equal(stops[0].role, "origin");
  assert.equal(stops[0].country, "台灣");
  assert.equal(stops.at(-1).role, "destination");
  assert.equal(stops.at(-1).city, "倫敦");
  assert.ok(stops.some((stop) => stop.role === "via" && stop.country === "中國"));
  assert.ok(stops.some((stop) => stop.role === "via" && stop.country !== "台灣" && stop.country !== "英國"));

  const ocean = nearestGazetteer(0, -150);
  assert.ok(ocean.km > LAND_RADIUS_KM);

  const across = planStops(tokyo, newYork);
  const midOcean = across.filter((stop) => stop.role === "via" && stop.t > 0.15 && stop.t < 0.75);
  assert.equal(midOcean.length, 0);
});

test("stamps appear only as far as the pigeon has flown", () => {
  const stops = planStops(taipei, london);
  const half = revealStops(stops, 0.5);
  assert.ok(half.some((stop) => stop.role === "origin"));
  assert.ok(half.some((stop) => stop.role === "via"));
  assert.equal(half.some((stop) => stop.role === "destination"), false);
  assert.equal(half.some((stop) => stop.city === "已送達"), false);
  assert.ok(half.every((stop) => stop.t <= 0.5 + 1e-9));

  const full = revealStops(stops, 0.2, { delivered: true });
  assert.ok(full.some((stop) => stop.role === "destination" && stop.city === "倫敦"));
  assert.equal(full.at(-1).city, "已送達");
  assert.equal(full.at(-1).role, "arrived");
});

test("a postmark is a tilted vector drawing, not an image", () => {
  const svg = postmarkSvg(
    { role: "via", city: "上海", country: "中國" },
    { date: "10.4" },
  );
  assert.match(svg, /<svg/);
  assert.match(svg, /上海/);
  assert.match(svg, /中國/);
  assert.match(svg, /10\.4/);
  assert.match(svg, /rotate\(-?\d/);
  assert.doesNotMatch(svg, /<image/);
  assert.doesNotMatch(svg, /data:image/);
});

test("the passport keeps the first visit to a country and ignores other senders", () => {
  const sender = "passport-sender-01";
  const departedAt = "2026-10-01T00:00:00.000Z";
  const arrivesAt = "2026-10-11T00:00:00.000Z";
  const halfway = Date.parse(departedAt) + 0.5 * (Date.parse(arrivesAt) - Date.parse(departedAt));
  const letter = {
    status: "in_flight",
    senderId: sender,
    from: taipei,
    to: london,
    departedAt,
    arrivesAt,
  };
  const book = collectPassport([
    letter,
    { ...letter, senderId: null },
    { ...letter, senderId: "other-sender-01" },
    { senderId: sender, status: "in_flight", from: null },
    null,
  ], sender, halfway);
  assert.ok(book.some((stamp) => stamp.country === "台灣"));
  assert.ok(book.some((stamp) => stamp.country === "中國"));
  assert.equal(book.some((stamp) => stamp.country === "英國"), false);
  assert.equal(book.filter((stamp) => stamp.country === "俄羅斯").length, 1);

  const delivered = collectPassport([
    { ...letter, status: "delivered" },
  ], sender, Date.parse(arrivesAt) + 1000);
  assert.ok(delivered.some((stamp) => stamp.country === "英國"));

  const earlier = collectPassport([
    {
      ...letter,
      status: "delivered",
      departedAt: "2026-09-01T00:00:00.000Z",
      arrivesAt: "2026-09-11T00:00:00.000Z",
    },
    { ...letter, status: "delivered" },
  ], sender, Date.parse("2026-11-01T00:00:00.000Z"));
  const home = earlier.find((stamp) => stamp.country === "台灣");
  assert.equal(home.at.slice(0, 10), "2026-09-01");
  assert.equal(earlier.filter((stamp) => stamp.country === "英國").length, 1);
});

test("a passport with no sender id is empty and does not throw", () => {
  const letter = {
    status: "delivered",
    from: taipei,
    to: london,
    departedAt: "2026-10-01T00:00:00.000Z",
    arrivesAt: "2026-10-11T00:00:00.000Z",
  };
  assert.deepEqual(collectPassport([letter], null), []);
  assert.deepEqual(collectPassport([letter], ""), []);
  assert.deepEqual(collectPassport([{ status: "delivered" }, null, undefined], "passport-sender-01"), []);
});
