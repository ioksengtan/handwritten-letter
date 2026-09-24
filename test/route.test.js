import assert from "node:assert/strict";
import test from "node:test";
import { describeFlight, haversineKm, locateOnLegs } from "../shared/flight.js";
import { findPlace } from "../shared/places.js";
import { findRecipient } from "../shared/recipients.js";
import {
  backgroundPlans,
  legVia,
  nearestHub,
  planCourier,
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

test("a long domestic hop uses the nearest airports", () => {
  const plan = planCourier({
    from: { name: "紐約", country: "美國", lat: 40.758, lng: -73.9855 },
    to: { name: "洛杉磯", country: "美國", lat: 34.0522, lng: -118.2437 },
  });
  assert.deepEqual(plan.legs.map((leg) => leg.mode), ["road", "plane", "road"]);
  assert.equal(plan.legs[1].from.name, "甘迺迪機場");
  assert.equal(plan.legs[1].to.name, "洛杉磯機場");
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
