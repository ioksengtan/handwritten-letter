import assert from "node:assert/strict";
import test from "node:test";
import {
  describeFlight,
  flightDurationSeconds,
  haversineKm,
  locateOnLegs,
  postalBand,
  routeJitterSeconds,
} from "../shared/flight.js";
import { findPlace } from "../shared/places.js";
import { findRecipient } from "../shared/recipients.js";
import {
  backgroundPlans,
  legProgressLine,
  legVia,
  nearestHub,
  planCourier,
  transferBeat,
} from "../shared/route.js";

function place(id) {
  const point = findPlace(id);
  return { name: point.name, country: point.country, lat: point.lat, lng: point.lng };
}

test("short hops stay on the road and island hops take the train", () => {
  const local = planCourier({ from: place("taipei"), to: place("taipei101") });
  assert.deepEqual(local.legs.map((leg) => leg.mode), ["road"]);
  assert.equal(local.legs[0].durationSeconds, local.durationSeconds);

  const island = planCourier({ from: place("taipei"), to: place("kaohsiung") });
  assert.deepEqual(island.legs.map((leg) => leg.mode), ["train"]);
  assert.equal(island.legs[0].to.name, "高雄");
  assert.ok(island.durationSeconds > local.durationSeconds);
});

test("an overseas letter goes road, plane, then road", () => {
  const noah = findRecipient("noah");
  const plan = planCourier({
    from: place("taipei"),
    to: { name: noah.name, city: noah.city, country: noah.country, lat: noah.lat, lng: noah.lng },
    pace: "playable-fast",
  });
  assert.deepEqual(plan.legs.map((leg) => leg.mode), ["road", "plane", "road"]);
  assert.equal(plan.legs[0].to.name, "桃園機場");
  assert.equal(plan.legs[1].from.name, "桃園機場");
  assert.equal(plan.legs[1].to.name, "甘迺迪機場");
  assert.equal(plan.legs[2].to.name, "紐約");
  assert.equal(plan.durationSeconds, 18 * 60);
  assert.equal(
    plan.legs.reduce((sum, leg) => sum + leg.durationSeconds, 0),
    plan.durationSeconds,
  );
  assert.ok(plan.legs[1].durationSeconds > plan.legs[0].durationSeconds);
  assert.match(legVia(plan.legs), /公路到桃園機場/);
  assert.equal(nearestHub(place("taipei")).id, "TPE");
});

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
  assert.ok(nyc.durationSeconds >= 7 * DAY && nyc.durationSeconds <= 14 * DAY, nyc.durationSeconds);
  assert.ok(sydney.durationSeconds >= 7 * DAY && sydney.durationSeconds < london.durationSeconds, sydney.durationSeconds);
  assert.ok(city.durationSeconds < island.durationSeconds);
  assert.ok(island.durationSeconds < tokyo.durationSeconds);
  assert.ok(tokyo.durationSeconds < london.durationSeconds);
  assert.ok(london.durationSeconds < nyc.durationSeconds);
  assert.equal(london.durationSeconds, londonAgain.durationSeconds);

  assert.equal(
    london.legs.reduce((sum, leg) => sum + leg.durationSeconds, 0),
    london.durationSeconds,
  );
  assert.equal(london.legs[1].mode, "plane");
  assert.ok(london.legs[1].durationSeconds < london.legs[0].durationSeconds);
  assert.ok(london.legs[1].durationSeconds < london.legs[2].durationSeconds);

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

test("a multi-day letter keeps its place along the legs", () => {
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
  assert.equal(early.legIndex, 0);
  assert.equal(early.mode, "road");
  assert.ok(Math.abs(early.progress - 0.05) < 0.002, early.progress);
  const mid = at(0.5);
  assert.equal(mid.mode, "plane");
  assert.equal(mid.legIndex, 1);
  assert.ok(Math.abs(mid.progress - 0.5) < 0.002, mid.progress);
  const late = at(0.9);
  assert.equal(late.mode, "road");
  assert.equal(late.legIndex, 2);
  assert.ok(late.remainingKm < early.remainingKm);
  const done = describeFlight(
    { ...letter, status: "delivered" },
    start + plan.durationSeconds * 1000,
  );
  assert.equal(done.progress, 1);
  assert.equal(done.etaSeconds, 0);
  assert.ok(Math.abs(done.position.lat - ellen.lat) < 1e-6);
});

