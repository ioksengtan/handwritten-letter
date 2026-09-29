import assert from "node:assert/strict";
import test from "node:test";
import {
  describeFlight,
  flightDurationSeconds,
  haversineKm,
  interpolate,
  postalBand,
  routeJitterSeconds,
} from "../shared/flight.js";
import { findPlace } from "../shared/places.js";
import { findRecipient } from "../shared/recipients.js";
import { backgroundPlans, planCourier } from "../shared/route.js";

function place(id) {
  const point = findPlace(id);
  return { name: point.name, country: point.country, lat: point.lat, lng: point.lng };
}

function person(id) {
  const point = findRecipient(id);
  return {
    name: point.city,
    country: point.country,
    continent: point.continent,
    lat: point.lat,
    lng: point.lng,
  };
}

test("every trip is one pigeon on the great circle", () => {
  const local = planCourier({ from: place("taipei"), to: place("taipei101") });
  const island = planCourier({ from: place("taipei"), to: place("kaohsiung") });
  const noah = findRecipient("noah");
  const overseas = planCourier({
    from: place("taipei"),
    to: { name: noah.city, country: noah.country, lat: noah.lat, lng: noah.lng },
    pace: "playable-fast",
  });

  for (const plan of [local, island, overseas]) {
    assert.equal(plan.legs.length, 1);
    assert.equal(plan.legs[0].mode, "pigeon");
    assert.equal(plan.legs[0].from.name, plan.from.name);
    assert.equal(plan.legs[0].to.name, plan.to.name);
    assert.equal(plan.legs[0].durationSeconds, plan.durationSeconds);
    assert.equal(plan.legs[0].distanceKm, plan.distanceKm);
  }
  assert.equal(island.legs[0].to.name, "高雄");
  assert.ok(island.durationSeconds > local.durationSeconds);
  assert.equal(overseas.durationSeconds, 18 * 60);
  assert.equal(overseas.to.name, "紐約");
});

const DAY = 24 * 60 * 60;

test("romantic-slow is the default and matches postal waits", () => {
  const city = planCourier({ from: place("taipei"), to: place("taipei101") });
  const taichung = planCourier({ from: place("taipei"), to: place("taichung") });
  const island = planCourier({ from: place("taipei"), to: place("kaohsiung") });
  const tokyo = planCourier({ from: place("taipei"), to: place("tokyo") });
  const hongKong = planCourier({ from: place("taipei"), to: person("jiahui") });
  const london = planCourier({ from: place("taipei"), to: person("ellen") });
  const londonAgain = planCourier({ from: place("taipei"), to: person("ellen") });
  const nyc = planCourier({ from: place("taipei"), to: person("noah") });
  const sydney = planCourier({ from: place("taipei"), to: person("owen") });

  assert.equal(city.pace, "romantic-slow");
  assert.equal(postalBand(city.distanceKm, place("taipei"), place("taipei101")), "city");
  assert.equal(postalBand(island.distanceKm, place("taipei"), place("kaohsiung")), "domestic");
  assert.equal(postalBand(taichung.distanceKm, place("taipei"), place("taichung")), "domestic");
  assert.equal(postalBand(tokyo.distanceKm, place("taipei"), place("tokyo")), "region");
  assert.equal(postalBand(hongKong.distanceKm, place("taipei"), person("jiahui")), "region");
  assert.equal(postalBand(london.distanceKm, place("taipei"), person("ellen")), "far");

  assert.ok(city.durationSeconds >= DAY && city.durationSeconds <= 1.25 * DAY, city.durationSeconds);
  assert.ok(taichung.durationSeconds >= 2 * DAY && taichung.durationSeconds <= 3 * DAY, taichung.durationSeconds);
  assert.ok(island.durationSeconds >= 2 * DAY && island.durationSeconds <= 3 * DAY, island.durationSeconds);
  assert.ok(tokyo.durationSeconds >= 4 * DAY && tokyo.durationSeconds <= 6 * DAY, tokyo.durationSeconds);
  assert.ok(hongKong.durationSeconds >= 4 * DAY && hongKong.durationSeconds <= 6 * DAY, hongKong.durationSeconds);
  assert.ok(london.durationSeconds >= 8 * DAY && london.durationSeconds <= 10 * DAY, london.durationSeconds);
  assert.ok(nyc.durationSeconds >= 9 * DAY && nyc.durationSeconds <= 12 * DAY, nyc.durationSeconds);
  assert.ok(sydney.durationSeconds >= 7 * DAY && sydney.durationSeconds < london.durationSeconds, sydney.durationSeconds);
  assert.ok(city.durationSeconds < island.durationSeconds);
  assert.ok(island.durationSeconds < tokyo.durationSeconds);
  assert.ok(tokyo.durationSeconds < london.durationSeconds);
  assert.ok(london.durationSeconds < nyc.durationSeconds);
  assert.equal(london.durationSeconds, londonAgain.durationSeconds);
  assert.equal(london.legs[0].durationSeconds, london.durationSeconds);

  const jitter = routeJitterSeconds(place("taipei"), person("ellen"), london.distanceKm);
  assert.equal(jitter, routeJitterSeconds(place("taipei"), person("ellen"), london.distanceKm));
  assert.ok(Math.abs(jitter) <= 4 * 60 * 60, jitter);
  const plain = flightDurationSeconds(london.distanceKm, "romantic-slow", {
    from: place("taipei"),
    to: person("ellen"),
    vary: false,
  });
  assert.ok(Math.abs(london.durationSeconds - plain) <= 4 * 60 * 60);
  const samples = ["ellen", "noah", "aoi", "jiahui", "sari"].map((id) => (
    Math.abs(routeJitterSeconds(place("taipei"), person(id), 1000))
  ));
  assert.ok(samples.some((value) => value >= 30 * 60), samples.join(","));
});

