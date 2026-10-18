import express from "express";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripImageMeta } from "./lib/image-meta.js";
import { mountLetterLinks } from "./lib/pages.js";
import { createStore } from "./lib/store.js";
import { contactRefusal } from "./shared/contact.js";
import { planFriendLetter } from "./shared/friend.js";
import { DEFAULT_PACE, PACES, describeFlight, haversineKm } from "./shared/flight.js";
import { assignLetterLinks, isPublicToken } from "./shared/link.js";
import { awaitsReceipt } from "./shared/mailbox.js";
import { personRecipient, pickPerson, sameHomeCity } from "./shared/matching.js";
import { findPlace } from "./shared/places.js";
import { AGE_REQUIRED, normalizeNickname, normalizeSenderId } from "./shared/profile.js";
import { quotaFullError, quotaSnapshot } from "./shared/quota.js";
import { RECIPIENTS, findCity, findRecipient, pickRecipient } from "./shared/recipients.js";
import { backgroundPlans, backgroundSnapshots, planCourier } from "./shared/route.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const MIN_DISTANCE_KM = 0.05;

function round(value, digits) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([a-z0-9+/=\s]+)$/i.exec(
    dataUrl.trim(),
  );
  if (!match) return null;
  let mime = match[1].toLowerCase();
  if (mime === "image/jpg") mime = "image/jpeg";
  const buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (!buffer.length || buffer.length > 6 * 1024 * 1024) return null;
  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  return { mime, buffer, ext };
}

function senderFromId(id) {
  const city = findCity(id);
  if (city) {
    return { id: city.id, name: city.name, country: city.country, lat: city.lat, lng: city.lng };
  }
  const place = findPlace(id);
  if (!place) return null;
  return { id: place.id, name: place.name, country: place.country, lat: place.lat, lng: place.lng };
}

function demoDestination(recipient) {
  return {
    id: recipient.id,
    name: recipient.name,
    city: recipient.city,
    cityId: recipient.cityId,
    country: recipient.country,
    continent: recipient.continent,
    lat: recipient.lat,
    lng: recipient.lng,
    demo: true,
  };
}

function destinationFromId(id, people) {
  const recipient = findRecipient(id);
  if (recipient) return demoDestination(recipient);
  if (people && people.has(id)) return people.get(id);
  return senderFromId(id);
}

export function resolveDefaultPace(explicit = process.env.PACE) {
  if (explicit == null || explicit === "") return DEFAULT_PACE;
  if (PACES[explicit]) return explicit;
  console.warn(`不認識的 PACE=${explicit}，改用浪漫慢`);
  return DEFAULT_PACE;
}

function buildGeometry(fromId, toId, pace, fallback = DEFAULT_PACE, people = null) {
  const from = senderFromId(fromId);
  const to = destinationFromId(toId, people);
  if (!from || !to) return { error: "找不到地點" };
  if (from.id === to.id) return { error: "請選擇不同的寄出地與收件地" };
  const distanceKm = round(haversineKm(from.lat, from.lng, to.lat, to.lng), 3);
  if (distanceKm < MIN_DISTANCE_KM) return { error: "請選擇不同的寄出地與收件地" };
  let plan;
  try {
    plan = planCourier({ from, to, pace: pace || fallback });
  } catch {
    return { error: "不認識的飛行節奏" };
  }
  return {
    from,
    to,
    distanceKm: plan.distanceKm,
    durationSeconds: plan.durationSeconds,
    legs: plan.legs,
    pace: plan.pace,
  };
}

function geometryBody(geo) {
  if (!geo?.error) return null;
  const body = { error: geo.error };
  if (geo.reasons?.length) body.reasons = geo.reasons;
  return body;
}

