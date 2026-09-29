import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { createStore } from "../lib/store.js";
import { createApp, resolveDefaultPace } from "../server.js";
import { flightDurationSeconds, haversineKm } from "../shared/flight.js";
import { findPlace } from "../shared/places.js";
import { planCourier } from "../shared/route.js";

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
  assert.equal(health.body.pace, "romantic-slow");
});

test("fixed-route catalogs are gone", async () => {
  const places = await fetch(`${base}/api/places`);
  const presets = await fetch(`${base}/api/presets`);
  assert.equal(places.status, 404);
  assert.equal(presets.status, 404);
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
  for (const key of ["createdAt", "departedAt", "arrivesAt", "serverNow"]) {
    assert.match(created.body[key], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }
  assert.equal(JSON.stringify(created.body).includes("上午"), false);
  assert.equal(JSON.stringify(created.body).includes("下午"), false);
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
  assert.match(done.body.deliveredAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

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
  assert.equal(sent.body.pace, "romantic-slow");
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
  assert.equal(drawn.body.pace, "romantic-slow");
  assert.equal(
    drawn.body.durationSeconds,
    planCourier({
      from: drawn.body.from,
      to: drawn.body.to,
      pace: "romantic-slow",
    }).durationSeconds,
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
  assert.equal(nyc.body.pace, "romantic-slow");
  assert.ok(nyc.body.distanceKm > 10000);
  assert.ok(nyc.body.durationSeconds >= 7 * 86400);
  assert.ok(nyc.body.durationSeconds <= 14 * 86400);
  assert.deepEqual(nyc.body.legs.map((leg) => leg.mode), ["road", "plane", "road"]);
  assert.equal(
    nyc.body.legs.reduce((sum, leg) => sum + leg.durationSeconds, 0),
    nyc.body.durationSeconds,
  );
  assert.ok(nyc.body.legs[1].durationSeconds < nyc.body.legs[0].durationSeconds);

  const london = await send(`${base}/api/route?fromId=taipei&toId=ellen`);
  assert.ok(london.body.durationSeconds >= 8 * 86400);
  assert.ok(london.body.durationSeconds <= 10 * 86400);

  const fast = await send(`${base}/api/route?fromId=taipei&toId=noah&pace=playable-fast`);
  assert.equal(fast.body.pace, "playable-fast");
  assert.equal(fast.body.durationSeconds, 18 * 60);
  assert.ok(fast.body.legs[1].durationSeconds > fast.body.legs[0].durationSeconds);
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
  const planeSeconds = created.body.legs[1].durationSeconds;
  nowMs += (roadSeconds + planeSeconds * 0.15) * 1000;
  const flying = await send(`${base}/api/letters/${created.body.id}`);
  assert.equal(flying.body.mode, "plane");
  assert.equal(flying.body.legIndex, 1);
  assert.ok(haversineKm(flying.body.position.lat, flying.body.position.lng, 25.047924, 121.517081) > 30);
});

test("a multi-day letter is still on disk after the store is reopened", async () => {
  const created = await send(`${base}/api/letters`, {
    method: "POST",
    body: JSON.stringify({
      fromId: "taipei",
      toId: "ellen",
      launch: true,
      imageDataUrl: PNG,
    }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.pace, "romantic-slow");
  assert.ok(created.body.durationSeconds >= 8 * 86400);
  assert.ok(created.body.durationSeconds <= 10 * 86400);

  const reopened = createStore(dataDir);
  const stored = reopened.get(created.body.id);
  assert.equal(stored.status, "in_flight");
  assert.equal(stored.arrivesAt, created.body.arrivesAt);
  assert.equal(stored.durationSeconds, created.body.durationSeconds);
});
});

test("PACE selects the server default, and an unknown value falls back", () => {
  const previous = process.env.PACE;
  process.env.PACE = "playable-fast";
  assert.equal(resolveDefaultPace(), "playable-fast");
  process.env.PACE = "nope";
  assert.equal(resolveDefaultPace(), "romantic-slow");
  process.env.PACE = "";
  assert.equal(resolveDefaultPace(), "romantic-slow");
  if (previous == null) delete process.env.PACE;
  else process.env.PACE = previous;
});

test("a fast server default keeps an unnamed route playable", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "letters-fast-"));
  const app = createApp({
    dataDir: dir,
    defaultPace: "playable-fast",
    now: () => Date.parse("2026-09-24T00:00:00.000Z"),
  });
  const fastServer = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => fastServer.once("listening", resolve));
  try {
    const root = `http://127.0.0.1:${fastServer.address().port}`;
    const health = await fetch(`${root}/api/health`);
    assert.equal((await health.json()).pace, "playable-fast");
    const route = await fetch(`${root}/api/route?fromId=taipei&toId=noah`);
    const body = await route.json();
    assert.equal(body.durationSeconds, flightDurationSeconds(body.distanceKm, "playable-fast"));
    assert.equal(body.durationSeconds, 18 * 60);
  } finally {
    await new Promise((resolve, reject) => {
      fastServer.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(dir, { recursive: true, force: true });
  }
});

test("a letter already stored with landmark endpoints still renders and arrives", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "letters-old-"));
  const store = createStore(dir);
  const from = findPlace("taipei");
  const to = findPlace("kaohsiung");
  const departedAt = "2026-09-24T00:00:00.000Z";
  const arrivesAt = "2026-09-26T11:00:00.000Z";
  store.create({
    id: "old-fixed-route",
    status: "in_flight",
    from,
    to,
    distanceKm: haversineKm(from.lat, from.lng, to.lat, to.lng),
    durationSeconds: 2 * 86400 + 11 * 3600,
    pace: "romantic-slow",
    legs: null,
    imageFile: null,
    createdAt: departedAt,
    updatedAt: departedAt,
    departedAt,
    arrivesAt,
    deliveredAt: null,
  });
  let nowMs = Date.parse("2026-09-25T05:30:00.000Z");
  const app = createApp({ dataDir: dir, now: () => nowMs });
  const oldServer = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => oldServer.once("listening", resolve));
  try {
    const root = `http://127.0.0.1:${oldServer.address().port}`;
    const flyingRes = await fetch(`${root}/api/letters/old-fixed-route`);
    const flying = await flyingRes.json();
    assert.equal(flyingRes.status, 200);
    assert.equal(flying.status, "in_flight");
    assert.equal(flying.from.name, "台北");
    assert.equal(flying.to.name, "高雄");
    assert.ok(flying.progress > 0.2 && flying.progress < 0.8, flying.progress);
    assert.ok(flying.remainingKm > 0);
    assert.equal(flying.imageUrl, null);

    const listed = await (await fetch(`${root}/api/letters`)).json();
    assert.ok(listed.some((letter) => letter.id === "old-fixed-route" && letter.status === "in_flight"));

    nowMs = Date.parse(arrivesAt) + 1000;
    const arrived = await (await fetch(`${root}/api/letters/old-fixed-route`)).json();
    assert.equal(arrived.status, "delivered");
    assert.equal(arrived.progress, 1);
    assert.equal(arrived.remainingKm, 0);
    assert.equal(arrived.to.name, "高雄");
    assert.equal(arrived.deliveredAt, arrivesAt);
  } finally {
    await new Promise((resolve, reject) => {
      oldServer.close((err) => (err ? reject(err) : resolve()));
    });
    await rm(dir, { recursive: true, force: true });
  }
});
