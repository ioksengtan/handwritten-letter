import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { createStore } from "../lib/store.js";
import { createApp } from "../server.js";
import { AGE_REQUIRED } from "../shared/profile.js";
import { findCity } from "../shared/recipients.js";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function jpegWithExif() {
  const app0 = Buffer.concat([
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "ascii"),
  ]);
  const payload = Buffer.from("Exif\0\0GPSLatitudeCameraModel", "ascii");
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]),
    payload,
  ]);
  const scan = Buffer.concat([
    Buffer.from([0xff, 0xda, 0x00, 0x02]),
    Buffer.from("entropy", "ascii"),
    Buffer.from([0xff, 0xd9]),
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, app1, scan]);
}

describe("real exchange", { concurrency: false }, () => {
  let server;
  let base;
  let nowMs;
  let dataDir;

  before(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "exchange-"));
    nowMs = Date.parse("2026-10-17T00:00:00.000Z");
    const app = createApp({
      dataDir,
      now: () => nowMs,
      random: () => 0,
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
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  function register(senderId, nickname, cityId, extra = {}) {
    return send(`${base}/api/senders`, {
      method: "POST",
      body: JSON.stringify({ senderId, nickname, cityId, ofAge: true, ...extra }),
    });
  }

  test("a sender is remembered by nickname, city, and created time, and a minor cannot register", async () => {
    const minor = await send(`${base}/api/senders`, {
      method: "POST",
      body: JSON.stringify({
        senderId: "live-sender-a1",
        nickname: "小紙",
        cityId: "taipei",
        ofAge: false,
      }),
    });
    assert.equal(minor.status, 403);
    assert.equal(minor.body.error, AGE_REQUIRED);

    const created = await register("live-sender-a1", "小紙", "taipei");
    assert.equal(created.status, 201);
    assert.equal(created.body.nickname, "小紙");
    assert.equal(created.body.city, "台北");
    assert.equal(created.body.cityId, "taipei");
    assert.match(created.body.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal("lat" in created.body, false);
    assert.equal("lng" in created.body, false);
    assert.equal(JSON.stringify(created.body).includes("小紙"), true);

    const alone = await send(`${base}/api/recipients/draw`, {
      method: "POST",
      body: JSON.stringify({ fromId: "taipei", senderId: "live-sender-a1" }),
    });
    assert.equal(alone.status, 200);
    assert.equal(alone.body.to.demo, true);

    nowMs += 60_000;
    const again = await register("live-sender-a1", "小紙", "taipei");
    assert.equal(again.status, 200);
    assert.equal(again.body.createdAt, created.body.createdAt);

    const emailName = await register("live-sender-a1", "a@b.co", "taipei");
    assert.equal(emailName.status, 400);
    assert.match(emailName.body.error, /暱稱不能有電子郵件/);

    const onDisk = fs.readFileSync(path.join(dataDir, "senders.json"), "utf8");
    assert.equal(onDisk.includes("\"lat\""), false);
    assert.equal(onDisk.includes("\"lng\""), false);
    assert.match(onDisk, /小紙/);
    assert.match(onDisk, /台北/);
  });

  test("two real people are paired, a third is preferred over the last one, and a block removes that recipient", async () => {
    const bee = await register("live-sender-b1", "阿乙", "hong-kong");
    assert.equal(bee.status, 201);
    const drawn = await send(`${base}/api/recipients/draw`, {
      method: "POST",
      body: JSON.stringify({ fromId: "taipei", senderId: "live-sender-a1" }),
    });
    assert.equal(drawn.body.to.demo, false);
    assert.equal(drawn.body.to.id, "live-sender-b1");
    assert.equal(drawn.body.to.name, "阿乙");
    assert.equal(drawn.body.to.city, "香港");
    assert.equal(drawn.body.to.lat, findCity("hong-kong").lat);
    assert.notEqual(drawn.body.to.id, "live-sender-a1");

    const cee = await register("live-sender-c1", "阿丙", "seoul");
    assert.equal(cee.status, 201);
    const mailed = await send(`${base}/api/letters`, {
      method: "POST",
      body: JSON.stringify({
        fromId: "taipei",
        toId: "live-sender-b1",
        pace: "playable-fast",
        launch: true,
        senderId: "live-sender-a1",
        note: "今天天氣很好。",
        imageDataUrl: PNG,
      }),
    });
    assert.equal(mailed.status, 201, mailed.body?.error);
    assert.equal(mailed.body.status, "in_flight");
    assert.equal(mailed.body.note, "");
    assert.equal(mailed.body.to.demo, false);
    assert.equal(mailed.body.from.name, "小紙");
    assert.equal(mailed.body.from.city, "台北");

    const next = await send(`${base}/api/recipients/draw`, {
      method: "POST",
      body: JSON.stringify({ fromId: "taipei", senderId: "live-sender-a1" }),
    });
    assert.equal(next.body.to.id, "live-sender-c1");

    const self = await send(`${base}/api/letters`, {
      method: "POST",
      body: JSON.stringify({
        fromId: "taipei",
        toId: "live-sender-a1",
        launch: true,
        senderId: "live-sender-a1",
        imageDataUrl: PNG,
      }),
    });
    assert.equal(self.status, 400);
    assert.match(self.body.error, /不能寄給自己/);
  });

  test("the mailbox hides a letter until it lands, and 已收到 is what counts as delivered", async () => {
    const letters = await send(`${base}/api/letters`);
    const flying = letters.body.find((letter) => letter.to?.id === "live-sender-b1" && letter.status === "in_flight");
    assert.ok(flying);
    const hidden = await fetch(`${base}/api/letters/${flying.id}/image`);
    assert.equal(hidden.status, 403);

    const early = await send(`${base}/api/mailbox?senderId=live-sender-b1`);
    assert.equal(early.status, 200);
    assert.equal(early.body.letters.length, 1);
    assert.equal(early.body.letters[0].status, "in_flight");
    assert.equal(early.body.letters[0].imageUrl, null);
    assert.equal(early.body.letters[0].note, "");
    assert.equal(early.body.letters[0].from.city, "台北");
    assert.equal(early.body.letters[0].from.name, "小紙");
    assert.equal(JSON.stringify(early.body).includes("\"lat\""), false);

    const tooSoon = await send(`${base}/api/letters/${flying.id}/receive`, {
      method: "POST",
      body: JSON.stringify({ senderId: "live-sender-b1" }),
    });
    assert.equal(tooSoon.status, 409);
    assert.match(tooSoon.body.error, /還在路上/);

    nowMs += flying.durationSeconds * 1000 + 1000;
    const landed = await send(`${base}/api/letters/${flying.id}`);
    assert.equal(landed.body.status, "awaiting_receipt");
    assert.equal(landed.body.note, "今天天氣很好。");
    assert.ok(landed.body.imageUrl);
    const image = await fetch(`${base}${landed.body.imageUrl}`);
    assert.equal(image.status, 200);

    const before = (await send(`${base}/api/letters`)).body;
    const quotaBefore = before.filter((letter) => letter.senderId === "live-sender-a1" && letter.status === "delivered").length;
    const occupied = before.filter((letter) => (
      letter.senderId === "live-sender-a1" && (letter.status === "in_flight" || letter.status === "awaiting_receipt")
    )).length;
    assert.equal(occupied >= 1, true);

    const stranger = await send(`${base}/api/letters/${flying.id}/receive`, {
      method: "POST",
      body: JSON.stringify({ senderId: "live-sender-c1" }),
    });
    assert.equal(stranger.status, 403);

    const received = await send(`${base}/api/letters/${flying.id}/receive`, {
      method: "POST",
      body: JSON.stringify({ senderId: "live-sender-b1" }),
    });
    assert.equal(received.status, 200);
    assert.equal(received.body.status, "delivered");
    assert.ok(received.body.receivedAt);

    const after = (await send(`${base}/api/letters`)).body;
    const quotaAfter = after.filter((letter) => letter.senderId === "live-sender-a1" && letter.status === "delivered").length;
    assert.equal(quotaAfter, quotaBefore + 1);
    assert.equal(after.find((letter) => letter.id === flying.id).status, "delivered");
  });

  test("contact details are refused, metadata is stripped, and a report does not notify the author", async () => {
    const phone = await send(`${base}/api/letters`, {
      method: "POST",
      body: JSON.stringify({
        fromId: "taipei",
        toId: "live-sender-c1",
        launch: true,
        senderId: "live-sender-a1",
        note: "請打 0912-345-678",
        imageDataUrl: PNG,
      }),
    });
    assert.equal(phone.status, 400);
    assert.match(phone.body.error, /電話號碼/);
    assert.match(phone.body.error, /請拿掉再寄/);
    assert.deepEqual(phone.body.reasons, ["phone"]);

    const social = await send(`${base}/api/letters`, {
      method: "POST",
      body: JSON.stringify({
        fromId: "seoul",
        toId: "live-sender-a1",
        launch: true,
        senderId: "live-sender-c1",
        note: "我的 LINE 是 abcde，信箱 hi@example.com",
        imageDataUrl: PNG,
      }),
    });
    assert.equal(social.status, 400);
    assert.ok(social.body.reasons.includes("social"));
    assert.ok(social.body.reasons.includes("email"));

    const jpeg = jpegWithExif();
    const posted = await send(`${base}/api/letters`, {
      method: "POST",
      body: JSON.stringify({
        fromId: "seoul",
        toId: "live-sender-a1",
        pace: "playable-fast",
        launch: true,
        senderId: "live-sender-c1",
        note: "只是一封信。",
        imageDataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
      }),
    });
    assert.equal(posted.status, 201, posted.body?.error);
    const storedName = fs.readdirSync(path.join(dataDir, "images")).find((name) => name.startsWith(posted.body.id));
    const bytes = fs.readFileSync(path.join(dataDir, "images", storedName));
    assert.equal(bytes.includes(Buffer.from("Exif")), false);
    assert.equal(bytes.includes(Buffer.from("GPSLatitude")), false);
    assert.equal(bytes.includes(Buffer.from("CameraModel")), false);
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xd8);

    nowMs += posted.body.durationSeconds * 1000 + 1000;
    const report = await send(`${base}/api/letters/${posted.body.id}/report`, {
      method: "POST",
      body: JSON.stringify({ senderId: "live-sender-a1" }),
    });
    assert.equal(report.status, 200);
    assert.equal(report.body.ok, true);
    const again = await send(`${base}/api/letters/${posted.body.id}/report`, {
      method: "POST",
      body: JSON.stringify({ senderId: "live-sender-a1" }),
    });
    assert.equal(again.body.id, report.body.id);
    const reports = createStore(dataDir).listReports();
    assert.equal(reports.length, 1);
    assert.equal(reports[0].authorId, "live-sender-c1");
    assert.equal(reports[0].reporterId, "live-sender-a1");

    const block = await send(`${base}/api/letters/${posted.body.id}/block`, {
      method: "POST",
      body: JSON.stringify({ senderId: "live-sender-a1" }),
    });
    assert.equal(block.status, 200);
    assert.equal(block.body.ok, true);

    const authorView = await send(`${base}/api/letters/${posted.body.id}`);
    assert.equal(JSON.stringify(authorView.body).includes("檢舉"), false);
    assert.equal(JSON.stringify(authorView.body).includes("封鎖"), false);
    assert.equal(authorView.body.senderId, "live-sender-c1");

    const redraw = await send(`${base}/api/recipients/draw`, {
      method: "POST",
      body: JSON.stringify({
        fromId: "seoul",
        senderId: "live-sender-c1",
        excludeId: "live-sender-b1",
      }),
    });
    assert.notEqual(redraw.body.to.id, "live-sender-a1");

    const forced = await send(`${base}/api/letters`, {
      method: "POST",
      body: JSON.stringify({
        fromId: "seoul",
        toId: "live-sender-a1",
        launch: true,
        senderId: "live-sender-c1",
        imageDataUrl: PNG,
      }),
    });
    assert.equal(forced.status, 409);
    assert.match(forced.body.error, /換一位收件人/);
  });

  test("letters already addressed to the demo list still arrive and stay visible", async () => {
    const store = createStore(dataDir);
    const city = findCity("taipei");
    const london = findCity("london");
    store.create({
      id: "legacy-demo-letter",
      status: "in_flight",
      from: { id: city.id, name: city.name, country: city.country, lat: city.lat, lng: city.lng },
      to: { id: "ellen", name: "Ellen", city: "倫敦", cityId: "london", country: "英國", lat: london.lat, lng: london.lng },
      distanceKm: 9781,
      durationSeconds: 60,
      pace: "playable-fast",
      legs: null,
      imageFile: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      departedAt: new Date(nowMs).toISOString(),
      arrivesAt: new Date(nowMs + 60_000).toISOString(),
      deliveredAt: null,
    });
    nowMs += 61_000;
    const done = await send(`${base}/api/letters/legacy-demo-letter`);
    assert.equal(done.body.status, "delivered");
    assert.equal(done.body.to.name, "Ellen");
    assert.equal(done.body.to.city, "倫敦");
    const box = await send(`${base}/api/mailbox?senderId=live-sender-b1`);
    assert.equal(box.body.letters.some((letter) => letter.id === "legacy-demo-letter"), false);
  });
});
