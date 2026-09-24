import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { createApp } from "../server.js";
import { flightDurationSeconds, haversineKm } from "../shared/flight.js";
import { findPlace } from "../shared/places.js";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let server;
let base;
let nowMs;
let dataDir;

describe("letters api", { concurrency: false }, () => {
before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "letters-"));
  nowMs = Date.parse("2026-09-24T00:00:00.000Z");
  const app = createApp({
    dataDir,
    now: () => nowMs,
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

async function send(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  if (text) body = JSON.parse(text);
  return { status: res.status, body, headers: res.headers };
}

test("health check is public", async () => {
  const health = await send(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
});

test("places and presets are available", async () => {
  const places = await send(`${base}/api/places`);
  const presets = await send(`${base}/api/presets`);
  assert.equal(places.status, 200);
  assert.ok(places.body.some((place) => place.id === "taipei"));
  assert.ok(places.body.some((place) => place.id === "kaohsiung"));
  assert.ok(places.body.some((place) => place.id === "tokyo"));
  assert.equal(presets.status, 200);
  assert.ok(presets.body.some((preset) => preset.id === "tpe-khh"));
  assert.ok(presets.body.some((preset) => preset.id === "tpe-tyo"));
});

test("rejects a missing letter face and the same place twice", async () => {
  const missing = await send(`${base}/api/letters`, {
    method: "POST",
    body: JSON.stringify({ fromId: "taipei", toId: "kaohsiung", launch: true }),
  });
  assert.equal(missing.status, 400);

  const same = await send(`${base}/api/letters`, {
    method: "POST",
    body: JSON.stringify({
      fromId: "taipei",
      toId: "taipei",
      launch: true,
      imageDataUrl: PNG,
    }),
  });
  assert.equal(same.status, 400);
});

test("launch schedules a flight the client can resume by time", async () => {
  const from = findPlace("taipei");
  const to = findPlace("taipei101");
  const distanceKm = haversineKm(from.lat, from.lng, to.lat, to.lng);
  const expected = flightDurationSeconds(distanceKm, "playable-fast");

  const created = await send(`${base}/api/letters`, {
    method: "POST",
    body: JSON.stringify({
      fromId: "taipei",
      toId: "taipei101",
      pace: "playable-fast",
      launch: true,
      imageDataUrl: PNG,
    }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, "in_flight");
  assert.equal(created.body.durationSeconds, expected);
  assert.ok(created.body.progress < 0.001);
  assert.equal(created.body.imageUrl, null);
  assert.ok(Math.abs(created.body.position.lat - from.lat) < 0.01);

  const hidden = await fetch(`${base}/api/letters/${created.body.id}/image`);
  assert.equal(hidden.status, 403);

  nowMs += 4_000;
  const later = await send(`${base}/api/letters/${created.body.id}`);
  assert.equal(later.status, 200);
  assert.equal(later.body.status, "in_flight");
  assert.ok(later.body.progress > 0.05, later.body.progress);
  assert.ok(later.body.progress < 0.5, later.body.progress);
  assert.ok(later.body.position.lat < created.body.position.lat);
  assert.ok(later.body.remainingKm < created.body.remainingKm);
  assert.ok(later.body.etaSeconds < created.body.etaSeconds);

  nowMs += expected * 1000;
  const done = await send(`${base}/api/letters/${created.body.id}`);
  assert.equal(done.body.status, "delivered");
  assert.equal(done.body.progress, 1);
  assert.ok(done.body.imageUrl);

  const image = await fetch(done.body.imageUrl.startsWith("http") ? done.body.imageUrl : `${base}${done.body.imageUrl}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");

  const again = await send(`${base}/api/letters/${created.body.id}`);
  assert.equal(again.body.status, "delivered");
});

test("draft can be saved and thrown later", async () => {
  const draft = await send(`${base}/api/letters`, {
    method: "POST",
    body: JSON.stringify({
      fromId: "taipei",
      toId: "tokyo",
      pace: "romantic-slow",
      imageDataUrl: PNG,
    }),
  });
  assert.equal(draft.status, 201);
  assert.equal(draft.body.status, "draft");
  assert.equal(draft.body.departedAt, null);
  assert.ok(draft.body.imageUrl);

  const thrown = await send(`${base}/api/letters/${draft.body.id}/throw`, {
    method: "POST",
    body: JSON.stringify({ pace: "playable-fast" }),
  });
  assert.equal(thrown.status, 200);
  assert.equal(thrown.body.status, "in_flight");
  assert.equal(thrown.body.pace, "playable-fast");
  assert.ok(thrown.body.departedAt);
  assert.ok(Date.parse(thrown.body.arrivesAt) > Date.parse(thrown.body.departedAt));

  const twice = await send(`${base}/api/letters/${draft.body.id}/throw`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  assert.equal(twice.status, 409);

  const another = await send(`${base}/api/letters`, {
    method: "POST",
    body: JSON.stringify({
      fromId: "taipei",
      toId: "taipei101",
      imageDataUrl: PNG,
    }),
  });
  const sent = await send(`${base}/api/letters/${another.body.id}/send`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.status, "in_flight");
  assert.equal(sent.body.pace, "playable-fast");
  const sentTwice = await send(`${base}/api/letters/${another.body.id}/send`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  assert.equal(sentTwice.status, 409);
});

test("romantic-slow stretches the same route", async () => {
  const fast = await send(`${base}/api/letters`, {
    method: "POST",
    body: JSON.stringify({
      fromId: "taipei",
      toId: "kaohsiung",
      pace: "playable-fast",
      launch: true,
      imageDataUrl: PNG,
    }),
  });
  const slow = await send(`${base}/api/letters`, {
    method: "POST",
    body: JSON.stringify({
      fromId: "taipei",
      toId: "kaohsiung",
      pace: "romantic-slow",
      launch: true,
      imageDataUrl: PNG,
    }),
  });
  assert.ok(slow.body.durationSeconds > fast.body.durationSeconds * 3);
});

test("random draw avoids the sender city and the last recipient", async () => {
  const pool = await send(`${base}/api/recipients`);
  assert.equal(pool.status, 200);
  assert.ok(pool.body.length >= 12);

  const drawn = await send(`${base}/api/recipients/draw`, {
    method: "POST",
    body: JSON.stringify({ fromId: "taipei" }),
  });
  assert.equal(drawn.status, 200);
  assert.notEqual(drawn.body.to.cityId, "taipei");
  assert.equal(
    drawn.body.durationSeconds,
    flightDurationSeconds(drawn.body.distanceKm, "playable-fast"),
  );

  const other = await send(`${base}/api/recipients/draw`, {
    method: "POST",
    body: JSON.stringify({ fromId: "taipei", excludeId: drawn.body.to.id }),
  });
  assert.notEqual(other.body.to.id, drawn.body.to.id);

  const sent = await send(`${base}/api/letters`, {
    method: "POST",
    body: JSON.stringify({
      fromId: "taipei",
      toId: drawn.body.to.id,
      launch: true,
      imageDataUrl: PNG,
    }),
  });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.to.name, drawn.body.to.name);
  assert.equal(sent.body.to.city, drawn.body.to.city);
  assert.equal(sent.body.status, "in_flight");

  const afterSend = await send(`${base}/api/recipients/draw`, {
    method: "POST",
    body: JSON.stringify({ fromId: "taipei" }),
  });
  assert.notEqual(afterSend.body.to.id, drawn.body.to.id);

  const nyc = await send(`${base}/api/route?fromId=taipei&toId=noah`);
  assert.equal(nyc.status, 200);
  assert.equal(nyc.body.to.city, "紐約");
  assert.ok(nyc.body.distanceKm > 10000);
  assert.equal(nyc.body.durationSeconds, 18 * 60);
  assert.deepEqual(nyc.body.legs.map((leg) => leg.mode), ["road", "plane", "road"]);
  assert.equal(
    nyc.body.legs.reduce((sum, leg) => sum + leg.durationSeconds, 0),
    nyc.body.durationSeconds,
  );
});

test("activity counts real flights plus background trips", async () => {
  const before = await send(`${base}/api/activity`);
  assert.equal(before.status, 200);
  const letters = await send(`${base}/api/letters`);
  const real = letters.body.filter((letter) => letter.status === "in_flight").length;
  assert.ok(before.body.traveling >= real + 6);
  assert.equal(
    before.body.trips.filter((trip) => trip.kind === "background").length >= 6,
    true,
  );
  assert.equal(before.body.trips.some((trip) => trip.imageUrl), false);

  const created = await send(`${base}/api/letters`, {
    method: "POST",
    body: JSON.stringify({
      fromId: "taipei",
      toId: "jiahui",
      launch: true,
      imageDataUrl: PNG,
    }),
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.legs.map((leg) => leg.mode), ["road", "plane", "road"]);
  assert.equal(created.body.mode, "road");

  const after = await send(`${base}/api/activity`);
  assert.equal(after.body.traveling, before.body.traveling + 1);
  assert.ok(after.body.trips.some((trip) => trip.id === created.body.id && trip.kind === "yours"));

  const roadSeconds = created.body.legs[0].durationSeconds;
  nowMs += (roadSeconds + 2) * 1000;
  const flying = await send(`${base}/api/letters/${created.body.id}`);
  assert.equal(flying.body.mode, "plane");
  assert.equal(flying.body.legIndex, 1);
  assert.ok(haversineKm(flying.body.position.lat, flying.body.position.lng, 25.047924, 121.517081) > 30);
});
});