function resolveTrip(body = {}, existing = null, paceFallback = DEFAULT_PACE, people = null) {
  const pace = body.pace || existing?.pace;
  const fromId = body.fromId || existing?.from?.id;
  const explicitFriend = Object.prototype.hasOwnProperty.call(body, "friendName");
  const friendSource = explicitFriend
    ? body.friendName
    : (existing?.audience === "friend" ? existing?.to?.name : null);
  const wantsFriend = friendSource != null && String(friendSource).trim() !== "";
  if (explicitFriend && !wantsFriend) return { error: "請寫下朋友的稱呼" };
  if (wantsFriend) {
    const from = senderFromId(fromId);
    if (!from) return { error: "找不到寄出地" };
    const cityId = body.toId || existing?.to?.cityId || existing?.to?.id;
    return planFriendLetter({
      from,
      cityId,
      friendName: friendSource,
      pace: pace || paceFallback,
    });
  }
  const geo = buildGeometry(fromId, body.toId || existing?.to?.id, pace, paceFallback, people);
  if (geo.error) return geo;
  return { ...geo, audience: "stranger" };
}

function toPublic(letter, nowMs) {
  const flight = describeFlight(letter, nowMs);
  const imageVisible = flight.status !== "in_flight";
  return {
    id: letter.id,
    status: flight.status,
    from: letter.from,
    to: letter.to,
    distanceKm: letter.distanceKm,
    pace: letter.pace,
    durationSeconds: letter.durationSeconds,
    createdAt: letter.createdAt,
    updatedAt: letter.updatedAt,
    departedAt: letter.departedAt,
    arrivesAt: letter.arrivesAt,
    deliveredAt: flight.status === "delivered" ? letter.deliveredAt || letter.arrivesAt : null,
    progress: flight.progress,
    position: {
      lat: round(flight.position.lat, 6),
      lng: round(flight.position.lng, 6),
    },
    remainingKm: round(flight.remainingKm, 3),
    etaSeconds: flight.etaSeconds == null ? null : Math.max(0, Math.round(flight.etaSeconds)),
    legs: letter.legs || null,
    mode: flight.mode,
    legIndex: flight.legIndex,
    senderId: letter.senderId || null,
    receivedAt: letter.receivedAt || null,
    note: imageVisible ? (letter.note || "") : "",
    audience: letter.audience === "friend" ? "friend" : "stranger",
    sharePath: letter.status !== "draft" && isPublicToken(letter.shareToken) ? `/s/${letter.shareToken}` : null,
    friendPath: letter.audience === "friend" && letter.status !== "draft" && isPublicToken(letter.friendToken)
      ? `/f/${letter.friendToken}`
      : null,
    serverNow: new Date(nowMs).toISOString(),
    imageUrl: imageVisible ? `/api/letters/${letter.id}/image` : null,
  };
}

