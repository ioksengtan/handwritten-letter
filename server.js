import express from "express";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createStore } from "./lib/store.js";
import { describeFlight, flightDurationSeconds, haversineKm } from "./shared/flight.js";
import { PLACES, PRESETS, findPlace } from "./shared/places.js";

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

function pointFromId(id) {
  const place = findPlace(id);
  if (!place) return null;
  return { id: place.id, name: place.name, lat: place.lat, lng: place.lng };
}

function buildGeometry(fromId, toId, pace) {
  const from = pointFromId(fromId);
  const to = pointFromId(toId);
  if (!from || !to) return { error: "找不到地點" };
  if (from.id === to.id) return { error: "請選擇不同的寄出地與收件地" };
  const distanceKm = round(haversineKm(from.lat, from.lng, to.lat, to.lng), 3);
  if (distanceKm < MIN_DISTANCE_KM) return { error: "請選擇不同的寄出地與收件地" };
  let durationSeconds;
  try {
    durationSeconds = flightDurationSeconds(distanceKm, pace || "playable-fast");
  } catch {
    return { error: "不認識的飛行節奏" };
  }
  return {
    from,
    to,
    distanceKm,
    durationSeconds,
    pace: pace || "playable-fast",
  };
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
    serverNow: new Date(nowMs).toISOString(),
    imageUrl: imageVisible ? `/api/letters/${letter.id}/image` : null,
  };
}

export function createApp({ dataDir = path.join(root, "data"), now = () => Date.now() } = {}) {
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
        return {
          ...letter,
          status: "delivered",
          deliveredAt: letter.arrivesAt,
          updatedAt: new Date(nowMs).toISOString(),
        };
      }
      return letter;
    });
    if (changed) store.replaceAll(next);
    return changed ? store.list() : next;
  }

  function readLetter(id, nowMs) {
    persistArrivals(nowMs);
    return store.get(id);
  }

  app.get("/api/places", (req, res) => {
    res.json(PLACES);
  });

  app.get("/api/presets", (req, res) => {
    res.json(PRESETS);
  });

  app.get("/api/letters", (req, res) => {
    const nowMs = now();
    const letters = persistArrivals(nowMs);
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

  function applyImage(letterId, imageDataUrl) {
    const parsed = parseDataUrl(imageDataUrl);
    if (!parsed) return { error: "請附上信面圖片" };
    const imageFile = store.saveImage(letterId, parsed.buffer, parsed.ext);
    return { imageFile };
  }

  app.post("/api/letters", (req, res) => {
    const body = req.body || {};
    const geo = buildGeometry(body.fromId, body.toId, body.pace);
    if (geo.error) return res.status(400).json({ error: geo.error });
    const id = randomUUID();
    const image = applyImage(id, body.imageDataUrl);
    if (image.error) return res.status(400).json({ error: image.error });
    const nowMs = now();
    const timestamp = new Date(nowMs).toISOString();
    const launch = Boolean(body.launch);
    let letter = {
      id,
      status: "draft",
      from: geo.from,
      to: geo.to,
      distanceKm: geo.distanceKm,
      pace: geo.pace,
      durationSeconds: geo.durationSeconds,
      imageFile: image.imageFile,
      createdAt: timestamp,
      updatedAt: timestamp,
      departedAt: null,
      arrivesAt: null,
      deliveredAt: null,
    };
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
      return res.status(409).json({ error: "這封信已經扔出" });
    }
    const body = req.body || {};
    const geo = buildGeometry(
      body.fromId || existing.from.id,
      body.toId || existing.to.id,
      body.pace || existing.pace,
    );
    if (geo.error) return res.status(400).json({ error: geo.error });
    let imageFile = existing.imageFile;
    if (body.imageDataUrl) {
      const image = applyImage(existing.id, body.imageDataUrl);
      if (image.error) return res.status(400).json({ error: image.error });
      imageFile = image.imageFile;
    }
    const letter = store.update(existing.id, {
      from: geo.from,
      to: geo.to,
      distanceKm: geo.distanceKm,
      pace: geo.pace,
      durationSeconds: geo.durationSeconds,
      imageFile,
      updatedAt: new Date(nowMs).toISOString(),
    });
    res.json(toPublic(letter, nowMs));
  });

  app.post("/api/letters/:id/throw", (req, res) => {
    const nowMs = now();
    const existing = readLetter(req.params.id, nowMs);
    if (!existing) return res.status(404).json({ error: "找不到這封信" });
    if (existing.status !== "draft") {
      return res.status(409).json({ error: "這封信已經扔出" });
    }
    const body = req.body || {};
    const geo = buildGeometry(
      body.fromId || existing.from.id,
      body.toId || existing.to.id,
      body.pace || existing.pace,
    );
    if (geo.error) return res.status(400).json({ error: geo.error });
    let imageFile = existing.imageFile;
    if (body.imageDataUrl) {
      const image = applyImage(existing.id, body.imageDataUrl);
      if (image.error) return res.status(400).json({ error: image.error });
      imageFile = image.imageFile;
    }
    if (!imageFile) return res.status(400).json({ error: "請附上信面圖片" });
    const departed = new Date(nowMs);
    const letter = store.update(existing.id, {
      status: "in_flight",
      from: geo.from,
      to: geo.to,
      distanceKm: geo.distanceKm,
      pace: geo.pace,
      durationSeconds: geo.durationSeconds,
      imageFile,
      departedAt: departed.toISOString(),
      arrivesAt: new Date(departed.getTime() + geo.durationSeconds * 1000).toISOString(),
      deliveredAt: null,
      updatedAt: departed.toISOString(),
    });
    res.json(toPublic(letter, nowMs));
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
  createApp().listen(port, () => {
    console.log(`手寫信  http://localhost:${port}`);
  });
}
