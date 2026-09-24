import {
  alignLongitude,
  bearingDegrees,
  haversineKm,
  locateOnLegs,
  samplePath,
  unwrapLongitudes,
} from "/shared/flight.js";
import { PLACES, findPlace, findPreset } from "/shared/places.js";
import { CITIES, findCity, findRecipient } from "/shared/recipients.js";
import { MODE_COLOR, MODE_LABEL, legVia, planCourier } from "/shared/route.js";

const PAPER = "#fffdf8";
const INK = "#2a4a8a";
const PLANE_SVG = `
<svg viewBox="0 0 64 64" width="42" height="42" aria-hidden="true">
  <path d="M32 6 L56 52 L32 42 L8 52 Z" fill="#fffefb" stroke="#1d2a3a" stroke-width="1.7" stroke-linejoin="round"/>
  <path d="M32 16 L32 42" stroke="#1d2a3a" stroke-width="1.1" opacity="0.35"/>
</svg>`;
const TRUCK_SVG = `
<svg viewBox="0 0 64 64" width="42" height="42" aria-hidden="true">
  <rect x="22" y="8" width="20" height="16" rx="3" fill="#fffefb" stroke="#1d2a3a" stroke-width="1.7"/>
  <rect x="16" y="24" width="32" height="22" rx="3" fill="#fffefb" stroke="#1d2a3a" stroke-width="1.7"/>
  <circle cx="24" cy="50" r="4" fill="#1d2a3a"/>
  <circle cx="40" cy="50" r="4" fill="#1d2a3a"/>
</svg>`;
const TRAIN_SVG = `
<svg viewBox="0 0 64 64" width="42" height="42" aria-hidden="true">
  <rect x="18" y="8" width="28" height="40" rx="8" fill="#fffefb" stroke="#1d2a3a" stroke-width="1.7"/>
  <rect x="24" y="16" width="16" height="10" rx="2" fill="#d5e4f2"/>
  <circle cx="24" cy="52" r="3.4" fill="#1d2a3a"/>
  <circle cx="40" cy="52" r="3.4" fill="#1d2a3a"/>
</svg>`;
const MODE_SVG = { road: TRUCK_SVG, train: TRAIN_SVG, plane: PLANE_SVG };
const MODE_NOW = { road: "現在走公路", train: "現在搭火車", plane: "現在搭飛機" };

const state = {
  view: "home",
  fromId: "taipei",
  toId: "kaohsiung",
  recipient: null,
  mode: "preset",
  pace: "playable-fast",
  draftId: null,
  ctx: null,
  cssW: 0,
  cssH: 0,
  dpr: 1,
  undo: [],
  map: null,
  mapUnwrap: false,
  originLng: 0,
  dots: new Map(),
  trips: [],
  raf: 0,
  poll: 0,
  flight: null,
  submitting: false,
};

let renderToken = 0;
let toastTimer = 0;
let clockSkew = 0;

const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return minutes > 0 ? `${hours} 小時 ${minutes} 分` : `${hours} 小時`;
  if (minutes > 0) return secs > 0 ? `${minutes} 分 ${secs} 秒` : `${minutes} 分鐘`;
  return `${secs} 秒`;
}

function formatDistance(km) {
  if (km < 1) return `${Math.max(1, Math.round(km * 1000))} 公尺`;
  if (km < 10) return `${km.toFixed(1)} 公里`;
  return `${Math.round(km)} 公里`;
}

function syncClock(iso) {
  if (!iso) return;
  clockSkew = Date.parse(iso) - Date.now();
}

function nowMs() {
  return Date.now() + clockSkew;
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 3200);
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) throw new Error(data?.error || "連線失敗");
  return data;
}