export function createApp({
  dataDir = path.join(root, "data"),
  now = () => Date.now(),
  random = Math.random,
  defaultPace,
} = {}) {
  const paceFallback = resolveDefaultPace(defaultPace);
  const store = createStore(dataDir);
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "8mb" }));
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  function persistArrivals(nowMs) {
    const letters = store.list();
    let changed = false;
    const next = letters.map((letter) => {
      const flight = describeFlight(letter, nowMs);
      if (letter.status === "in_flight" && flight.status === "delivered") {
        changed = true;
        const updatedAt = new Date(nowMs).toISOString();
        if (awaitsReceipt(letter)) {
          return { ...letter, status: "awaiting_receipt", updatedAt };
        }
        return {
          ...letter,
          status: "delivered",
          deliveredAt: letter.arrivesAt,
          updatedAt,
        };
      }
      return letter;
    });
    if (changed) store.replaceAll(next);
    return changed ? store.list() : next;
  }

  function takenTokens(letters) {
    const used = new Set();
    for (const letter of letters) {
      if (isPublicToken(letter.shareToken)) used.add(letter.shareToken);
      if (isPublicToken(letter.friendToken)) used.add(letter.friendToken);
    }
    return used;
  }

  function backfillLinks(letters) {
    const used = takenTokens(letters);
    let changed = false;
    const next = letters.map((letter) => {
      if (letter.status === "draft") return letter;
      const needsShare = !isPublicToken(letter.shareToken);
      const needsFriend = letter.audience === "friend" && !isPublicToken(letter.friendToken);
      if (!needsShare && !needsFriend) return letter;
      changed = true;
      const linked = assignLetterLinks(
        { ...letter, audience: letter.audience === "friend" ? "friend" : "stranger" },
        used,
        randomBytes,
      );
      used.add(linked.shareToken);
      if (linked.friendToken) used.add(linked.friendToken);
      return linked;
    });
    if (!changed) return letters;
    store.replaceAll(next);
    return store.list();
  }

  function readyLetters(nowMs) {
    return backfillLinks(persistArrivals(nowMs));
  }

  function readLetter(id, nowMs) {
    return readyLetters(nowMs).find((letter) => letter.id === id) || null;
  }

  function recentRecipientIds(limit = 1) {
    const ids = [];
    for (const letter of store.list()) {
      if (!findRecipient(letter.to?.id)) continue;
      ids.push(letter.to.id);
      if (ids.length >= limit) break;
    }
    return ids;
  }

  function toRoute(geo) {
    return {
      from: geo.from,
      to: geo.to,
      distanceKm: geo.distanceKm,
      durationSeconds: geo.durationSeconds,
      pace: geo.pace,
      legs: geo.legs,
    };
  }

  app.get("/api/health", (req, res) => {
    res.json({ ok: true, pace: paceFallback });
  });

  app.get("/api/recipients", (req, res) => {
    res.json(RECIPIENTS);
  });

  app.get("/api/route", (req, res) => {
    const geo = buildGeometry(req.query.fromId, req.query.toId, req.query.pace, paceFallback, currentPeople());
    if (geo.error) return res.status(400).json({ error: geo.error });
    res.json(toRoute(geo));
  });

  app.post("/api/senders", (req, res) => {
    const body = req.body || {};
    if (body.ofAge !== true) return res.status(403).json({ error: AGE_REQUIRED });
    const senderId = normalizeSenderId(body.senderId);
    if (!senderId) return res.status(400).json({ error: "寄件人編號無法辨認" });
    const refusal = contactRefusal(typeof body.nickname === "string" ? body.nickname : "", { subject: "nickname" });
    if (refusal.kinds.length) {
      return res.status(400).json({ error: refusal.error, reasons: refusal.kinds });
    }
    const nickname = normalizeNickname(body.nickname);
    if (!nickname) return res.status(400).json({ error: "請留下一個暱稱。" });
    const city = findCity(body.cityId);
    if (!city) return res.status(400).json({ error: "找不到這個地區" });
    const existing = store.getSender(senderId);
    const saved = store.saveSender({
      id: senderId,
      nickname,
      cityId: city.id,
      city: city.name,
      country: city.country,
      createdAt: existing?.createdAt || new Date(now()).toISOString(),
    });
    res.status(existing ? 200 : 201).json(publicSender(saved));
  });

  app.post("/api/recipients/draw", (req, res) => {
    const body = req.body || {};
    const from = senderFromId(body.fromId || "taipei");
    if (!from) return res.status(400).json({ error: "找不到寄出地" });
    const sender = readSenderId(body.senderId);
    if (sender.error) return res.status(sender.status).json({ error: sender.error });
    const people = currentPeople();
    const registered = store.listSenders();
    const self = sender.senderId ? store.getSender(sender.senderId) : null;
    let toId = null;
    if (self && registered.length >= 2) {
      const blockedIds = store.listBlocks()
        .filter((block) => block.blockedId === sender.senderId)
        .map((block) => block.blockerId);
      const skipIds = [];
      for (const person of registered) {
        const city = findCity(person.cityId);
        if (!city || sameHomeCity(from, city)) skipIds.push(person.id);
      }
      const chosen = pickPerson({
        senders: registered,
        selfId: sender.senderId,
        excludeIds: [body.excludeId, lastMailedTo(sender.senderId)],
        blockedIds,
        skipIds,
        random,
      });
      if (chosen) toId = chosen.id;
    }
    if (!toId) {
      const demo = pickRecipient({
        from,
        excludeIds: [body.excludeId, ...recentRecipientIds(1)],
        random,
      });
      toId = demo.id;
    }
    const geo = buildGeometry(from.id, toId, body.pace, paceFallback, people);
    if (geo.error) return res.status(400).json({ error: geo.error });
    res.json(toRoute(geo));
  });

  app.get("/api/activity", (req, res) => {
    const nowMs = now();
    const letters = persistArrivals(nowMs);
    const trips = [
      ...backgroundSnapshots(nowMs, backgroundPlans(paceFallback)),
      ...letters.filter((letter) => letter.status === "in_flight").map((letter) => ({
        id: letter.id,
        kind: "yours",
        from: letter.from,
        to: letter.to,
        departedAt: letter.departedAt,
        arrivesAt: letter.arrivesAt,
      })),
    ];
    res.json({ traveling: trips.length, trips });
  });

  app.get("/api/letters", (req, res) => {
    const nowMs = now();
    const letters = readyLetters(nowMs);
    res.json(letters.map((letter) => toPublic(letter, nowMs)));
  });

  app.get("/api/letters/:id", (req, res) => {
    const nowMs = now();
    const letter = readLetter(req.params.id, nowMs);
    if (!letter) return res.status(404).json({ error: "找不到這封信" });
    res.json(toPublic(letter, nowMs));
  });

  app.get("/api/letters/:id/image", (req, res) => {
    const nowMs = now();
    const letter = readLetter(req.params.id, nowMs);
    if (!letter) return res.status(404).json({ error: "找不到這封信" });
    if (letter.status === "in_flight") {
      return res.status(403).json({ error: "信還在路上" });
    }
    const abs = store.imageAbsPath(letter.imageFile);
    if (!abs) return res.status(404).json({ error: "找不到信面" });
    const ext = path.extname(abs).slice(1);
    const types = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };
    res.set("Content-Type", types[ext] || "application/octet-stream");
    res.set("Cache-Control", "no-store");
    fs.createReadStream(abs).pipe(res);
  });

  function readSenderId(raw) {
    if (raw == null || raw === "") return { senderId: null };
    const senderId = normalizeSenderId(raw);
    if (!senderId) return { error: "寄件人編號無法辨認", status: 400 };
    return { senderId };
  }

  function guardInFlight(senderId, nowMs) {
    const id = readSenderId(senderId);
    if (id.error) return id;
    if (!id.senderId) return { error: "請帶上寄件人編號", status: 400 };
    const letters = persistArrivals(nowMs);
    const quota = quotaSnapshot(letters, id.senderId);
    if (!quota.full) return { senderId: id.senderId };
    return {
      error: quotaFullError(quota.limit),
      status: 409,
      limit: quota.limit,
      inFlight: quota.inFlight,
      soonestArrivesAt: quota.soonestArrivesAt,
    };
  }

  function quotaBody(result) {
    return {
      error: result.error,
      limit: result.limit,
      inFlight: result.inFlight,
      soonestArrivesAt: result.soonestArrivesAt,
    };
  }

  function applyImage(letterId, imageDataUrl) {
    const parsed = parseDataUrl(imageDataUrl);
    if (!parsed) return { error: "請附上信面圖片" };
    const cleaned = stripImageMeta(parsed.buffer, parsed.mime);
    const imageFile = store.saveImage(letterId, cleaned.length ? cleaned : parsed.buffer, parsed.ext);
    return { imageFile };
  }

  function currentPeople() {
    const map = new Map();
    for (const sender of store.listSenders()) {
      const city = findCity(sender.cityId);
      if (!city) continue;
      map.set(sender.id, personRecipient(sender, city));
    }
    return map;
  }

  function readNote(raw) {
    if (raw == null || raw === "") return { note: "" };
    if (typeof raw !== "string") return { error: "附言無法辨認", status: 400 };
    const note = raw.trim();
    if (note.length > 400) return { error: "附言太長。", status: 400 };
    const refusal = contactRefusal(note);
    if (refusal.kinds.length) {
      return { error: refusal.error, reasons: refusal.kinds, status: 400 };
    }
    return { note };
  }

  function decorateFrom(from, senderId) {
    const sender = senderId ? store.getSender(senderId) : null;
    if (!sender) return from;
    return {
      ...from,
      name: sender.nickname,
      city: from.city || from.name,
    };
  }

  function rejectPair(senderId, to) {
    if (!awaitsReceipt({ to })) return null;
    if (!senderId) return { error: "請先留下暱稱。", status: 400 };
    if (!store.getSender(senderId)) return { error: "請先留下暱稱。", status: 400 };
    if (to.id === senderId) return { error: "不能寄給自己。", status: 400 };
    const blocked = store.listBlocks().some((block) => (
      block.blockedId === senderId && block.blockerId === to.id
    ));
    if (blocked) return { error: "請換一位收件人。", status: 409 };
    return null;
  }

  function lastMailedTo(senderId) {
    if (!senderId) return null;
    for (const letter of store.list()) {
      if (letter.senderId !== senderId || letter.status === "draft") continue;
      return letter.to?.id || null;
    }
    return null;
  }

  function publicSender(sender) {
    const city = findCity(sender.cityId);
    return {
      id: sender.id,
      nickname: sender.nickname,
      city: city?.name || sender.city,
      cityId: sender.cityId,
      country: city?.country || sender.country || "",
      createdAt: sender.createdAt,
    };
  }

  function mailboxItem(letter) {
    const from = letter.from || {};
    const flying = letter.status === "in_flight";
    return {
      id: letter.id,
      status: letter.status,
      from: {
        name: from.name || "",
        city: from.city || "",
        country: from.country || "",
      },
      arrivesAt: letter.arrivesAt,
      receivedAt: letter.receivedAt || null,
      note: flying ? "" : (letter.note || ""),
      imageUrl: flying ? null : `/api/letters/${letter.id}/image`,
    };
  }

  app.get("/api/mailbox", (req, res) => {
    const sender = readSenderId(req.query.senderId);
    if (sender.error) return res.status(sender.status).json({ error: sender.error });
    if (!sender.senderId) return res.status(400).json({ error: "請帶上寄件人編號" });
    const nowMs = now();
    const letters = persistArrivals(nowMs).filter((letter) => (
      letter.to?.demo === false && letter.to?.id === sender.senderId && letter.status !== "draft"
    ));
    res.json({ letters: letters.map((letter) => mailboxItem(letter)) });
  });

  app.post("/api/letters", (req, res) => {
    const body = req.body || {};
    const sender = readSenderId(body.senderId);
    if (sender.error) return res.status(sender.status).json({ error: sender.error });
    const explicitFriend = Object.prototype.hasOwnProperty.call(body, "friendName")
      && String(body.friendName ?? "").trim() !== "";
    if (!explicitFriend && sender.senderId && body.toId === sender.senderId) {
      return res.status(400).json({ error: "不能寄給自己。" });
    }
    const people = currentPeople();
    const geo = resolveTrip(body, null, paceFallback, people);
    const geoError = geometryBody(geo);
    if (geoError) return res.status(400).json(geoError);
    const noted = readNote(body.note);
    if (noted.error) {
      return res.status(noted.status).json({ error: noted.error, reasons: noted.reasons });
    }
    const pair = rejectPair(sender.senderId, geo.to);
    if (pair) return res.status(pair.status).json({ error: pair.error });
    const nowMs = now();
    const launch = Boolean(body.launch);
    if (launch) {
      const gate = guardInFlight(sender.senderId, nowMs);
      if (gate.error) {
        const status = gate.status || 409;
        return res.status(status).json(gate.limit ? quotaBody(gate) : { error: gate.error });
      }
    }
    const id = randomUUID();
    const image = applyImage(id, body.imageDataUrl);
    if (image.error) return res.status(400).json({ error: image.error });
    const timestamp = new Date(nowMs).toISOString();
    let letter = assignLetterLinks({
      id,
      status: "draft",
      from: decorateFrom(geo.from, sender.senderId),
      to: geo.to,
      audience: geo.audience,
      distanceKm: geo.distanceKm,
      pace: geo.pace,
      durationSeconds: geo.durationSeconds,
      legs: geo.legs,
      senderId: sender.senderId,
      note: noted.note,
      imageFile: image.imageFile,
      createdAt: timestamp,
      updatedAt: timestamp,
      departedAt: null,
      arrivesAt: null,
      deliveredAt: null,
      receivedAt: null,
    }, takenTokens(store.list()), randomBytes);
    if (launch) {
      const departed = new Date(nowMs);
      letter = {
        ...letter,
        status: "in_flight",
        departedAt: departed.toISOString(),
        arrivesAt: new Date(departed.getTime() + geo.durationSeconds * 1000).toISOString(),
      };
    }
    store.create(letter);
    res.status(201).json(toPublic(letter, nowMs));
  });

  app.put("/api/letters/:id", (req, res) => {
    const nowMs = now();
    const existing = readLetter(req.params.id, nowMs);
    if (!existing) return res.status(404).json({ error: "找不到這封信" });
    if (existing.status !== "draft") {
      return res.status(409).json({ error: "這封信已經寄出" });
    }
    const body = req.body || {};
    const geo = resolveTrip(body, existing, paceFallback, currentPeople());
    const geoError = geometryBody(geo);
    if (geoError) return res.status(400).json(geoError);
    const sender = readSenderId(body.senderId == null ? existing.senderId : body.senderId);
    if (sender.error) return res.status(sender.status).json({ error: sender.error });
    const noted = readNote(body.note == null ? existing.note : body.note);
    if (noted.error) {
      return res.status(noted.status).json({ error: noted.error, reasons: noted.reasons });
    }
    const pair = rejectPair(sender.senderId, geo.to);
    if (pair) return res.status(pair.status).json({ error: pair.error });
    let imageFile = existing.imageFile;
    if (body.imageDataUrl) {
      const image = applyImage(existing.id, body.imageDataUrl);
      if (image.error) return res.status(400).json({ error: image.error });
      imageFile = image.imageFile;
    }
    const letter = store.update(existing.id, assignLetterLinks({
      ...existing,
      from: decorateFrom(geo.from, sender.senderId),
      to: geo.to,
      audience: geo.audience,
      distanceKm: geo.distanceKm,
      pace: geo.pace,
      durationSeconds: geo.durationSeconds,
      legs: geo.legs,
      senderId: sender.senderId,
      note: noted.note,
      imageFile,
      updatedAt: new Date(nowMs).toISOString(),
    }, takenTokens(store.list()), randomBytes));
    res.json(toPublic(letter, nowMs));
  });

  function launchDraft(req, res) {
    const nowMs = now();
    const existing = readLetter(req.params.id, nowMs);
    if (!existing) return res.status(404).json({ error: "找不到這封信" });
    if (existing.status !== "draft") {
      return res.status(409).json({ error: "這封信已經寄出" });
    }
    const body = req.body || {};
    const geo = resolveTrip(body, existing, paceFallback, currentPeople());
    const geoError = geometryBody(geo);
    if (geoError) return res.status(400).json(geoError);
    const sender = readSenderId(body.senderId == null ? existing.senderId : body.senderId);
    if (sender.error) return res.status(sender.status).json({ error: sender.error });
    const noted = readNote(body.note == null ? existing.note : body.note);
    if (noted.error) {
      return res.status(noted.status).json({ error: noted.error, reasons: noted.reasons });
    }
    const pair = rejectPair(sender.senderId, geo.to);
    if (pair) return res.status(pair.status).json({ error: pair.error });
    const gate = guardInFlight(sender.senderId, nowMs);
    if (gate.error) {
      const status = gate.status || 409;
      return res.status(status).json(gate.limit ? quotaBody(gate) : { error: gate.error });
    }
    let imageFile = existing.imageFile;
    if (body.imageDataUrl) {
      const image = applyImage(existing.id, body.imageDataUrl);
      if (image.error) return res.status(400).json({ error: image.error });
      imageFile = image.imageFile;
    }
    if (!imageFile) return res.status(400).json({ error: "請附上信面圖片" });
    const departed = new Date(nowMs);
    const letter = store.update(existing.id, assignLetterLinks({
      ...existing,
      status: "in_flight",
      from: decorateFrom(geo.from, gate.senderId),
      to: geo.to,
      audience: geo.audience,
      distanceKm: geo.distanceKm,
      pace: geo.pace,
      durationSeconds: geo.durationSeconds,
      legs: geo.legs,
      senderId: gate.senderId,
      note: noted.note,
      imageFile,
      departedAt: departed.toISOString(),
      arrivesAt: new Date(departed.getTime() + geo.durationSeconds * 1000).toISOString(),
      deliveredAt: null,
      receivedAt: null,
      updatedAt: departed.toISOString(),
    }, takenTokens(store.list()), randomBytes));
    res.json(toPublic(letter, nowMs));
  }

  function addressedTo(letter, senderId) {
    return Boolean(senderId) && awaitsReceipt(letter) && letter.to?.id === senderId;
  }

  app.post("/api/letters/:id/receive", (req, res) => {
    const nowMs = now();
    const letter = readLetter(req.params.id, nowMs);
    if (!letter) return res.status(404).json({ error: "找不到這封信" });
    const sender = readSenderId((req.body || {}).senderId);
    if (sender.error) return res.status(sender.status).json({ error: sender.error });
    if (!awaitsReceipt(letter)) return res.status(409).json({ error: "這封信不用登記。" });
    if (!addressedTo(letter, sender.senderId)) {
      return res.status(403).json({ error: "這封信不是寄給你的。" });
    }
    if (letter.status === "delivered" && letter.receivedAt) return res.json(toPublic(letter, nowMs));
    if (letter.status !== "awaiting_receipt") return res.status(409).json({ error: "信還在路上。" });
    const timestamp = new Date(nowMs).toISOString();
    const updated = store.update(letter.id, {
      status: "delivered",
      receivedAt: timestamp,
      deliveredAt: letter.arrivesAt,
      updatedAt: timestamp,
    });
    res.json(toPublic(updated, nowMs));
  });

  app.post("/api/letters/:id/report", (req, res) => {
    const nowMs = now();
    const letter = readLetter(req.params.id, nowMs);
    if (!letter) return res.status(404).json({ error: "找不到這封信" });
    const sender = readSenderId((req.body || {}).senderId);
    if (sender.error) return res.status(sender.status).json({ error: sender.error });
    if (!addressedTo(letter, sender.senderId)) {
      return res.status(403).json({ error: "這封信不是寄給你的。" });
    }
    if (letter.status === "draft" || letter.status === "in_flight") {
      return res.status(409).json({ error: "信還在路上。" });
    }
    if (!letter.senderId) return res.status(409).json({ error: "這封信沒有可檢舉的寄件人。" });
    const report = store.addReport({
      id: randomUUID(),
      letterId: letter.id,
      reporterId: sender.senderId,
      authorId: letter.senderId,
      createdAt: new Date(nowMs).toISOString(),
    });
    res.json({ ok: true, id: report.id });
  });

  app.post("/api/letters/:id/block", (req, res) => {
    const nowMs = now();
    const letter = readLetter(req.params.id, nowMs);
    if (!letter) return res.status(404).json({ error: "找不到這封信" });
    const sender = readSenderId((req.body || {}).senderId);
    if (sender.error) return res.status(sender.status).json({ error: sender.error });
    if (!addressedTo(letter, sender.senderId)) {
      return res.status(403).json({ error: "這封信不是寄給你的。" });
    }
    if (letter.status === "draft" || letter.status === "in_flight") {
      return res.status(409).json({ error: "信還在路上。" });
    }
    if (!letter.senderId || letter.senderId === sender.senderId) {
      return res.status(409).json({ error: "這封信沒有可封鎖的寄件人。" });
    }
    store.addBlock({
      blockerId: sender.senderId,
      blockedId: letter.senderId,
      createdAt: new Date(nowMs).toISOString(),
    });
    res.json({ ok: true });
  });

  app.post("/api/letters/:id/throw", launchDraft);
  app.post("/api/letters/:id/send", launchDraft);

  mountLetterLinks(app, {
    now,
    indexPath: path.join(root, "public/index.html"),
    load(field, token) {
      const nowMs = now();
      const letters = readyLetters(nowMs);
      return {
        nowMs,
        letter: letters.find((item) => item[field] === token) || null,
      };
    },
    imageAbsPath(letter) {
      return store.imageAbsPath(letter?.imageFile);
    },
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.type === "entity.parse.failed") {
      return res.status(400).json({ error: "無法讀取內容" });
    }
    if (err.type === "entity.too.large") {
      return res.status(413).json({ error: "信面太大" });
    }
    console.error(err);
    return res.status(500).json({ error: "伺服器錯誤" });
  });

  app.use("/shared", express.static(path.join(root, "shared")));
  app.use("/vendor/leaflet", express.static(path.join(root, "node_modules/leaflet/dist")));
  app.use(express.static(path.join(root, "public")));

  return app;
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || "0.0.0.0";
  createApp().listen(port, host, () => {
    console.log(`在路上  http://localhost:${port}`);
  });
}
