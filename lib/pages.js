import fs from "node:fs";
import path from "node:path";
import { formatSpan } from "../shared/clock.js";
import { describeFlight } from "../shared/flight.js";
import { renderShareCard, shareCardModel } from "./card.js";
import {
  isPublicToken,
  projectFriendOpen,
  shareCities,
  sharePublished,
} from "../shared/link.js";
import { planStops, postmarkSvg, revealStops, stopTimeMs } from "../shared/marks.js";
import { formatZonedDay } from "../shared/slip.js";

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

function originOf(req) {
  const forwarded = req.get("x-forwarded-proto");
  const proto = forwarded ? forwarded.split(",")[0].trim() : req.protocol;
  const host = req.get("x-forwarded-host") || req.get("host");
  return `${proto}://${host}`;
}

function stampMarkup(letter, nowMs) {
  const flight = describeFlight(letter, nowMs);
  const delivered = flight.status === "delivered" || letter.status === "awaiting_receipt";
  const visible = revealStops(planStops(letter.from, letter.to), flight.progress, { delivered });
  return visible.map((stop) => {
    const at = stopTimeMs(letter, stop.role === "arrived" ? 1 : stop.t);
    const date = Number.isFinite(at) ? formatZonedDay(new Date(at).toISOString(), stop.timeZone) : "";
    return postmarkSvg(stop, { date });
  }).join("");
}