function parseHash() {
  const raw = (location.hash || "#/").replace(/^#/, "");
  const [path, query = ""] = raw.split("?");
  const parts = path.split("/").filter(Boolean);
  return { parts, params: new URLSearchParams(query) };
}

function navigate(hash) {
  if (location.hash === hash) {
    render().catch((err) => showToast(err.message));
    return;
  }
  location.hash = hash;
}

function showOnly(name) {
  state.view = name;
  for (const id of ["home", "compose", "draw", "flight", "read"]) {
    $(`view-${id}`).hidden = id !== name;
  }
}

function whereLine(point) {
  if (!point) return "";
  if (point.country && point.country !== point.city && point.city) {
    return `${point.city} · ${point.country}`;
  }
  return point.city || point.name;
}

function routeLine(from, to) {
  if (to.city && to.name !== to.city) return `${from.name} → ${to.name} · ${to.city}`;
  return `${from.name} → ${to.name}`;
}

function pinLabel(point) {
  if (point.city && point.name !== point.city) return `${point.name} · ${point.city}`;
  return point.name;
}

function senderById(id) {
  return findCity(id) || findPlace(id);
}

function stopLoops() {
  if (state.raf) cancelAnimationFrame(state.raf);
  state.raf = 0;
  if (state.poll) clearInterval(state.poll);
  state.poll = 0;
  if (state.map) {
    state.map.remove();
    state.map = null;
  }
  state.dots = new Map();
  state.mapUnwrap = false;
  state.flight = null;
}

function renderHomeList(letters) {
  const root = $("home-letters");
  const scroller = $("view-home").querySelector(".scroll");
  const scroll = scroller.scrollTop;
  const groups = [
    { key: "in_flight", title: "在路上" },
    { key: "delivered", title: "已抵達" },
    { key: "draft", title: "草稿" },
  ];
  if (!letters.length) {
    root.innerHTML = `<p class="empty">還沒有信。抽一位收件人，或用下面的固定路線試飛。</p>`;
    return;
  }
  const html = groups.map((group) => {
    let items = letters.filter((letter) => letter.status === group.key);
    if (!items.length) return "";
    if (group.key === "in_flight") {
      items = items.slice().sort((a, b) => a.etaSeconds - b.etaSeconds);
    }
    const cards = items.map((letter) => {
      const route = esc(routeLine(letter.from, letter.to));
      let detail = "草稿";
      let extra = "";
      if (letter.status === "in_flight") {
        const mode = letter.mode ? `${esc(MODE_LABEL[letter.mode] || "")} · ` : "";
        detail = `${mode}剩餘 ${esc(formatDistance(letter.remainingKm))} · ${esc(formatDuration(letter.etaSeconds))}後抵達`;
        extra = `<span class="mini-track"><span style="width:${Math.round(letter.progress * 100)}%"></span></span>`;
      } else if (letter.status === "delivered") {
        detail = "已抵達 · 打開";
      }
      return `<button type="button" class="card" data-id="${esc(letter.id)}" data-status="${esc(letter.status)}">
        <span><b>${route}</b><small>${detail}</small>${extra}</span>
      </button>`;
    }).join("");
    return `<section class="group"><h2>${group.title}</h2>${cards}</section>`;
  }).join("");
  root.innerHTML = html;
  scroller.scrollTop = scroll;
  root.querySelectorAll(".card").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.id;
      if (button.dataset.status === "draft") navigate(`#/compose?draft=${id}`);
      else if (button.dataset.status === "delivered") navigate(`#/read/${id}`);
      else navigate(`#/flight/${id}`);
    });
  });
}

async function loadActivity() {
  const activity = await api("/api/activity");
  state.trips = activity.trips;
  const text = `${activity.traveling} 封信正在路上`;
  setText("travel-count", text);
  setText("flight-travel", text);
  return activity;
}

async function refreshHome() {
  const [letters] = await Promise.all([api("/api/letters"), loadActivity()]);
  if (state.view !== "home") return;
  renderHomeList(letters);
  ensureHomeMap();
}

function buildPresets() {
  const root = $("preset-list");
  for (const preset of ["tpe-khh", "tpe-tyo", "tpe-101"].map(findPreset)) {
    const from = findPlace(preset.from);
    const to = findPlace(preset.to);
    const plan = planCourier({ from, to, pace: "playable-fast" });
    const modes = plan.legs.map((leg) => MODE_LABEL[leg.mode]).join(" → ");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "preset";
    button.innerHTML = `<span><b>${esc(preset.label)}</b><small>${esc(preset.note)} · ${esc(modes)} · ${esc(formatDistance(plan.distanceKm))}</small></span><span class="preset-time">約 ${esc(formatDuration(plan.durationSeconds))}</span>`;
    button.addEventListener("click", () => navigate(`#/compose?preset=${preset.id}`));
    root.append(button);
  }
}

function buildPlaceChips() {
  for (const [containerId, which] of [["from-chips", "from"], ["to-chips", "to"]]) {
    const root = $(containerId);
    for (const place of PLACES) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chip";
      button.dataset.id = place.id;
      button.textContent = place.name;
      button.addEventListener("click", () => selectPlace(which, place.id));
      root.append(button);
    }
  }
  for (const containerId of ["sender-chips", "draw-senders"]) {
    const root = $(containerId);
    for (const city of CITIES) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chip";
      button.dataset.id = city.id;
      button.textContent = city.name;
      button.addEventListener("click", () => {
        if (containerId === "draw-senders") changeDrawSender(city.id);
        else selectSender(city.id);
      });
      root.append(button);
    }
  }
}

