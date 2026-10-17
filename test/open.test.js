import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { createApp } from "../server.js";
import { findCity } from "../shared/recipients.js";
import { planFriendLetter } from "../shared/friend.js";
import { FRIEND_OPEN_MS, isPublicToken } from "../shared/link.js";
import { quotaSnapshot } from "../shared/quota.js";
import { renderShareCard } from "../lib/card.js";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("letters to a friend", () => {
  let server;
  let base;
  let nowMs;
  let dataDir;

  before(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "friend-letters-"));
    nowMs = Date.parse("2026-10-01T00:00:00.000Z");
    const app = createApp({ dataDir, now: () => nowMs });
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
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: res.status, body, headers: res.headers };
  }

  function friendBody(extra = {}) {
    return {
      fromId: "taipei",
      toId: "london",
      friendName: "阿橘",
      pace: "playable-fast",
      launch: true,
      senderId: "friend-sender-01",
      imageDataUrl: PNG,
      ...extra,
    };
  }

  test("posting to a friend uses the postal time and a private link", async () => {
    const refused = await send(`${base}/api/letters`, {
      method: "POST",
      body: JSON.stringify(friendBody({ toId: "taipei" })),
    });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /不同/);

    const nameless = await send(`${base}/api/letters`, {
      method: "POST",
      body: JSON.stringify(friendBody({ friendName: "   " })),
    });
    assert.equal(nameless.status, 400);

    const planned = planFriendLetter({
      from: findCity("taipei"),
      cityId: "london",
      friendName: "阿橘",
      pace: "playable-fast",
    });
    const created = await send(`${base}/api/letters`, {
      method: "POST",
      body: JSON.stringify(friendBody()),
    });
    assert.equal(created.status, 201, created.body?.error);
    assert.equal(created.body.audience, "friend");
    assert.equal(created.body.status, "in_flight");
    assert.equal(created.body.to.name, "阿橘");
    assert.equal(created.body.to.city, "倫敦");
    assert.equal(created.body.durationSeconds, planned.durationSeconds);
    assert.equal(created.body.senderId, "friend-sender-01");
    assert.match(created.body.friendPath, /^\/f\/[A-Za-z0-9_-]{43,}$/);
    assert.match(created.body.sharePath, /^\/s\/[A-Za-z0-9_-]{43,}$/);
    const friendToken = created.body.friendPath.slice(3);
    const shareToken = created.body.sharePath.slice(3);
    assert.notEqual(friendToken, shareToken);
    assert.notEqual(friendToken, created.body.id);
    assert.equal(isPublicToken(friendToken), true);
    assert.equal(created.body.imageUrl, null);

    const byId = await send(`${base}/api/open/${created.body.id}`);
    assert.equal(byId.status, 404);
    const sequential = await send(`${base}/api/open/1`);
    assert.equal(sequential.status, 404);
    const next = await send(`${base}/api/open/2`);
    assert.equal(next.status, 404);
    const shortShare = await fetch(`${base}/s/1`);
    assert.equal(shortShare.status, 404);

    const open = await send(`${base}/api/open/${friendToken}`);
    assert.equal(open.status, 200);
    assert.equal(open.body.state, "traveling");
    assert.equal(open.body.imageUrl, null);
    assert.equal(open.body.to.name, "阿橘");
    assert.equal(JSON.stringify(open.body).includes(created.body.id), false);
    assert.equal(JSON.stringify(open.body).includes("friend-sender"), false);
    const hidden = await send(`${base}/api/open/${friendToken}/image`);
    assert.equal(hidden.status, 403);

    const share = await fetch(`${base}/s/${shareToken}`);
    const html = await share.text();
    assert.equal(share.status, 200);
    assert.match(html, /og:image/);
    assert.match(html, new RegExp(`/s/${shareToken}/card\\.png`));
    assert.match(html, /台北/);
    assert.match(html, /倫敦/);
    assert.equal(html.includes("阿橘"), false);
    assert.equal(html.includes(friendToken), false);
    assert.equal(html.includes("/api/letters/"), false);
    assert.equal(html.includes("image/png;base64"), false);

    const card = await fetch(`${base}/s/${shareToken}/card.png`);
    const bytes = Buffer.from(await card.arrayBuffer());
    assert.equal(card.headers.get("content-type"), "image/png");
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(bytes.readUInt32BE(16), 1200);
    assert.equal(bytes.readUInt32BE(20), 630);
    assert.ok(bytes.length > 5000);

    const listed = await send(`${base}/api/letters`);
    const mine = listed.body.find((letter) => letter.id === created.body.id);
    assert.equal(quotaSnapshot(listed.body, "friend-sender-01").inFlight >= 1, true);
    assert.equal(mine.friendPath, created.body.friendPath);

    nowMs = Date.parse(created.body.arrivesAt) + 1000;
    const arrived = await send(`${base}/api/open/${friendToken}`);
    assert.equal(arrived.body.state, "arrived");
    assert.match(arrived.body.imageUrl, /\/image$/);
    const face = await fetch(`${base}${arrived.body.imageUrl}`);
    assert.equal(face.status, 200);
    assert.equal(face.headers.get("content-type"), "image/png");

    nowMs = Date.parse(created.body.arrivesAt) + FRIEND_OPEN_MS + 1000;
    const returned = await send(`${base}/api/open/${friendToken}`);
    assert.equal(returned.status, 200);
    assert.equal(returned.body.state, "returned");
    assert.equal(returned.body.note, "這封信已經退回郵局");
    assert.equal(JSON.stringify(returned.body).includes("阿橘"), false);
    const gone = await send(`${base}/api/open/${friendToken}/image`);
    assert.equal(gone.status, 410);
    const stillShared = await fetch(`${base}/s/${shareToken}`);
    const sharedHtml = await stillShared.text();
    assert.equal(stillShared.status, 200);
    assert.equal(sharedHtml.includes("阿橘"), false);
  });

  test("a draft for a friend is not on the share page until it is posted", async () => {
    const draft = await send(`${base}/api/letters`, {
      method: "POST",
      body: JSON.stringify(friendBody({
        launch: false,
        pace: "romantic-slow",
        senderId: "friend-sender-02",
      })),
    });
    assert.equal(draft.status, 201);
    assert.equal(draft.body.status, "draft");
    assert.equal(draft.body.sharePath, null);
    assert.equal(draft.body.friendPath, null);
    assert.equal(draft.body.audience, "friend");
  });

  test("a friend letter occupies one of the traveling slots", async () => {
    const sender = "friend-quota-01";
    const targets = ["noah", "ellen", "owen", "amina", "camille"];
    for (const toId of targets) {
      const created = await send(`${base}/api/letters`, {
        method: "POST",
        body: JSON.stringify({
          fromId: "taipei",
          toId,
          pace: "playable-fast",
          launch: true,
          senderId: sender,
          imageDataUrl: PNG,
        }),
      });
      assert.equal(created.status, 201, created.body?.error);
    }
    const blocked = await send(`${base}/api/letters`, {
      method: "POST",
      body: JSON.stringify(friendBody({
        senderId: sender,
        toId: "paris",
        friendName: "小安",
      })),
    });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /5 封/);
  });

  test("the preview image is drawn on the server from the route, not from the letter face", () => {
    const png = renderShareCard({
      fromCity: "巴黎",
      toCity: "倫敦",
      fromCountry: "法國",
      toCountry: "英國",
      daysText: "2 天 3 小時",
      stamps: [{ city: "巴黎", country: "法國" }],
    });
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(png.readUInt32BE(16), 1200);
    assert.equal(png.readUInt32BE(20), 630);
    assert.equal(png.includes(Buffer.from(PNG.split(",")[1], "base64")), false);
  });

  test("a friend's name and note cannot carry contact details", async () => {
    const named = await send(`${base}/api/letters`, {
      method: "POST",
      body: JSON.stringify(friendBody({
        friendName: "a@b.co",
        senderId: "friend-contact-01",
      })),
    });
    assert.equal(named.status, 400);
    assert.match(named.body.error, /電子郵件/);
    assert.deepEqual(named.body.reasons, ["email"]);

    const noted = await send(`${base}/api/letters`, {
      method: "POST",
      body: JSON.stringify(friendBody({
        friendName: "小安",
        toId: "tokyo",
        senderId: "friend-contact-02",
        note: "請打 0912345678",
      })),
    });
    assert.equal(noted.status, 400);
    assert.match(noted.body.error, /電話號碼/);
  });

  test("a picture sent to a friend is stored without location metadata", async () => {
    const payload = Buffer.from("Exif\0\0GPSLatitudeCameraModel", "ascii");
    const dirty = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xe0, 0x00, 0x10]),
      Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "ascii"),
      Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]),
      payload,
      Buffer.from([0xff, 0xda, 0x00, 0x02]),
      Buffer.from("entropy", "ascii"),
      Buffer.from([0xff, 0xd9]),
    ]);
    const created = await send(`${base}/api/letters`, {
      method: "POST",
      body: JSON.stringify(friendBody({
        senderId: "friend-meta-01",
        toId: "paris",
        friendName: "阿橘",
        imageDataUrl: `data:image/jpeg;base64,${dirty.toString("base64")}`,
      })),
    });
    assert.equal(created.status, 201, created.body?.error);
    const saved = fs.readFileSync(path.join(dataDir, "images", `${created.body.id}.jpg`));
    assert.equal(saved.includes(Buffer.from("JFIF")), true);
    assert.equal(saved.includes(Buffer.from("Exif")), false);
    assert.equal(saved.includes(Buffer.from("GPSLatitude")), false);
    assert.equal(saved.includes(Buffer.from("entropy")), true);
  });

  test("friend letters share the traveling slots and stay out of the mailbox", async () => {
    const previous = nowMs;
    try {
      const senderA = await send(`${base}/api/senders`, {
        method: "POST",
        body: JSON.stringify({
          senderId: "live-friend-a1",
          nickname: "紙船",
          cityId: "paris",
          ofAge: true,
        }),
      });
      assert.equal(senderA.status, 201, senderA.body?.error);
      const senderB = await send(`${base}/api/senders`, {
        method: "POST",
        body: JSON.stringify({
          senderId: "live-friend-b1",
          nickname: "遠山",
          cityId: "london",
          ofAge: true,
        }),
      });
      assert.equal(senderB.status, 201, senderB.body?.error);

      const real = await send(`${base}/api/letters`, {
        method: "POST",
        body: JSON.stringify({
          fromId: "paris",
          toId: "live-friend-b1",
          pace: "playable-fast",
          launch: true,
          senderId: "live-friend-a1",
          note: "今天天氣很好",
          imageDataUrl: PNG,
        }),
      });
      assert.equal(real.status, 201, real.body?.error);
      assert.equal(real.body.audience, "stranger");
      assert.equal(real.body.to.demo, false);
      assert.equal(real.body.to.name, "遠山");
      assert.match(real.body.sharePath, /^\/s\/[A-Za-z0-9_-]{43,}$/);

      const friend = await send(`${base}/api/letters`, {
        method: "POST",
        body: JSON.stringify(friendBody({
          fromId: "paris",
          toId: "tokyo",
          friendName: "小安",
          senderId: "live-friend-a1",
          note: "路上順利",
        })),
      });
      assert.equal(friend.status, 201, friend.body?.error);
      assert.equal(friend.body.audience, "friend");
      const friendToken = friend.body.friendPath.slice(3);
      const flying = await send(`${base}/api/open/${friendToken}`);
      assert.equal(flying.body.state, "traveling");
      assert.equal(flying.body.note, "");
      assert.equal(JSON.stringify(flying.body).includes("路上順利"), false);

      const listed = await send(`${base}/api/letters`);
      const snap = quotaSnapshot(listed.body, "live-friend-a1");
      assert.equal(snap.inFlight >= 2, true);

      nowMs = Math.max(Date.parse(real.body.arrivesAt), Date.parse(friend.body.arrivesAt)) + 1000;
      const realLanded = await send(`${base}/api/letters/${real.body.id}`);
      assert.equal(realLanded.body.status, "awaiting_receipt");
      const friendLanded = await send(`${base}/api/letters/${friend.body.id}`);
      assert.equal(friendLanded.body.status, "delivered");
      assert.equal(friendLanded.body.receivedAt, null);

      const box = await send(`${base}/api/mailbox?senderId=${encodeURIComponent("live-friend-b1")}`);
      assert.equal(box.status, 200);
      assert.equal(box.body.letters.some((letter) => letter.id === real.body.id), true);
      assert.equal(box.body.letters.some((letter) => letter.id === friend.body.id), false);

      const share = await fetch(`${base}${real.body.sharePath}`);
      const shareHtml = await share.text();
      assert.equal(share.status, 200);
      assert.equal(shareHtml.includes("今天天氣很好"), false);
      assert.equal(shareHtml.includes("遠山"), false);

      const open = await send(`${base}/api/open/${friendToken}`);
      assert.equal(open.body.state, "arrived");
      assert.equal(open.body.note, "路上順利");
      assert.match(open.body.imageUrl, /^\/api\/open\//);
    } finally {
      nowMs = previous;
    }
  });
});