export function renderSharePage(letter, nowMs, pageOrigin) {
  const places = shareCities(letter);
  const days = formatSpan(letter.durationSeconds);
  const title = `一封從${places.fromCity}寄往${places.toCity}的信`;
  const description = `信鴿從${places.fromCity}飛往${places.toCity}，路上 ${days}。`;
  const image = `${pageOrigin}/s/${letter.shareToken}/card.png`;
  const page = `${pageOrigin}/s/${letter.shareToken}`;
  const flight = describeFlight(letter, nowMs);
  const traveling = flight.status !== "delivered" && letter.status !== "awaiting_receipt";
  const status = traveling ? "信鴿還在路上。" : "這封信已經送到。";
  const where = [places.fromCountry, places.toCountry].filter(Boolean);
  const countryLine = where.length === 2 ? `從${where[0]}寄往${where[1]}` : "";
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />
  <meta property="og:type" content="website" />
  <meta property="og:locale" content="zh_TW" />
  <meta property="og:site_name" content="在路上" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:url" content="${esc(page)}" />
  <meta property="og:image" content="${esc(image)}" />
  <meta property="og:image:type" content="image/png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="${esc(title)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@500;600&amp;display=swap" rel="stylesheet" />
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: #d5dde3;
      color: #1d2a3a;
      font-family: "PingFang TC", "Noto Sans CJK TC", "WenQuanYi Micro Hei", sans-serif;
      display: flex;
      justify-content: center;
    }
    main {
      width: min(100%, 430px);
      min-height: 100vh;
      background: #f4f7f8;
      padding: 28px 20px 40px;
    }
    .kicker {
      margin: 0;
      color: #7a342e;
      letter-spacing: 0.28em;
      font-family: "Noto Serif TC", serif;
      font-size: 13px;
    }
    h1 {
      margin: 8px 0 0;
      font-family: "Noto Serif TC", serif;
      font-weight: 600;
      font-size: 28px;
      letter-spacing: 0.04em;
      line-height: 1.35;
    }
    .status { margin: 10px 0 0; color: #5c4636; }
    .envelope {
      position: relative;
      margin-top: 22px;
      background: #fffdf8;
      border: 1px solid #6e342e;
      min-height: 280px;
      padding: 148px 22px 22px;
    }
    .envelope::before {
      content: "";
      position: absolute;
      left: -1px;
      right: -1px;
      top: -1px;
      height: 132px;
      background:
        linear-gradient(to bottom right, transparent 49.5%, #6e342e 50%, transparent 50.6%) left top / 51% 100% no-repeat,
        linear-gradient(to bottom left, transparent 49.5%, #6e342e 50%, transparent 50.6%) right top / 51% 100% no-repeat,
        #f7f1e6;
      border-bottom: 1px solid rgba(110, 52, 46, 0.35);
    }
    .postage {
      position: absolute;
      z-index: 1;
      top: 16px;
      right: 16px;
      width: 72px;
      height: 88px;
      border: 2px dashed #6e342e;
      background: #f3eadc;
      color: #6e342e;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      font-family: "Noto Serif TC", serif;
      gap: 4px;
    }
    .postage b { font-size: 22px; font-weight: 600; }
    .postage span { font-size: 13px; letter-spacing: 0.12em; }
    .route {
      position: relative;
      margin: 0;
      font-family: "Noto Serif TC", serif;
      font-size: 26px;
      letter-spacing: 0.04em;
    }
    .days, .countries {
      position: relative;
      margin: 8px 0 0;
      color: #6e342e;
      font-family: "Noto Serif TC", serif;
    }
    .sheet {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 4px;
      margin-top: 22px;
    }
    .sheet:empty { display: none; }
    h2 {
      margin: 26px 0 0;
      font-family: "Noto Serif TC", serif;
      font-size: 16px;
      font-weight: 600;
      letter-spacing: 0.18em;
      color: #7a342e;
    }
    .home {
      display: inline-block;
      margin-top: 28px;
      color: #6e342e;
      font-family: "Noto Serif TC", serif;
      letter-spacing: 0.14em;
    }
  </style>
</head>
<body>
  <main>
    <p class="kicker">在路上</p>
    <h1>${esc(title)}</h1>
    <p class="status">${esc(status)}</p>
    <div class="envelope">
      <div class="postage"><span>在路上</span><b>郵</b></div>
      <p class="route">${esc(places.fromCity)} → ${esc(places.toCity)}</p>
      <p class="days">路上 ${esc(days)}</p>
      <p class="countries">${esc(countryLine)}</p>
    </div>
    <h2>沿途郵戳</h2>
    <div class="sheet">${stampMarkup(letter, nowMs)}</div>
    <a class="home" href="/">回在路上</a>
  </main>
</body>
</html>`;
}

function notFoundPage(message) {
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>找不到這封信</title>
</head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#e7dcc8;font-family:'Noto Serif TC',serif;color:#6e342e;">
  <p>${esc(message)}</p>
</body>
</html>`;
}

const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

export function mountLetterLinks(app, { now, load, imageAbsPath, indexPath }) {
  app.get("/api/open/:token", (req, res) => {
    if (!isPublicToken(req.params.token)) {
      return res.status(404).json({ error: "找不到這封信" });
    }
    const { letter, nowMs } = load("friendToken", req.params.token);
    const projected = letter ? projectFriendOpen(letter, nowMs) : null;
    if (!projected) return res.status(404).json({ error: "找不到這封信" });
    res.json(projected);
  });

  app.get("/api/open/:token/image", (req, res) => {
    if (!isPublicToken(req.params.token)) {
      return res.status(404).json({ error: "找不到這封信" });
    }
    const { letter, nowMs } = load("friendToken", req.params.token);
    const projected = letter ? projectFriendOpen(letter, nowMs) : null;
    if (!projected) return res.status(404).json({ error: "找不到這封信" });
    if (projected.state === "traveling") {
      return res.status(403).json({ error: "信還在路上" });
    }
    if (projected.state === "returned") {
      return res.status(410).json({ error: "這封信已經退回郵局" });
    }
    const abs = imageAbsPath(letter);
    if (!abs) return res.status(404).json({ error: "找不到信面" });
    const ext = path.extname(abs).slice(1);
    res.set("Content-Type", IMAGE_TYPES[ext] || "application/octet-stream");
    res.set("Cache-Control", "no-store");
    fs.createReadStream(abs).pipe(res);
  });

  app.get("/api/share/:token", (req, res) => {
    if (!isPublicToken(req.params.token)) {
      return res.status(404).json({ error: "找不到這封信" });
    }
    const { letter, nowMs } = load("shareToken", req.params.token);
    if (!letter || !sharePublished(letter)) {
      return res.status(404).json({ error: "找不到這封信" });
    }
    const flight = describeFlight(letter, nowMs);
    const places = shareCities(letter);
    res.json({
      state: flight.status === "delivered" ? "arrived" : "traveling",
      from: { city: places.fromCity, country: places.fromCountry },
      to: { city: places.toCity, country: places.toCountry },
      durationSeconds: letter.durationSeconds,
      daysText: formatSpan(letter.durationSeconds),
      progress: flight.progress,
    });
  });

  app.get("/s/:token/card.png", (req, res) => {
    if (!isPublicToken(req.params.token)) {
      return res.status(404).type("text/plain").send("找不到這封信");
    }
    const { letter, nowMs } = load("shareToken", req.params.token);
    if (!letter || !sharePublished(letter)) {
      return res.status(404).type("text/plain").send("找不到這封信");
    }
    const png = renderShareCard(shareCardModel(letter, nowMs));
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=300");
    res.set("X-Content-Type-Options", "nosniff");
    res.send(png);
  });

  app.get("/s/:token", (req, res) => {
    if (!isPublicToken(req.params.token)) {
      return res.status(404).type("html").send(notFoundPage("找不到這封信"));
    }
    const { letter, nowMs } = load("shareToken", req.params.token);
    if (!letter || !sharePublished(letter)) {
      return res.status(404).type("html").send(notFoundPage("找不到這封信"));
    }
    res.set("Cache-Control", "no-store");
    res.type("html").send(renderSharePage(letter, nowMs, originOf(req)));
  });

  app.get("/f/:token", (req, res) => {
    if (!isPublicToken(req.params.token)) {
      return res.status(404).type("html").send(notFoundPage("找不到這封信"));
    }
    const html = fs.readFileSync(indexPath, "utf8").replace(
      "<title>在路上</title>",
      "<title>一封在路上的信</title>\n    <meta name=\"robots\" content=\"noindex\" />",
    );
    res.set("Cache-Control", "no-store");
    res.type("html").send(html);
  });
}