function paintSenderChips() {
  for (const containerId of ["sender-chips", "draw-senders"]) {
    const root = $(containerId);
    for (const button of root.querySelectorAll("button")) {
      const selected = button.dataset.id === state.fromId;
      button.setAttribute("aria-pressed", selected ? "true" : "false");
      if (selected) button.scrollIntoView({ inline: "center", block: "nearest" });
    }
  }
}

function selectSender(id) {
  state.fromId = id;
  paintSenderChips();
  updateEstimate();
  if (state.mode === "recipient" && state.recipient) {
    const next = `#/compose?from=${encodeURIComponent(id)}&to=${encodeURIComponent(state.recipient.id)}`;
    if (location.hash !== next) history.replaceState(null, "", next);
  }
}

function paintChips() {
  for (const button of $("from-chips").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", button.dataset.id === state.fromId ? "true" : "false");
  }
  for (const button of $("to-chips").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", button.dataset.id === state.toId ? "true" : "false");
  }
}

function selectPlace(which, id) {
  if (which === "from") state.fromId = id;
  else state.toId = id;
  paintChips();
  updateEstimate();
}

function currentEndpoints() {
  const from = senderById(state.fromId);
  const to = state.recipient || findPlace(state.toId);
  return { from, to };
}

function sameEndpoint(from, to) {
  if (!from || !to) return true;
  if (state.recipient && (state.recipient.cityId === from.id)) return true;
  if (!state.recipient && from.id === to.id) return true;
  return haversineKm(from.lat, from.lng, to.lat, to.lng) < 0.05;
}

function updateEstimate() {
  const box = $("estimate");
  const { from, to } = currentEndpoints();
  if (sameEndpoint(from, to)) {
    box.className = "estimate warn";
    box.textContent = "請選擇不同的寄出地與收件地";
    return;
  }
  const plan = planCourier({ from, to, pace: state.pace });
  box.className = "estimate";
  box.innerHTML = `<strong>${esc(formatDistance(plan.distanceKm))}</strong><span>約 ${esc(formatDuration(plan.durationSeconds))}</span><span class="via">${esc(legVia(plan.legs))}</span>`;
}

function applyComposeMode() {
  const recipientMode = state.mode === "recipient" && state.recipient;
  $("recipient-banner").hidden = !recipientMode;
  $("sender-panel").hidden = !recipientMode;
  $("from-panel").hidden = Boolean(recipientMode);
  $("to-panel").hidden = Boolean(recipientMode);
  if (recipientMode) {
    $("recipient-name").textContent = state.recipient.name;
    $("recipient-where").textContent = whereLine(state.recipient);
    paintSenderChips();
  }
  paintChips();
  updateEstimate();
}

function setPace(pace) {
  state.pace = pace;
  $("pace-fast").setAttribute("aria-pressed", pace === "playable-fast" ? "true" : "false");
  $("pace-slow").setAttribute("aria-pressed", pace === "romantic-slow" ? "true" : "false");
  $("pace-hint").hidden = pace !== "romantic-slow";
  updateEstimate();
}

function fillPaper() {
  const canvas = $("letter-canvas");
  const { ctx } = state;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
}

function setupCanvas() {
  const canvas = $("letter-canvas");
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.6;
  state.ctx = ctx;
  state.cssW = width;
  state.cssH = height;
  state.dpr = dpr;
  state.undo = [];
  fillPaper();
}

function pushUndo() {
  const canvas = $("letter-canvas");
  state.undo.push(state.ctx.getImageData(0, 0, canvas.width, canvas.height));
  if (state.undo.length > 10) state.undo.shift();
}

function canvasHasInk() {
  const canvas = $("letter-canvas");
  const { data } = state.ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < 248 || data[i + 1] < 246 || data[i + 2] < 238) return true;
  }
  return false;
}

function paintContained(img) {
  const { ctx, cssW, cssH } = state;
  fillPaper();
  const scale = Math.min(cssW / img.width, cssH / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, (cssW - w) / 2, (cssH - h) / 2, w, h);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("圖片讀取失敗"));
    img.src = src;
  });
}

function bindCanvas() {
  const canvas = $("letter-canvas");
  let drawing = false;
  let last = null;

  function point(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (!state.ctx) return;
    event.preventDefault();
    drawing = true;
    canvas.setPointerCapture(event.pointerId);
    pushUndo();
    last = point(event);
    state.ctx.beginPath();
    state.ctx.fillStyle = INK;
    state.ctx.arc(last.x, last.y, 1.3, 0, Math.PI * 2);
    state.ctx.fill();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!drawing || !state.ctx) return;
    const next = point(event);
    state.ctx.strokeStyle = INK;
    state.ctx.lineWidth = 2.6;
    state.ctx.beginPath();
    state.ctx.moveTo(last.x, last.y);
    state.ctx.lineTo(next.x, next.y);
    state.ctx.stroke();
    last = next;
  });

  const end = () => {
    drawing = false;
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
}

