import assert from "node:assert/strict";
import test from "node:test";
import {
  alignLongitude,
  bearingDegrees,
  describeFlight,
  flightDurationSeconds,
  haversineKm,
  interpolate,
  samplePath,
  unwrapLongitudes,
} from "../shared/flight.js";
import { findPlace, PRESETS } from "../shared/places.js";

test("playable-fast pacing bands", () => {
  assert.equal(flightDurationSeconds(0, "playable-fast"), 25);
  assert.equal(flightDurationSeconds(5, "playable-fast"), 27);
  assert.equal(flightDurationSeconds(300, "playable-fast"), 208);
  assert.equal(flightDurationSeconds(12000, "playable-fast"), 1080);
  assert.ok(flightDurationSeconds(12000, "playable-fast") >= 10 * 60);
  assert.ok(flightDurationSeconds(12000, "playable-fast") <= 20 * 60);
});

test("romantic-slow is the reserved slower pace", () => {
  assert.equal(flightDurationSeconds(12000, "romantic-slow"), 5400);
  assert.ok(
    flightDurationSeconds(300, "romantic-slow") >
      flightDurationSeconds(300, "playable-fast"),
  );
});

test("unknown pace is rejected", () => {
  assert.throws(() => flightDurationSeconds(10, "instant"));
});

test("preset routes match the intended pacing", () => {
  const taipei = findPlace("taipei");
  const kaohsiung = findPlace("kaohsiung");
  const tokyo = findPlace("tokyo");
  const taipei101 = findPlace("taipei101");

  const localKm = haversineKm(taipei.lat, taipei.lng, taipei101.lat, taipei101.lng);
  const islandKm = haversineKm(taipei.lat, taipei.lng, kaohsiung.lat, kaohsiung.lng);
  const overseasKm = haversineKm(taipei.lat, taipei.lng, tokyo.lat, tokyo.lng);

  assert.ok(localKm > 3 && localKm < 15, localKm);
  assert.ok(islandKm > 250 && islandKm < 360, islandKm);
  assert.ok(overseasKm > 1800 && overseasKm < 2500, overseasKm);
  assert.ok(overseasKm > islandKm);

  const localSec = flightDurationSeconds(localKm, "playable-fast");
  const islandSec = flightDurationSeconds(islandKm, "playable-fast");
  const overseasSec = flightDurationSeconds(overseasKm, "playable-fast");

  assert.ok(localSec >= 20 && localSec <= 90, localSec);
  assert.ok(islandSec >= 60 && islandSec <= 6 * 60, islandSec);
  assert.ok(overseasSec > islandSec);
  assert.ok(overseasSec < 18 * 60, overseasSec);

  assert.ok(PRESETS.some((preset) => preset.from === "taipei" && preset.to === "kaohsiung"));
  assert.ok(PRESETS.some((preset) => preset.from === "taipei" && preset.to === "tokyo"));
});

test("progress follows time along the great circle and does not teleport", () => {
  const from = findPlace("taipei");
  const to = findPlace("kaohsiung");
  const distanceKm = haversineKm(from.lat, from.lng, to.lat, to.lng);
  const letter = {
    status: "in_flight",
    from,
    to,
    distanceKm,
    departedAt: new Date(0).toISOString(),
    arrivesAt: new Date(200_000).toISOString(),
  };

  const start = describeFlight(letter, 0);
  const mid = describeFlight(letter, 50_000);
  const almost = describeFlight(letter, 199_000);
  const landed = describeFlight(letter, 200_000);

  assert.equal(start.progress, 0);
  assert.equal(start.status, "in_flight");
  assert.ok(Math.abs(start.position.lat - from.lat) < 1e-8);
  assert.ok(Math.abs(start.position.lng - from.lng) < 1e-8);

  assert.ok(mid.progress > 0.24 && mid.progress < 0.26);
  assert.equal(mid.status, "in_flight");
  assert.ok(almost.progress < 1);
  assert.equal(almost.status, "in_flight");

  assert.equal(landed.progress, 1);
  assert.equal(landed.status, "delivered");
  assert.equal(landed.etaSeconds, 0);
  assert.ok(Math.abs(landed.position.lat - to.lat) < 1e-6);
  assert.ok(Math.abs(landed.position.lng - to.lng) < 1e-6);

  const remainStart = haversineKm(start.position.lat, start.position.lng, to.lat, to.lng);
  const remainMid = haversineKm(mid.position.lat, mid.position.lng, to.lat, to.lng);
  assert.ok(remainMid < remainStart - 50);

  const halfway = interpolate(from.lat, from.lng, to.lat, to.lng, 0.5);
  assert.ok(halfway.lat < from.lat && halfway.lat > to.lat);
  assert.ok(halfway.lng < from.lng && halfway.lng > to.lng);
});

test("path samples include both ends", () => {
  const from = findPlace("taipei");
  const to = findPlace("tokyo");
  const path = samplePath(from, to, 8);
  assert.equal(path.length, 9);
  assert.ok(Math.abs(path[0].lat - from.lat) < 1e-8);
  assert.ok(Math.abs(path.at(-1).lng - to.lng) < 1e-6);
  const bearing = bearingDegrees(from.lat, from.lng, to.lat, to.lng);
  assert.ok(bearing > 30 && bearing < 80, bearing);
});

test("paths across the Pacific unwrap the short way", () => {
  const path = unwrapLongitudes(samplePath(
    { lat: 25.047924, lng: 121.517081 },
    { lat: 40.758, lng: -73.9855 },
    24,
  ));
  assert.equal(path.length, 25);
  for (let i = 1; i < path.length; i += 1) {
    assert.ok(Math.abs(path[i].lng - path[i - 1].lng) <= 180);
  }
  const span = Math.abs(path.at(-1).lng - path[0].lng);
  assert.ok(span < 200 && span > 100, span);
  assert.equal(alignLongitude(-73.9855, 121.517081), -73.9855 + 360);
});

test("a stored delivered letter stays at the destination", () => {
  const from = findPlace("taipei");
  const to = findPlace("taipei101");
  const letter = {
    status: "delivered",
    from,
    to,
    distanceKm: 5,
    departedAt: new Date(0).toISOString(),
    arrivesAt: new Date(30_000).toISOString(),
  };
  const view = describeFlight(letter, 1_000);
  assert.equal(view.status, "delivered");
  assert.equal(view.progress, 1);
  assert.ok(Math.abs(view.position.lat - to.lat) < 1e-6);
});