test("a long domestic hop uses the nearest airports", () => {
  const plan = planCourier({
    from: { name: "紐約", country: "美國", lat: 40.758, lng: -73.9855 },
    to: { name: "洛杉磯", country: "美國", lat: 34.0522, lng: -118.2437 },
  });
  assert.deepEqual(plan.legs.map((leg) => leg.mode), ["road", "plane", "road"]);
  assert.equal(plan.legs[1].from.name, "甘迺迪機場");
  assert.equal(plan.legs[1].to.name, "洛杉磯機場");
});

test("leg changes read as a transfer at the hub", () => {
  const plan = planCourier({ from: place("taipei"), to: place("tokyo") });
  assert.equal(transferBeat(null, plan.legs[0]), null);
  const toPlane = transferBeat(plan.legs[0], plan.legs[1]);
  assert.equal(toPlane.hub, "桃園機場");
  assert.equal(toPlane.line, "正在桃園機場轉運，改搭飛機");
  assert.equal(toPlane.mode, "plane");
  const toRoad = transferBeat(plan.legs[1], plan.legs[2]);
  assert.equal(toRoad.line, "正在羽田機場轉運，改走公路");
  assert.match(legProgressLine(plan.legs[0], { index: 0, count: 3 }), /公路上，送往桃園機場/);
  assert.match(legProgressLine(plan.legs[1], { index: 1, count: 3 }), /飛機上，前往羽田機場/);
  assert.match(legProgressLine(plan.legs[2], { index: 2, count: 3 }), /最後一段公路，送往東京/);

  const train = planCourier({ from: place("taipei"), to: place("kaohsiung") });
  assert.equal(legProgressLine(train.legs[0], { index: 0, count: 1 }), "火車上，前往高雄");
  const local = planCourier({ from: place("taipei"), to: place("taipei101") });
  assert.equal(legProgressLine(local.legs[0], { index: 0, count: 1 }), "公路上，前往台北101");
});

test("the courier changes mode in time order and does not teleport", () => {
  const noah = findRecipient("noah");
  const from = place("taipei");
  const to = { name: noah.name, country: noah.country, lat: noah.lat, lng: noah.lng };
  const plan = planCourier({ from, to });
  const letter = {
    status: "in_flight",
    from,
    to,
    distanceKm: plan.distanceKm,
    legs: plan.legs,
    departedAt: new Date(0).toISOString(),
    arrivesAt: new Date(plan.durationSeconds * 1000).toISOString(),
  };

  const early = describeFlight(letter, 5_000);
  assert.equal(early.mode, "road");
  assert.equal(early.legIndex, 0);
  assert.ok(haversineKm(early.position.lat, early.position.lng, from.lat, from.lng) < 40);

  const planeAt = (plan.legs[0].durationSeconds + 5) * 1000;
  const flying = describeFlight(letter, planeAt);
  assert.equal(flying.mode, "plane");
  assert.equal(flying.legIndex, 1);
  assert.ok(flying.remainingKm < plan.legs[1].distanceKm + plan.legs[2].distanceKm);

  const late = describeFlight(letter, (plan.durationSeconds - 5) * 1000);
  assert.equal(late.mode, "road");
  assert.equal(late.legIndex, 2);
  assert.ok(haversineKm(late.position.lat, late.position.lng, noah.lat, noah.lng) < 40);
  assert.ok(late.remainingKm < early.remainingKm);

  const done = describeFlight({ ...letter, status: "delivered" }, plan.durationSeconds * 1000);
  assert.equal(done.status, "delivered");
  assert.ok(Math.abs(done.position.lat - noah.lat) < 1e-6);
  assert.equal(locateOnLegs(plan.legs, 0).mode, "road");
});

test("background trips stay in transit without letter faces", () => {
  const plans = backgroundPlans();
  assert.ok(plans.length >= 6);
  const ids = new Set(plans.map((item) => item.id));
  assert.equal(ids.size, plans.length);
  for (const item of plans) {
    assert.ok(item.plan.legs.length >= 1);
    assert.equal(item.plan.legs.some((leg) => leg.imageUrl), false);
  }
});
