import {
  bearingDegrees,
  flightDurationSeconds,
  haversineKm,
  interpolate,
} from "/shared/flight.js";
import { PLACES, findPlace, findPreset } from "/shared/places.js";

const PAPER = "#fffdf8";
const INK = "#2a4a8a";
const PLANE_SVG = `
<svg viewBox="0 0 64 64" width="42" height="42" aria-hidden="true">
  <path d="M32 6 L56 52 L32 42 L8 52 Z" fill="#fffefb" stroke="#1d2a3a" stroke-width="1.7" stroke-linejoin="round"/>
  <path d="M32 16 L32 42" stroke="#1d2a3a" stroke-width="1.1" opacity="0.35"/>
</svg>`;

const state = {
  view: "home",
  fromId: "taipei",
  toId: "kaohsiung",
  pace: "playable-fast",
  draftId: null,
  ctx: null,
  cssW: 0,
  cssH: 0,
  dpr: 1,
  undo: [],
  map: null,
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
  if (minutes > 0) return secs > 0 ? `${minutes} 分 ${secs} 秒` : `${minutes} 分`;
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
  for (const id of ["home", "compose", "flight", "read"]) {
    $(`view-${id}`).hidden = id !== name;
  }
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
    root.innerHTML = `<p class="empty">還沒有信。挑一條示範路線，或自己寫一封。</p>`;
    return;
  }
  const html = groups.map((group) => {
    let items = letters.filter((letter) => letter.status === group.key);
    if (!items.length) return "";
    if (group.key === "in_flight") {
      items = items.slice().sort((a, b) => a.etaSeconds - b.etaSeconds);
    }
    const cards = items.map((letter) => {
      const route = `${esc(letter.from.name)} → ${esc(letter.to.name)}`;
      let detail = "草稿";
      let extra = "";
      if (letter.status === "in_flight") {
        detail = `剩餘 ${esc(formatDistance(letter.remainingKm))} · ${esc(formatDuration(letter.etaSeconds))}後抵達`;
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

async function refreshHome() {
  const letters = await api("/api/letters");
  if (state.view !== "home") return;
  renderHomeList(letters);
}

function buildPresets() {
  const root = $("preset-list");
  for (const preset of ["tpe-khh", "tpe-tyo", "tpe-101"].map(findPreset)) {
    const from = findPlace(preset.from);
    const to = findPlace(preset.to);
    const km = haversineKm(from.lat, from.lng, to.lat, to.lng);
    const seconds = flightDurationSeconds(km, "playable-fast");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "preset";
    button.innerHTML = `<span><b>${esc(preset.label)}</b><small>${esc(preset.note)} · ${esc(formatDistance(km))}</small></span><span class="preset-time">約 ${esc(formatDuration(seconds))}</span>`;
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

function updateEstimate() {
  const box = $("estimate");
  const from = findPlace(state.fromId);
  const to = findPlace(state.toId);
  if (!from || !to || from.id === to.id) {
    box.className = "estimate warn";
    box.textContent = "請選擇不同的寄出地與收件地";
    return;
  }
  const km = haversineKm(from.lat, from.lng, to.lat, to.lng);
  const seconds = flightDurationSeconds(km, state.pace);
  box.className = "estimate";
  box.innerHTML = `<strong>${esc(formatDistance(km))}</strong><span>約 ${esc(formatDuration(seconds))}</span>`;
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
  state.pace = "playable-fast";
  const preset = findPreset(params.get("preset") || "");
  if (preset) {
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
    if (letter.imageUrl) {
      const img = await loadImage(letter.imageUrl);
      paintContained(img);
    }
  }
  paintChips();
  setPace(state.pace);
}

async function submitLetter(launch) {
  if (state.submitting) return;
  const from = findPlace(state.fromId);
  const to = findPlace(state.toId);
  if (!from || !to || from.id === to.id) {
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
      toId: to.id,
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

function mountFlight(letter) {
  const path = [];
  const steps = 72;
  for (let i = 0; i <= steps; i += 1) {
    path.push(interpolate(letter.from.lat, letter.from.lng, letter.to.lat, letter.to.lng, i / steps));
  }
  const map = L.map($("map"), {
    zoomControl: true,
    attributionControl: true,
  });
  map.createPane("plane");
  map.getPane("plane").style.zIndex = 640;
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    subdomains: "abcd",
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap &copy; CARTO",
  }).addTo(map);

  const latLngs = path.map((point) => [point.lat, point.lng]);
  L.polyline(latLngs, {
    color: "#8aa0b8",
    weight: 2,
    opacity: 0.9,
    dashArray: "1 9",
    lineCap: "round",
  }).addTo(map);
  const flown = L.polyline([], {
    color: "#243e68",
    weight: 2.5,
    opacity: 0.9,
  }).addTo(map);

  const dot = (kind) => L.divIcon({
    className: "dot-icon",
    html: `<span class="dot dot-${kind}"></span>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  });
  L.marker([letter.from.lat, letter.from.lng], { icon: dot("origin"), interactive: false })
    .bindTooltip(letter.from.name, { permanent: true, direction: "left", className: "city-label", offset: [-8, 0] })
    .addTo(map);
  L.marker([letter.to.lat, letter.to.lng], { icon: dot("dest"), interactive: false })
    .bindTooltip(letter.to.name, { permanent: true, direction: "right", className: "city-label", offset: [8, 0] })
    .addTo(map);

  const plane = L.marker([letter.from.lat, letter.from.lng], {
    icon: L.divIcon({
      className: "plane-wrap",
      html: `<div class="plane-rot">${PLANE_SVG}</div>`,
      iconSize: [42, 42],
      iconAnchor: [21, 21],
    }),
    pane: "plane",
    interactive: false,
    zIndexOffset: 800,
  }).addTo(map);

  const fit = () => {
    map.invalidateSize();
    map.fitBounds(latLngs, {
      paddingTopLeft: [36, 72],
      paddingBottomRight: [36, 196],
      animate: false,
    });
  };
  fit();

  state.map = map;
  state.flight = { letter, path, flown, plane, lastBearing: bearingDegrees(letter.from.lat, letter.from.lng, letter.to.lat, letter.to.lng), arrived: false, lastTrail: 0 };

  requestAnimationFrame(fit);
}

function updatePlane(position, bearing) {
  const { plane } = state.flight;
  plane.setLatLng([position.lat, position.lng]);
  const el = plane.getElement()?.querySelector(".plane-rot");
  if (el) el.style.transform = `rotate(${bearing}deg)`;
}

function renderFlightHud(letter, progress, etaSeconds) {
  setText("flight-route", `${letter.from.name} → ${letter.to.name}`);
  const bar = $("flight-bar");
  bar.style.width = `${progress * 100}%`;
  if (progress >= 1) {
    setText("flight-eta", "已抵達");
    setText("flight-remain", letter.to.name);
    $("btn-open").hidden = false;
    $("flight-track").hidden = true;
  } else {
    const secs = Math.ceil(etaSeconds);
    setText("flight-eta", secs <= 1 ? "即將抵達" : `${formatDuration(secs)}後抵達`);
    setText("flight-remain", `剩餘 ${formatDistance(letter.distanceKm * (1 - progress))}`);
    $("btn-open").hidden = true;
    $("flight-track").hidden = false;
  }
}

function flightFrame(token) {
  const flight = state.flight;
  if (!flight || token !== renderToken) return;
  const { letter } = flight;
  const start = Date.parse(letter.departedAt);
  const end = Date.parse(letter.arrivesAt);
  const t = clamp((nowMs() - start) / Math.max(1, end - start), 0, 1);
  const pos = interpolate(letter.from.lat, letter.from.lng, letter.to.lat, letter.to.lng, t);
  const look = Math.min(1, t + 0.012);
  if (look - t > 1e-4) {
    const ahead = interpolate(letter.from.lat, letter.from.lng, letter.to.lat, letter.to.lng, look);
    if (haversineKm(pos.lat, pos.lng, ahead.lat, ahead.lng) > 0.001) {
      flight.lastBearing = bearingDegrees(pos.lat, pos.lng, ahead.lat, ahead.lng);
    }
  }
  updatePlane(pos, flight.lastBearing);
  const stamp = performance.now();
  if (stamp - flight.lastTrail > 180) {
    const index = Math.round(t * (flight.path.length - 1));
    flight.flown.setLatLngs(flight.path.slice(0, index + 1).map((point) => [point.lat, point.lng]));
    flight.lastTrail = stamp;
  }
  renderFlightHud(letter, t, Math.max(0, (end - nowMs()) / 1000));
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
  mountFlight(letter);
  renderFlightHud(letter, letter.progress, letter.etaSeconds || 0);
  state.raf = requestAnimationFrame(() => flightFrame(token));
  state.poll = setInterval(async () => {
    if (state.view !== "flight" || token !== renderToken) return;
    try {
      const fresh = await api(`/api/letters/${id}`);
      syncClock(fresh.serverNow);
      if (state.flight) state.flight.letter = { ...state.flight.letter, ...fresh, from: fresh.from, to: fresh.to };
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
  img.alt = `寄給${letter.to.name}的信`;
  const when = new Date(letter.deliveredAt || letter.arrivesAt);
  const stamp = when.toLocaleString("zh-TW", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  $("read-caption").textContent = `${letter.from.name}寄出 · ${stamp} 抵達${letter.to.name}`;
}

async function render() {
  const token = ++renderToken;
  stopLoops();
  const { parts, params } = parseHash();
  try {
    if (parts[0] === "compose") {
      await openCompose(params, token);
    } else if (parts[0] === "flight" && parts[1]) {
      await showFlight(parts[1], token);
    } else if (parts[0] === "read" && parts[1]) {
      await showRead(parts[1], token);
    } else {
      showOnly("home");
      await refreshHome();
      if (token !== renderToken) return;
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
  $("btn-new").addEventListener("click", () => navigate("#/compose?preset=tpe-khh"));
  $("compose-back").addEventListener("click", () => navigate("#/"));
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
