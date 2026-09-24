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
import { MODE_COLOR, MODE_LABEL, legProgressLine, legVia, planCourier, transferBeat } from "/shared/route.js";

const PAPER = "#fffdf8";
const INK = "#2a4a8a";
const PLANE_SVG = `
<svg viewBox="0 0 64 64" width="42" height="42" aria-hidden="true">
  <path d="M32 3 C34.2 3 36 8 36 14 L36 26 L58 34 L58 39 L36 35 L36 48 L46 56 L46 60 L32 55 L18 60 L18 56 L28 48 L28 35 L6 39 L6 34 L28 26 L28 14 C28 8 29.8 3 32 3 Z" fill="#f3eadc" stroke="#3c342c" stroke-width="1.35" stroke-linejoin="round"/>
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
  postLetterId: null,
  postTimers: [],
  ceremonyTimer: 0,
  ceremonySkip: false,
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
  if (state.ceremonyTimer) clearTimeout(state.ceremonyTimer);
  state.ceremonyTimer = 0;
  const flight = state.flight;
  if (flight) {
    for (const id of flight.cameraTimers || []) clearTimeout(id);
    if (flight.transferTimer) clearTimeout(flight.transferTimer);
    if (flight.glanceTimer) clearTimeout(flight.glanceTimer);
  }
  hideTransfer();
  if (state.map) {
    state.map.remove();
    state.map = null;
  }
  state.dots = new Map();
  state.mapUnwrap = false;
  state.flight = null;
}

function cancelPost() {
  for (const id of state.postTimers) clearTimeout(id);
  state.postTimers = [];
  state.postLetterId = null;
  const stage = $("post-stage");
  if (!stage) return;
  stage.hidden = true;
  stage.classList.remove("is-playing", "is-fading");
  $("post-letter").removeAttribute("src");
}

function finishPost() {
  state.postTimers = [];
  state.postLetterId = null;
  const stage = $("post-stage");
  stage.hidden = true;
  stage.classList.remove("is-playing", "is-fading");
  $("post-letter").removeAttribute("src");
}

function alignIntoSlot() {
  const stage = $("post-stage");
  const letter = stage.querySelector(".post-letter-slot");
  const slot = stage.querySelector(".postbox-slot");
  if (!letter || !slot) return;
  const letterBox = letter.getBoundingClientRect();
  const slotBox = slot.getBoundingClientRect();
  const dy = slotBox.top + slotBox.height * 0.45 - letterBox.top;
  stage.style.setProperty("--into-slot", `${Math.max(80, Math.round(dy))}px`);
}

function playPost(letterId, imageUrl) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    navigate(`#/flight/${letterId}`);
    return;
  }
  state.postLetterId = letterId;
  const stage = $("post-stage");
  const img = $("post-letter");
  img.alt = "";
  stage.hidden = false;
  stage.classList.remove("is-playing", "is-fading");
  let started = false;
  const start = () => {
    if (started || state.postLetterId !== letterId) return;
    started = true;
    void stage.offsetWidth;
    alignIntoSlot();
    stage.classList.add("is-playing");
    state.postTimers = [
      setTimeout(() => {
        if (state.postLetterId !== letterId) return;
        navigate(`#/flight/${letterId}?intro=1`);
      }, 1760),
      setTimeout(() => {
        if (state.postLetterId !== letterId) return;
        stage.classList.add("is-fading");
      }, 2140),
      setTimeout(() => {
        if (state.postLetterId !== letterId) return;
        finishPost();
      }, 3080),
    ];
  };
  img.onload = start;
  img.src = imageUrl;
  if (img.complete) start();
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
    root.innerHTML = `<p class="empty">還沒有信。抽一位收件人，或用下面的固定路線試寄。</p>`;
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
        const index = letter.legIndex ?? 0;
        const legs = letter.legs?.length ? letter.legs : null;
        const story = legs
          ? legProgressLine(legs[index] || legs[0], { index, count: legs.length })
          : (MODE_LABEL[letter.mode] || "");
        const mode = story ? `${esc(story)} · ` : "";
        detail = `${mode}剩餘 ${esc(formatDistance(letter.remainingKm))} · ${esc(formatDuration(letter.etaSeconds))}後抵達`;
        extra = `<span class="mini-track"><span style="width:${Math.round(letter.progress * 100)}%"></span></span>`;
      } else if (letter.status === "delivered") {
        detail = "已抵達 · 拆信";
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
  $("btn-send").disabled = true;
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
      letter = await api(`/api/letters/${state.draftId}/send`, {
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
    if (launch) playPost(letter.id, body.imageDataUrl);
    else navigate("#/");
  } catch (err) {
    showToast(err.message);
  } finally {
    state.submitting = false;
    $("btn-send").disabled = false;
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
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
}

function mountRouteMap(container, from, to, { legs, showPlane = false, padBottom = 196, badges = false, intro = false } = {}) {
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
  const bounds = L.latLngBounds(all);
  const fit = () => {
    map.invalidateSize();
    map.fitBounds(bounds, {
      paddingTopLeft: [36, 72],
      paddingBottomRight: [36, padBottom],
      animate: false,
    });
  };
  if (intro) {
    map.setView([origin.lat, origin.lng], 12, { animate: false });
    requestAnimationFrame(() => {
      if (container.__map === map) map.invalidateSize();
    });
  } else {
    fit();
    requestAnimationFrame(fit);
  }
  const first = legPaths[0];
  const followPoint = first[Math.min(first.length - 1, Math.max(1, Math.round((first.length - 1) * 0.45)))];
  state.mapUnwrap = true;
  state.originLng = origin.lng;
  state.dots = new Map();
  container.__map = map;
  return {
    map,
    legPaths,
    legFlown,
    plane,
    legs: routeLegs,
    originLng: origin.lng,
    bounds,
    originPoint: origin,
    followPoint,
    padBottom,
  };
}

function playDepartureCamera(map, origin, follow, bounds, padBottom) {
  const timers = [];
  const alive = () => state.map === map;
  const later = (delay, fn) => {
    timers.push(setTimeout(fn, delay));
  };
  later(280, () => {
    if (!alive()) return;
    map.invalidateSize();
    map.flyTo([follow.lat, follow.lng], 9.5, { duration: 1.55, easeLinearity: 0.12 });
  });
  later(1980, () => {
    if (!alive()) return;
    map.flyToBounds(bounds, {
      paddingTopLeft: [36, 72],
      paddingBottomRight: [36, padBottom],
      duration: 1.5,
      easeLinearity: 0.12,
    });
  });
  return timers;
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

function mountFlight(letter, { intro = false } = {}) {
  const legs = letterLegs(letter);
  const view = mountRouteMap($("map"), letter.from, letter.to, {
    legs,
    showPlane: true,
    padBottom: 250,
    intro,
  });
  state.map = view.map;
  const cameraTimers = intro
    ? playDepartureCamera(view.map, view.originPoint, view.followPoint, view.bounds, view.padBottom)
    : [];
  state.flight = {
    letter,
    legs,
    legPaths: view.legPaths,
    legFlown: view.legFlown,
    plane: view.plane,
    originLng: view.originLng,
    shownMode: legs[0].mode,
    lastBearing: bearingDegrees(legs[0].from.lat, legs[0].from.lng, legs[0].to.lat, legs[0].to.lng),
    arrived: letter.status === "delivered",
    seenLeg: null,
    cameraTimers,
    introUntil: intro ? Date.now() + 4300 : 0,
    transferTimer: 0,
    glanceTimer: 0,
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
    const index = loc ? loc.legIndex : (letter.legIndex ?? 0);
    const leg = legs[index] || legs[0];
    setText("flight-mode", legProgressLine(leg, { index, count: legs.length }));
    $("flight-mode").style.color = "";
    renderLegend("flight-legend", legs, index);
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
  noteLegChange(loc);
  renderFlightHud(letter, t, Math.max(0, (end - nowMs()) / 1000), loc);
  paintTraffic();
  if (t >= 1) {
    if (!flight.arrived) {
      flight.arrived = true;
      hideTransfer();
      api(`/api/letters/${letter.id}`).catch(() => {});
    }
    return;
  }
  state.raf = requestAnimationFrame(() => flightFrame(token));
}

function hideTransfer() {
  const banner = $("transfer-banner");
  if (!banner) return;
  banner.hidden = true;
  banner.classList.remove("is-on");
}

function presentTransfer(beat, hubPoint) {
  const flight = state.flight;
  if (!flight || !beat) return;
  const banner = $("transfer-banner");
  $("transfer-kicker").textContent = beat.hub;
  $("transfer-title").textContent = beat.title;
  $("transfer-mark").textContent = MODE_LABEL[beat.mode] || "";
  banner.hidden = false;
  banner.classList.remove("is-on");
  void banner.offsetWidth;
  banner.classList.add("is-on");
  if (flight.transferTimer) clearTimeout(flight.transferTimer);
  flight.transferTimer = setTimeout(() => {
    banner.hidden = true;
    banner.classList.remove("is-on");
  }, 3400);
  const root = flight.plane?.getElement();
  if (root) {
    root.classList.add("is-transfer");
    setTimeout(() => root.classList.remove("is-transfer"), 900);
  }
  glanceAtHub(hubPoint);
}

function glanceAtHub(point) {
  const flight = state.flight;
  const map = state.map;
  if (!map || !flight || !point) return;
  if (flight.introUntil && Date.now() < flight.introUntil) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (flight.glanceTimer) clearTimeout(flight.glanceTimer);
  const zoom = map.getZoom();
  const center = map.getCenter();
  const back = [center.lat, center.lng];
  const nextZoom = Math.min(9, Math.max(zoom + 1.6, 7));
  map.flyTo([point.lat, alignLongitude(point.lng, flight.originLng)], nextZoom, { duration: 0.7 });
  flight.glanceTimer = setTimeout(() => {
    if (state.map !== map) return;
    map.flyTo(back, zoom, { duration: 0.85 });
  }, 1700);
}

function noteLegChange(loc) {
  const flight = state.flight;
  if (!flight || loc.legIndex == null) return;
  if (flight.seenLeg == null) {
    flight.seenLeg = loc.legIndex;
    return;
  }
  if (loc.legIndex <= flight.seenLeg) return;
  flight.seenLeg = loc.legIndex;
  const prev = flight.legs[loc.legIndex - 1];
  const next = flight.legs[loc.legIndex];
  const beat = transferBeat(prev, next);
  if (beat) presentTransfer(beat, next.from);
}

async function showFlight(id, token, params) {
  const letter = await api(`/api/letters/${id}`);
  if (token !== renderToken) return;
  if (letter.status === "draft") {
    navigate(`#/compose?draft=${id}`);
    return;
  }
  syncClock(letter.serverNow);
  const intro = params?.get("intro") === "1" && letter.status !== "delivered";
  showOnly("flight");
  $("btn-open").onclick = () => navigate(`#/read/${id}`);
  mountFlight(letter, { intro });
  if (intro) history.replaceState(null, "", `#/flight/${id}`);
  const legs = letterLegs(letter);
  const elapsed = letter.departedAt
    ? clamp((nowMs() - Date.parse(letter.departedAt)) / 1000, 0, letter.durationSeconds || 1)
    : 0;
  const loc = locateOnLegs(legs, elapsed);
  if (state.flight) state.flight.seenLeg = loc.legIndex;
  renderFlightHud(letter, letter.progress, letter.etaSeconds || 0, loc);
  state.raf = requestAnimationFrame(() => flightFrame(token));
  loadActivity().catch(() => {});
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
  const ceremony = $("ceremony");
  ceremony.classList.remove("is-playing", "is-open");
  state.ceremonySkip = false;
  const img = $("read-image");
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
  $("postmark-place").textContent = dest;
  $("postmark-time").textContent = when.toLocaleDateString("zh-TW", { month: "numeric", day: "numeric" });
  fillAftertaste(letter);
  let started = false;
  const go = () => {
    if (started || token !== renderToken) return;
    started = true;
    startCeremony();
  };
  img.onload = go;
  img.onerror = () => {
    if (token !== renderToken) return;
    showToast("信面還打不開");
    go();
  };
  if (!letter.imageUrl) {
    showToast("信面還打不開");
    startCeremony();
    return;
  }
  img.src = `${letter.imageUrl}?open=1`;
  if (img.complete) go();
}

function countWord(n) {
  return ["零", "一", "兩", "三", "四", "五", "六", "七", "八", "九"][n] || String(n);
}

function fillAftertaste(letter) {
  const legs = letterLegs(letter);
  const seconds = Number(letter.durationSeconds) || 0;
  const names = legs.map((leg) => MODE_LABEL[leg.mode] || "").filter(Boolean);
  const sequence = names.join("、");
  const transfers = Math.max(0, names.length - 1);
  const km = formatDistance(letter.distanceKm);
  const detail = transfers === 0
    ? `${km}，${sequence}一段，沒有轉運。`
    : `${km}，中途轉了${countWord(transfers)}次：${sequence}。`;
  $("read-after").innerHTML =
    `<p class="after-warm">這封信在路上 <b>${esc(formatDuration(seconds))}</b>。</p>` +
    `<p>${esc(detail)}</p>`;
}

function settleCeremony() {
  if (state.ceremonyTimer) clearTimeout(state.ceremonyTimer);
  state.ceremonyTimer = 0;
  const root = $("ceremony");
  root.classList.remove("is-playing");
  root.classList.add("is-open");
}

function startCeremony() {
  const root = $("ceremony");
  if (state.ceremonySkip || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    settleCeremony();
    return;
  }
  root.classList.remove("is-open");
  void root.offsetWidth;
  root.classList.add("is-playing");
  state.ceremonyTimer = setTimeout(settleCeremony, 2680);
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
  const { parts, params } = parseHash();
  const keepPost = state.postLetterId && parts[0] === "flight" && parts[1] === state.postLetterId;
  if (!keepPost) cancelPost();
  stopLoops();
  try {
    if (parts[0] === "compose") {
      await openCompose(params, token);
    } else if (parts[0] === "draw") {
      await showDraw(params, token);
    } else if (parts[0] === "flight" && parts[1]) {
      await showFlight(parts[1], token, params);
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
  $("ceremony-skip").addEventListener("click", () => {
    state.ceremonySkip = true;
    settleCeremony();
  });
  $("btn-send").addEventListener("click", () => submitLetter(true));
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