test("a pigeon moves linearly along the great circle", () => {
  const from = place("taipei");
  const ellen = person("ellen");
  const plan = planCourier({ from, to: ellen });
  const start = Date.parse("2026-09-29T00:00:00.000Z");
  const letter = {
    status: "in_flight",
    from,
    to: ellen,
    distanceKm: plan.distanceKm,
    legs: plan.legs,
    departedAt: new Date(start).toISOString(),
    arrivesAt: new Date(start + plan.durationSeconds * 1000).toISOString(),
  };
  const at = (fraction) => describeFlight(letter, start + fraction * plan.durationSeconds * 1000);
  const early = at(0.05);
  assert.equal(early.status, "in_flight");
  assert.equal(early.mode, "pigeon");
  assert.equal(early.legIndex, null);
  assert.ok(Math.abs(early.progress - 0.05) < 0.002, early.progress);
  const mid = at(0.5);
  const direct = interpolate(from.lat, from.lng, ellen.lat, ellen.lng, 0.5);
  assert.ok(Math.abs(mid.position.lat - direct.lat) < 1e-6);
  assert.ok(Math.abs(mid.position.lng - direct.lng) < 1e-6);
  assert.ok(Math.abs(mid.remainingKm - plan.distanceKm * 0.5) < 0.01);
  const done = describeFlight(
    { ...letter, status: "delivered" },
    start + plan.durationSeconds * 1000,
  );
  assert.equal(done.progress, 1);
  assert.equal(done.etaSeconds, 0);
  assert.equal(done.remainingKm, 0);
  assert.ok(Math.abs(done.position.lat - ellen.lat) < 1e-6);
});

test("an older multi-leg letter still flies one pigeon line and arrives", () => {
  const from = place("taipei");
  const ellen = person("ellen");
  const distanceKm = haversineKm(from.lat, from.lng, ellen.lat, ellen.lng);
  const letter = {
    status: "in_flight",
    from,
    to: ellen,
    distanceKm,
    legs: [
      { mode: "road", from, to: { name: "桃園機場", lat: 25.0777, lng: 121.2328 }, distanceKm: 30, durationSeconds: 4 * DAY },
      { mode: "plane", from: { name: "桃園機場", lat: 25.0777, lng: 121.2328 }, to: { name: "希斯洛機場", lat: 51.47, lng: -0.4543 }, distanceKm: 9700, durationSeconds: 16 * 3600 },
      { mode: "road", from: { name: "希斯洛機場", lat: 51.47, lng: -0.4543 }, to: ellen, distanceKm: 20, durationSeconds: 4 * DAY },
    ],
    departedAt: new Date(0).toISOString(),
    arrivesAt: new Date(10 * DAY * 1000).toISOString(),
  };
  const mid = describeFlight(letter, 5 * DAY * 1000);
  const direct = interpolate(from.lat, from.lng, ellen.lat, ellen.lng, 0.5);
  assert.equal(mid.status, "in_flight");
  assert.equal(mid.mode, "pigeon");
  assert.equal(mid.legIndex, null);
  assert.ok(Math.abs(mid.position.lat - direct.lat) < 1e-6);
  assert.ok(Math.abs(mid.position.lng - direct.lng) < 1e-6);
  assert.ok(haversineKm(mid.position.lat, mid.position.lng, 25.0777, 121.2328) > 100);

  const done = describeFlight(letter, 10 * DAY * 1000);
  assert.equal(done.status, "delivered");
  assert.equal(done.progress, 1);
  assert.equal(done.remainingKm, 0);
  assert.ok(Math.abs(done.position.lat - ellen.lat) < 1e-6);
  assert.ok(Math.abs(done.position.lng - ellen.lng) < 1e-6);
});

test("background trips stay in transit without letter faces", () => {
  const plans = backgroundPlans();
  assert.ok(plans.length >= 6);
  const ids = new Set(plans.map((item) => item.id));
  assert.equal(ids.size, plans.length);
  for (const item of plans) {
    assert.equal(item.plan.legs.length, 1);
    assert.equal(item.plan.legs[0].mode, "pigeon");
    assert.equal(item.plan.legs.some((leg) => leg.imageUrl), false);
    assert.equal(item.plan.from.name, item.plan.legs[0].from.name);
    assert.equal(item.plan.to.name, item.plan.legs[0].to.name);
  }
});