function undoStroke() {
  const canvas = $("letter-canvas");
  const prev = state.undo.pop();
  if (!prev || !state.ctx) return;
  state.ctx.setTransform(1, 0, 0, 1, 0, 0);
  state.ctx.putImageData(prev, 0, 0);
  state.ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
}

function clearCanvas() {
  if (!state.ctx) return;
  pushUndo();
  fillPaper();
}

async function drawUpload(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    showToast("請上傳圖片");
    return;
  }
  if (file.size > 7 * 1024 * 1024) {
    showToast("圖片請小於 7 MB");
    return;
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    pushUndo();
    paintContained(img);
  } catch (err) {
    showToast(err.message);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function openCompose(params, token) {
  showOnly("compose");
  setupCanvas();
  state.draftId = null;
  state.recipient = null;
  state.mode = "preset";
  state.pace = "playable-fast";
  const preset = findPreset(params.get("preset") || "");
  const recipient = findRecipient(params.get("to") || "");
  if (recipient) {
    state.mode = "recipient";
    state.recipient = recipient;
    state.toId = recipient.id;
    state.fromId = params.get("from") || "taipei";
  } else if (preset) {
    state.fromId = preset.from;
    state.toId = preset.to;
  } else if (!params.get("draft")) {
    state.fromId = "taipei";
    state.toId = "kaohsiung";
  }
  const draftId = params.get("draft");
  if (draftId) {
    const letter = await api(`/api/letters/${draftId}`);
    if (token !== renderToken) return;
    if (letter.status !== "draft") {
      if (letter.status === "delivered") navigate(`#/read/${draftId}`);
      else navigate(`#/flight/${draftId}`);
      return;
    }
    state.draftId = letter.id;
    state.fromId = letter.from.id;
    state.toId = letter.to.id;
    state.pace = letter.pace || "playable-fast";
    const drafted = findRecipient(letter.to.id);
    if (drafted) {
      state.mode = "recipient";
      state.recipient = drafted;
    } else {
      state.mode = "preset";
      state.recipient = null;
    }
    if (letter.imageUrl) {
      const img = await loadImage(letter.imageUrl);
      paintContained(img);
    }
  }
  applyComposeMode();
  setPace(state.pace);
}

async function submitLetter(launch) {
  if (state.submitting) return;
  const { from, to } = currentEndpoints();
  if (sameEndpoint(from, to)) {
    showToast("請選擇不同的寄出地與收件地");
    return;
  }
  if (!canvasHasInk()) {
    showToast("請先寫下或上傳信面");
    return;
  }
  state.submitting = true;
  $("btn-throw").disabled = true;
  $("btn-save").disabled = true;
  try {
    const body = {
      fromId: from.id,
      toId: state.recipient ? state.recipient.id : to.id,
      pace: state.pace,
      imageDataUrl: $("letter-canvas").toDataURL("image/jpeg", 0.86),
      launch,
    };
    let letter;
    if (state.draftId && launch) {
      letter = await api(`/api/letters/${state.draftId}/throw`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    } else if (state.draftId) {
      letter = await api(`/api/letters/${state.draftId}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
    } else {
      letter = await api("/api/letters", {
        method: "POST",
        body: JSON.stringify(body),
      });
    }
    navigate(launch ? `#/flight/${letter.id}` : "#/");
  } catch (err) {
    showToast(err.message);
  } finally {
    state.submitting = false;
    $("btn-throw").disabled = false;
    $("btn-save").disabled = false;
  }
}

function setText(id, value) {
  const el = $(id);
  if (el.textContent !== value) el.textContent = value;
}

function letterLegs(record) {
  if (record.legs?.length) return record.legs;
  const from = record.from;
  const to = record.to;
  return [{
    mode: "plane",
    from: { name: from.name, lat: from.lat, lng: from.lng },
    to: { name: to.city || to.name, lat: to.lat, lng: to.lng },
    distanceKm: record.distanceKm || haversineKm(from.lat, from.lng, to.lat, to.lng),
    durationSeconds: record.durationSeconds || 1,
  }];
}

function sampleLegs(legs) {
  const flat = [];
  const ranges = [];
  for (const leg of legs) {
    const chunk = samplePath(leg.from, leg.to, leg.mode === "plane" ? 64 : 12);
    const start = flat.length;
    flat.push(...(start === 0 ? chunk : chunk.slice(1)));
    ranges.push([start, flat.length]);
  }
  const unwrapped = unwrapLongitudes(flat);
  return ranges.map(([start, end]) => unwrapped.slice(start, end));
}

function addTiles(map) {
  map.createPane("plane");
  map.getPane("plane").style.zIndex = 640;
  map.createPane("traffic");
  map.getPane("traffic").style.zIndex = 450;
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    subdomains: "abcd",
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap &copy; CARTO",
  }).addTo(map);
}

function mountRouteMap(container, from, to, { legs, showPlane = false, padBottom = 196, badges = false } = {}) {
  const routeLegs = legs?.length ? legs : letterLegs({ from, to });
  const legPaths = sampleLegs(routeLegs);
  const map = L.map(container, {
    zoomControl: true,
    attributionControl: true,
    worldCopyJump: true,
  });
  addTiles(map);

  const legFlown = [];
  routeLegs.forEach((leg, index) => {
    const path = legPaths[index];
    const latLngs = path.map((point) => [point.lat, point.lng]);
    L.polyline(latLngs, {
      color: MODE_COLOR[leg.mode],
      weight: 3,
      opacity: 0.4,
      dashArray: "1 8",
      lineCap: "round",
    }).addTo(map);
    legFlown.push(L.polyline([], {
      color: MODE_COLOR[leg.mode],
      weight: 3.5,
      opacity: 0.95,
    }).addTo(map));
    if (badges) {
      const mid = path[Math.floor(path.length / 2)];
      L.marker([mid.lat, mid.lng], {
        icon: L.divIcon({
          className: "mode-badge",
          html: `<span class="mode-badge-icon" style="background:${MODE_COLOR[leg.mode]}">${MODE_SVG[leg.mode]}</span>`,
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        }),
        interactive: false,
        zIndexOffset: 500,
      }).addTo(map);
    }
    if (index > 0) {
      L.marker([path[0].lat, path[0].lng], {
        icon: L.divIcon({
          className: "dot-icon",
          html: `<span class="dot dot-hub"></span>`,
          iconSize: [8, 8],
          iconAnchor: [4, 4],
        }),
        interactive: false,
      }).addTo(map);
    }
  });

  const dot = (color) => L.divIcon({
    className: "dot-icon",
    html: `<span class="dot dot-origin" style="background:${color}"></span>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  });
  const origin = legPaths[0][0];
  const dest = legPaths[legPaths.length - 1][legPaths[legPaths.length - 1].length - 1];
  L.marker([origin.lat, origin.lng], { icon: dot(MODE_COLOR[routeLegs[0].mode]), interactive: false })
    .bindTooltip(pinLabel(from), { permanent: true, direction: "left", className: "city-label", offset: [-8, 0] })
    .addTo(map);
  L.marker([dest.lat, dest.lng], { icon: dot(MODE_COLOR[routeLegs[routeLegs.length - 1].mode]), interactive: false })
    .bindTooltip(pinLabel(to), { permanent: true, direction: "right", className: "city-label", offset: [8, 0] })
    .addTo(map);

  let plane = null;
  if (showPlane) {
    plane = L.marker([origin.lat, origin.lng], {
      icon: L.divIcon({
        className: "plane-wrap",
        html: `<div class="plane-rot"><div class="courier-glyph">${MODE_SVG[routeLegs[0].mode]}</div></div>`,
        iconSize: [42, 42],
        iconAnchor: [21, 21],
      }),
      pane: "plane",
      interactive: false,
      zIndexOffset: 800,
    }).addTo(map);
  }

  const all = legPaths.flat().map((point) => [point.lat, point.lng]);
  const fit = () => {
    map.invalidateSize();
    map.fitBounds(all, {
      paddingTopLeft: [36, 72],
      paddingBottomRight: [36, padBottom],
      animate: false,
    });
  };
  fit();
  requestAnimationFrame(fit);
  state.mapUnwrap = true;
  state.originLng = origin.lng;
  state.dots = new Map();
  container.__map = map;
  return { map, legPaths, legFlown, plane, legs: routeLegs, originLng: origin.lng };
}

function renderLegend(id, legs, activeIndex) {
  const root = $(id);
  const key = `${legs.map((leg) => leg.mode).join("-")}:${activeIndex}`;
  if (root.dataset.key === key) return;
  root.dataset.key = key;
  root.innerHTML = legs.map((leg, index) => {
    const active = index === activeIndex ? " is-active" : "";
    return `<span class="leg${active}"><i style="background:${MODE_COLOR[leg.mode]}"></i>${esc(MODE_LABEL[leg.mode])}</span>`;
  }).join(`<span class="leg-arrow">→</span>`);
}

function paintFlown(legPaths, legFlown, legs, elapsed) {
  const loc = locateOnLegs(legs, elapsed);
  legPaths.forEach((path, index) => {
    let slice = [];
    if (index < loc.legIndex) slice = path;
    else if (index === loc.legIndex) {
      const n = Math.round(loc.legFraction * (path.length - 1));
      slice = path.slice(0, n + 1);
    }
    legFlown[index].setLatLngs(slice.map((point) => [point.lat, point.lng]));
  });
  return loc;
}

function mountFlight(letter) {
  const legs = letterLegs(letter);
  const view = mountRouteMap($("map"), letter.from, letter.to, { legs, showPlane: true, padBottom: 250 });
  state.map = view.map;
  state.flight = {
    letter,
    legs,
    legPaths: view.legPaths,
    legFlown: view.legFlown,
    plane: view.plane,
    originLng: view.originLng,
    shownMode: legs[0].mode,
    lastBearing: bearingDegrees(legs[0].from.lat, legs[0].from.lng, legs[0].to.lat, legs[0].to.lng),
    arrived: false,
  };
}

function setCourier(mode, position, bearing) {
  const { plane, originLng } = state.flight;
  plane.setLatLng([position.lat, alignLongitude(position.lng, originLng)]);
  const root = plane.getElement();
  if (!root) return;
  const rot = root.querySelector(".plane-rot");
  if (rot) rot.style.transform = `rotate(${bearing}deg)`;
  if (state.flight.shownMode !== mode) {
    state.flight.shownMode = mode;
    const glyph = root.querySelector(".courier-glyph");
    if (glyph) glyph.innerHTML = MODE_SVG[mode] || PLANE_SVG;
  }
}

function renderFlightHud(letter, progress, etaSeconds, loc) {
  setText("flight-route", routeLine(letter.from, letter.to));
  const legs = state.flight?.legs || letterLegs(letter);
  const bar = $("flight-bar");
  bar.style.width = `${progress * 100}%`;
  if (progress >= 1) {
    setText("flight-mode", "已送到");
    $("flight-mode").style.color = "";
    renderLegend("flight-legend", legs, legs.length - 1);
    setText("flight-eta", "已抵達");
    setText("flight-remain", pinLabel(letter.to));
    $("btn-open").hidden = false;
    $("flight-track").hidden = true;
  } else {
    const mode = loc?.mode || letter.mode;
    setText("flight-mode", MODE_NOW[mode] || "");
    $("flight-mode").style.color = MODE_COLOR[mode] || "";
    renderLegend("flight-legend", legs, loc ? loc.legIndex : letter.legIndex ?? 0);
    const secs = Math.ceil(etaSeconds);
    setText("flight-eta", secs <= 1 ? "即將抵達" : `${formatDuration(secs)}後抵達`);
    const remain = loc ? loc.remainingKm : letter.remainingKm;
    setText("flight-remain", `剩餘 ${formatDistance(remain)}`);
    $("btn-open").hidden = true;
    $("flight-track").hidden = false;
  }
}

function tripPosition(trip) {
  const start = Date.parse(trip.departedAt);
  const end = Date.parse(trip.arrivesAt);
  const span = Math.max(1, end - start) / 1000;
  let elapsed = (nowMs() - start) / 1000;
  if (trip.kind === "background") elapsed = ((elapsed % span) + span) % span;
  else elapsed = clamp(elapsed, 0, span);
  return locateOnLegs(trip.legs, elapsed);
}

function markerLatLng(position) {
  if (!state.mapUnwrap) return [position.lat, position.lng];
  return [position.lat, alignLongitude(position.lng, state.originLng)];
}

function paintTraffic() {
  if (!state.map || !state.dots) return;
  const seen = new Set();
  for (const trip of state.trips || []) {
    if (state.flight?.letter?.id === trip.id) continue;
    if (!trip.legs?.length) continue;
    seen.add(trip.id);
    const loc = tripPosition(trip);
    const latlng = markerLatLng(loc.position);
    let marker = state.dots.get(trip.id);
    if (!marker) {
      marker = L.marker(latlng, {
        icon: L.divIcon({
          className: "traffic-icon",
          html: `<span class="traffic-dot"></span>`,
          iconSize: [9, 9],
          iconAnchor: [4, 4],
        }),
        pane: "traffic",
        interactive: false,
      }).addTo(state.map);
      state.dots.set(trip.id, marker);
    } else {
      marker.setLatLng(latlng);
    }
  }
  for (const [id, marker] of state.dots) {
    if (!seen.has(id)) {
      marker.remove();
      state.dots.delete(id);
    }
  }
}

function ensureHomeMap() {
  if (state.map || state.view !== "home") return;
  const map = L.map($("home-map"), {
    zoomControl: false,
    attributionControl: true,
    worldCopyJump: true,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    touchZoom: false,
  });
  addTiles(map);
  const fit = () => {
    map.invalidateSize();
    map.fitWorld({ animate: false });
  };
  fit();
  requestAnimationFrame(fit);
  state.map = map;
  state.mapUnwrap = false;
  state.dots = new Map();
}

function startAmbient(token) {
  const step = () => {
    if (token !== renderToken) return;
    if (state.view !== "home" && state.view !== "draw") return;
    paintTraffic();
    state.raf = requestAnimationFrame(step);
  };
  state.raf = requestAnimationFrame(step);
}

function flightFrame(token) {
  const flight = state.flight;
  if (!flight || token !== renderToken) return;
  const { letter, legs } = flight;
  const start = Date.parse(letter.departedAt);
  const end = Date.parse(letter.arrivesAt);
  const span = Math.max(1, end - start) / 1000;
  const elapsed = clamp((nowMs() - start) / 1000, 0, span);
  const t = elapsed / span;
  const loc = paintFlown(flight.legPaths, flight.legFlown, legs, elapsed);
  const ahead = locateOnLegs(legs, Math.min(span, elapsed + span * 0.01));
  if (haversineKm(loc.position.lat, loc.position.lng, ahead.position.lat, ahead.position.lng) > 0.001) {
    flight.lastBearing = bearingDegrees(
      loc.position.lat,
      loc.position.lng,
      ahead.position.lat,
      ahead.position.lng,
    );
  }
  setCourier(loc.mode, loc.position, flight.lastBearing);
  renderFlightHud(letter, t, Math.max(0, (end - nowMs()) / 1000), loc);
  paintTraffic();
  if (t >= 1) {
    if (!flight.arrived) {
      flight.arrived = true;
      api(`/api/letters/${letter.id}`).catch(() => {});
    }
    return;
  }
  state.raf = requestAnimationFrame(() => flightFrame(token));
}

async function showFlight(id, token) {
  const letter = await api(`/api/letters/${id}`);
  if (token !== renderToken) return;
  if (letter.status === "draft") {
    navigate(`#/compose?draft=${id}`);
    return;
  }
  syncClock(letter.serverNow);
  showOnly("flight");
  $("btn-open").onclick = () => navigate(`#/read/${id}`);
  await loadActivity().catch(() => {});
  if (token !== renderToken) return;
  mountFlight(letter);
  const legs = letterLegs(letter);
  const elapsed = letter.departedAt
    ? clamp((nowMs() - Date.parse(letter.departedAt)) / 1000, 0, letter.durationSeconds || 1)
    : 0;
  const loc = locateOnLegs(legs, elapsed);
  renderFlightHud(letter, letter.progress, letter.etaSeconds || 0, loc);
  state.raf = requestAnimationFrame(() => flightFrame(token));
  state.poll = setInterval(async () => {
    if (state.view !== "flight" || token !== renderToken) return;
    try {
      const fresh = await api(`/api/letters/${id}`);
      syncClock(fresh.serverNow);
      if (state.flight) state.flight.letter = { ...state.flight.letter, ...fresh, from: fresh.from, to: fresh.to };
      await loadActivity();
    } catch {
      /* keep drawing from the last known schedule */
    }
  }, 8000);
}

async function showRead(id, token) {
  const letter = await api(`/api/letters/${id}`);
  if (token !== renderToken) return;
  if (letter.status === "draft") {
    navigate(`#/compose?draft=${id}`);
    return;
  }
  if (letter.status !== "delivered") {
    navigate(`#/flight/${id}`);
    return;
  }
  showOnly("read");
  const img = $("read-image");
  img.src = letter.imageUrl;
  img.alt = `寄給${pinLabel(letter.to)}的信`;
  const when = new Date(letter.deliveredAt || letter.arrivesAt);
  const stamp = when.toLocaleString("zh-TW", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const dest = letter.to.city || letter.to.name;
  const who = letter.to.city && letter.to.name !== letter.to.city ? `，給${letter.to.name}` : "";
  $("read-caption").textContent = `${letter.from.name}寄出 · ${stamp} 抵達${dest}${who}`;
}

function clearMap() {
  if (state.map) {
    state.map.remove();
    state.map = null;
  }
  state.dots = new Map();
}

function presentDraw(quote) {
  state.recipient = quote.to;
  state.fromId = quote.from.id;
  state.toId = quote.to.id;
  showOnly("draw");
  const legs = letterLegs(quote);
  setText("draw-name", quote.to.name);
  setText("draw-where", whereLine(quote.to));
  setText("draw-meta", `從${quote.from.name}寄出 · ${formatDistance(quote.distanceKm)} · 約 ${formatDuration(quote.durationSeconds)}`);
  setText("draw-via", legVia(legs));
  renderLegend("draw-legend", legs, -1);
  paintSenderChips();
  $("btn-write").disabled = quote.to.cityId === quote.from.id;
  clearMap();
  const view = mountRouteMap($("draw-map"), quote.from, quote.to, {
    legs,
    showPlane: false,
    padBottom: 300,
    badges: true,
  });
  state.map = view.map;
}

async function changeDrawSender(cityId) {
  if (!state.recipient || cityId === state.fromId) return;
  try {
    const quote = await api(`/api/route?fromId=${encodeURIComponent(cityId)}&toId=${encodeURIComponent(state.recipient.id)}`);
    const next = `#/draw?id=${encodeURIComponent(quote.to.id)}&from=${encodeURIComponent(quote.from.id)}`;
    if (location.hash !== next) history.replaceState(null, "", next);
    presentDraw(quote);
  } catch (err) {
    showToast(err.message);
    paintSenderChips();
  }
}

async function showDraw(params, token) {
  const fromId = params.get("from") || "taipei";
  if (!params.get("id")) {
    const payload = { fromId };
    if (params.get("exclude")) payload.excludeId = params.get("exclude");
    const draw = await api("/api/recipients/draw", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (token !== renderToken) return;
    const next = `#/draw?id=${encodeURIComponent(draw.to.id)}&from=${encodeURIComponent(draw.from.id)}`;
    if (location.hash !== next) location.replace(next);
    return;
  }
  const quote = await api(`/api/route?fromId=${encodeURIComponent(fromId)}&toId=${encodeURIComponent(params.get("id"))}`);
  if (token !== renderToken) return;
  await loadActivity().catch(() => {});
  if (token !== renderToken) return;
  presentDraw(quote);
  startAmbient(token);
}

async function redrawRecipient() {
  const excludeId = state.recipient?.id;
  const fromId = state.fromId || "taipei";
  const payload = { fromId };
  if (excludeId) payload.excludeId = excludeId;
  const draw = await api("/api/recipients/draw", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const next = `#/draw?id=${encodeURIComponent(draw.to.id)}&from=${encodeURIComponent(draw.from.id)}`;
  if (location.hash === next) presentDraw(draw);
  else location.replace(next);
}

async function render() {
  const token = ++renderToken;
  stopLoops();
  const { parts, params } = parseHash();
  try {
    if (parts[0] === "compose") {
      await openCompose(params, token);
    } else if (parts[0] === "draw") {
      await showDraw(params, token);
    } else if (parts[0] === "flight" && parts[1]) {
      await showFlight(parts[1], token);
    } else if (parts[0] === "read" && parts[1]) {
      await showRead(parts[1], token);
    } else {
      showOnly("home");
      await refreshHome();
      if (token !== renderToken) return;
      startAmbient(token);
      state.poll = setInterval(() => {
        refreshHome().catch(() => {});
      }, 3000);
    }
  } catch (err) {
    if (token !== renderToken) return;
    showToast(err.message);
    if (state.view !== "home") {
      showOnly("home");
      refreshHome().catch(() => {});
    }
  }
}

function boot() {
  buildPlaceChips();
  buildPresets();
  bindCanvas();
  $("btn-draw").addEventListener("click", () => navigate("#/draw"));
  $("btn-redraw").addEventListener("click", () => {
    redrawRecipient().catch((err) => showToast(err.message));
  });
  $("btn-write").addEventListener("click", () => {
    if (!state.recipient) return;
    navigate(`#/compose?from=${encodeURIComponent(state.fromId)}&to=${encodeURIComponent(state.recipient.id)}`);
  });
  $("btn-change-recipient").addEventListener("click", () => {
    if (!state.recipient) return;
    navigate(`#/draw?from=${encodeURIComponent(state.fromId)}&exclude=${encodeURIComponent(state.recipient.id)}`);
  });
  $("compose-back").addEventListener("click", () => navigate("#/"));
  $("draw-back").addEventListener("click", () => navigate("#/"));
  $("flight-back").addEventListener("click", () => navigate("#/"));
  $("read-back").addEventListener("click", () => navigate("#/"));
  $("btn-throw").addEventListener("click", () => submitLetter(true));
  $("btn-save").addEventListener("click", () => submitLetter(false));
  $("btn-undo").addEventListener("click", undoStroke);
  $("btn-clear").addEventListener("click", clearCanvas);
  $("btn-upload").addEventListener("click", () => $("file-input").click());
  $("file-input").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    drawUpload(file);
  });
  $("pace-fast").addEventListener("click", () => setPace("playable-fast"));
  $("pace-slow").addEventListener("click", () => setPace("romantic-slow"));
  window.addEventListener("hashchange", () => {
    render().catch((err) => showToast(err.message));
  });
  if (!location.hash) location.replace("#/");
  else render().catch((err) => showToast(err.message));
}

boot();
