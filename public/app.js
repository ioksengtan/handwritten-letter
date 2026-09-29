import {
  DEFAULT_PACE,
  PACES,
  alignLongitude,
  bearingDegrees,
  haversineKm,
  interpolate,
  samplePath,
  unwrapLongitudes,
} from "/shared/flight.js";
import { findPlace } from "/shared/places.js";
import { CITIES, findCity, findRecipient } from "/shared/recipients.js";
import {
  SENDER_PROFILE_KEY,
  normalizeSenderId,
  parseSenderProfile,
  serializeSenderProfile,
} from "/shared/profile.js";
import { quotaSnapshot, quotaWaitMessage, remainingLabel } from "/shared/quota.js";
import { POST_IRREVOCABLE } from "/shared/slip.js";
import { planCourier } from "/shared/route.js";
import { formatArrival, formatCountdown, formatPostalDate, formatPostalStamp, formatSpan } from "/shared/clock.js";

const PAPER = "#fffdf8";
const INK = "#2a4a8a";
const PIGEON_INK = "#6e342e";
const PIGEON_SHAPES = `
  <path fill="none" stroke-width="2.6" stroke-linecap="round" d="M18 34c2-3 6-2 7 1M22 18c3-2 7 0 6 3M92 16c3 1 5 4 3 6M100 36c1 3-1 6-4 5M96 62c-3 2-7 1-8-2M34 68c-4 1-7-2-6-5M12 54c-2 2-5 1-6-2"/>
  <path fill="none" stroke-width="1.6" stroke-linecap="round" d="M30 22c4-1 8 1 9 4M78 18c4 2 7 5 5 8M36 60c5 2 10 0 12-3"/>
  <path d="M24 46 8 38 16 48 5 55 20 51Z"/>
  <ellipse cx="46" cy="48" rx="22" ry="11" transform="rotate(-14 46 48)"/>
  <path d="M38 44C42 20 68 12 86 26 68 28 54 38 48 46Z"/>
  <circle cx="68" cy="38" r="10"/>
  <path d="M74 37 92 40 74 44Z"/>
  <circle cx="14" cy="24" r="1.1"/>
  <circle cx="102" cy="22" r="0.9"/>
  <circle cx="16" cy="64" r="1"/>
  <circle cx="98" cy="66" r="1.15"/>
  <circle cx="54" cy="8" r="0.7"/>`;

function pigeonSvg(id) {
  return `
<svg viewBox="0 0 110 78" width="96" height="68" aria-hidden="true">
  <defs>
    <mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="110" height="78">
      <rect width="110" height="78" fill="#000"/>
      <g fill="#fff" stroke="#fff">${PIGEON_SHAPES}</g>
      <path fill="#000" stroke="none" d="M42 22c7 1 9 9 2 11-7 1-10-7-2-11z"/>
      <path fill="#000" stroke="none" d="M34 44c6 .4 8 6 2 7-6 .4-9-4-2-7z"/>
      <circle cx="58" cy="30" r="2.4" fill="#000" stroke="none"/>
      <circle cx="72" cy="36" r="1.6" fill="#000" stroke="none"/>
    </mask>
  </defs>
  <g fill="${PIGEON_INK}" stroke="${PIGEON_INK}" mask="url(#${id})">${PIGEON_SHAPES}</g>
</svg>`;
}

const state = {
  view: "home",
  fromId: null,
  originId: null,
  senderId: null,
  letters: [],
  quota: null,
  regionDraft: null,
  regionMode: "register",
  regionMap: null,
  regionMarkers: new Map(),
  afterRegion: null,
  toId: null,
  recipient: null,
  legacyTo: null,
  mode: "recipient",
  pace: DEFAULT_PACE,
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

const PACE_HINT = {
  "romantic-slow": "像真正的國際信件。同城約一天，國內兩三天，鄰近區域約四五天到一週，跨洲要一到兩週。",
  "playable-fast": "測試用。同一封信可以在一分鐘內看完寄出、在路上、拆信。",
};

function rememberPace(pace) {
  try {
    sessionStorage.setItem("on-the-way-pace", pace);
  } catch {
    /* private mode */
  }
}

function recallPace() {
  try {
    return sessionStorage.getItem("on-the-way-pace");
  } catch {
    return null;
  }
}

const REGISTER_LEDE = "第一次來，請先選定你的地區。之後每封信都從這裡寄出，像信封上的回郵地址。這台瀏覽器會記住。還沒有帳號；以後若有帳號，這份地區會跟著帳號走。";
const SETTINGS_LEDE = "這是以後每封信的寄出地，不是這一封信的選項。已經寄出的信不會改。以後若有帳號，這份地區會跟著帳號走。";

function readSenderProfile() {
  let raw = null;
  try {
    raw = localStorage.getItem(SENDER_PROFILE_KEY);
  } catch {
    return null;
  }
  const profile = parseSenderProfile(raw);
  if (!profile || !findCity(profile.originId)) return null;
  let senderId = profile.senderId;
  if (!senderId) {
    senderId = normalizeSenderId(crypto.randomUUID());
    try {
      localStorage.setItem(SENDER_PROFILE_KEY, serializeSenderProfile(profile.originId, senderId));
    } catch {
      /* private mode */
    }
  }
  return { originId: profile.originId, senderId };
}

function writeOriginId(id) {
  const senderId = state.senderId || normalizeSenderId(crypto.randomUUID());
  try {
    localStorage.setItem(SENDER_PROFILE_KEY, serializeSenderProfile(id, senderId));
  } catch {
    /* private mode */
  }
  state.originId = id;
  state.senderId = senderId;
  state.fromId = id;
  paintRegionLink();
}

function originLabel(point) {
  if (!point) return "";
  const place = point.city || point.name;
  if (point.country && point.country !== place) return `${place} · ${point.country}`;
  return place;
}

function paintRegionLink() {
  const button = $("btn-region");
  const city = findCity(state.originId);
  if (!button) return;
  if (!city) {
    button.hidden = true;
    return;
  }
  button.hidden = false;
  button.textContent = `地區 · ${city.name}`;
  button.setAttribute("aria-label", `我的地區，目前是${city.name}。這不是寄信時的選項。`);
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
  if (!res.ok) {
    const error = new Error(data?.error || "連線失敗");
    error.payload = data;
    throw error;
  }
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
  for (const id of ["home", "region", "compose", "draw", "flight", "read"]) {
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
  }
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
    root.innerHTML = `<p class="empty">還沒有信。抽一位收件人，寄到對方住的城市。</p>`;
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
        const when = formatArrival(letter.arrivesAt);
        const due = when ? ` · 預計 ${esc(when)}` : "";
        detail = `信鴿在飛 · 剩餘 ${esc(formatDistance(letter.remainingKm))} · ${esc(formatCountdown(letter.etaSeconds))}${due}`;
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

function paintMailQuota(letters) {
  const quota = quotaSnapshot(letters || [], state.senderId);
  state.quota = quota;
  const arrival = quota.soonestArrivesAt ? formatArrival(quota.soonestArrivesAt) : "";
  const wait = quota.full ? quotaWaitMessage(arrival) : "";
  const slots = Array.from({ length: quota.limit }, (_, index) => {
    const used = index < quota.inFlight;
    return `<li class="stamp-slot${used ? " is-used" : ""}">${used ? "<span>郵</span>" : ""}</li>`;
  }).join("");
  const html = `<p class="quota-label">${esc(remainingLabel(quota.remaining))}</p><ol class="stamp-slots" aria-hidden="true">${slots}</ol>${wait ? `<p class="quota-wait">${esc(wait)}</p>` : ""}`;
  for (const id of ["home-quota", "compose-quota"]) {
    const root = $(id);
    if (!root) continue;
    root.classList.toggle("is-full", quota.full);
    root.innerHTML = html;
    root.setAttribute("aria-label", wait ? `${remainingLabel(quota.remaining)}。${wait}` : remainingLabel(quota.remaining));
  }
  const send = $("btn-send");
  if (send && !state.submitting) send.disabled = quota.full;
  const confirm = $("btn-slip-confirm");
  if (confirm && !state.submitting) confirm.disabled = quota.full;
}

async function refreshQuota() {
  const letters = await api("/api/letters");
  state.letters = letters;
  paintMailQuota(letters);
  return letters;
}

async function refreshHome() {
  const [letters] = await Promise.all([refreshQuota(), loadActivity()]);
  if (state.view !== "home") return;
  renderHomeList(letters);
  ensureHomeMap();
}

const CONTINENTS = ["亞洲", "歐洲", "非洲", "美洲", "大洋洲"];

function buildRegionList() {
  const root = $("region-list");
  root.replaceChildren();
  for (const continent of CONTINENTS) {
    const cities = CITIES.filter((city) => city.continent === continent);
    if (!cities.length) continue;
    const section = document.createElement("section");
    section.className = "region-group";
    const heading = document.createElement("h2");
    heading.textContent = continent;
    const row = document.createElement("div");
    row.className = "region-cities";
    for (const city of cities) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chip";
      button.dataset.id = city.id;
      button.textContent = city.name;
      button.addEventListener("click", () => selectRegionCity(city.id));
      row.append(button);
    }
    section.append(heading, row);
    root.append(section);
  }
}

function paintRegionChoices() {
  const city = findCity(state.regionDraft);
  setText(
    "region-picked",
    city ? `${city.name} · ${city.country}` : "在地圖上點一個城市，或從下面的名單選。",
  );
  $("btn-region-save").disabled = !city;
  for (const button of $("region-list").querySelectorAll("button")) {
    const selected = button.dataset.id === state.regionDraft;
    button.setAttribute("aria-pressed", selected ? "true" : "false");
    if (selected) button.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  for (const [id, marker] of state.regionMarkers) {
    const el = marker.getElement();
    if (el) el.classList.toggle("is-picked", id === state.regionDraft);
  }
}

function selectRegionCity(id, { fly = true } = {}) {
  if (!findCity(id)) return;
  state.regionDraft = id;
  paintRegionChoices();
  const city = findCity(id);
  if (fly && state.regionMap && city) {
    state.regionMap.flyTo([city.lat, city.lng], 4, { duration: 0.6 });
  }
}

function nearestCity(lat, lng) {
  let best = CITIES[0];
  let bestKm = Infinity;
  for (const city of CITIES) {
    const km = haversineKm(lat, lng, city.lat, city.lng);
    if (km < bestKm) {
      bestKm = km;
      best = city;
    }
  }
  return best;
}

function ensureRegionMap() {
  const container = $("region-map");
  if (state.regionMap) {
    requestAnimationFrame(() => state.regionMap.invalidateSize());
    paintRegionChoices();
    return;
  }
  const map = L.map(container, {
    zoomControl: false,
    attributionControl: true,
    worldCopyJump: true,
  });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  map.setView([18, 20], 1);
  for (const city of CITIES) {
    const marker = L.marker([city.lat, city.lng], {
      icon: L.divIcon({
        className: "region-pin",
        html: "<span></span>",
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      }),
      keyboard: false,
    }).addTo(map);
    marker.on("click", () => selectRegionCity(city.id));
    state.regionMarkers.set(city.id, marker);
  }
  map.on("click", (event) => {
    const city = nearestCity(event.latlng.lat, event.latlng.lng);
    if (city) selectRegionCity(city.id);
  });
  state.regionMap = map;
  requestAnimationFrame(() => {
    map.invalidateSize();
    paintRegionChoices();
  });
}

function showRegion(mode) {
  state.regionMode = mode;
  showOnly("region");
  $("region-back").hidden = mode !== "settings";
  $("region-lede").textContent = mode === "settings" ? SETTINGS_LEDE : REGISTER_LEDE;
  $("btn-region-save").textContent = mode === "settings" ? "儲存地區" : "設為我的地區";
  if (mode === "settings") state.regionDraft = state.originId;
  else if (!findCity(state.regionDraft)) state.regionDraft = null;
  ensureRegionMap();
  paintRegionChoices();
}

function saveRegion() {
  const city = findCity(state.regionDraft);
  if (!city) return;
  const next = state.regionMode === "register" ? (state.afterRegion || "#/") : "#/";
  state.afterRegion = null;
  writeOriginId(city.id);
  navigate(next === location.hash ? "#/" : next);
}

function closePostSlip() {
  const slip = $("post-slip");
  if (slip) slip.hidden = true;
}

async function openPostSlip() {
  try {
    await refreshQuota();
  } catch {
    /* keep the last snapshot */
  }
  if (state.quota?.full) {
    const arrival = state.quota.soonestArrivesAt ? formatArrival(state.quota.soonestArrivesAt) : "";
    showToast(quotaWaitMessage(arrival));
    return;
  }
  const { from, to } = currentEndpoints();
  if (!from || !to || sameEndpoint(from, to)) {
    showToast("請選擇不同的寄出地與收件地");
    return;
  }
  if (!canvasHasInk()) {
    showToast("請先寫下或上傳信面");
    return;
  }
  const plan = planCourier({ from, to, pace: state.pace });
  const arrivesAt = new Date(nowMs() + plan.durationSeconds * 1000).toISOString();
  setText("slip-warning", POST_IRREVOCABLE);
  setText("slip-who", to.name || to.city);
  setText("slip-where", whereLine(to));
  setText("slip-from", originLabel(from));
  setText("slip-when", formatArrival(arrivesAt));
  setText("slip-span", `路上約 ${formatSpan(plan.durationSeconds)}`);
  $("post-slip").hidden = false;
}

function currentEndpoints() {
  const from = senderById(state.originId);
  const to = state.recipient || state.legacyTo;
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
  if (!from || !to) {
    box.className = "estimate";
    box.textContent = "";
    return;
  }
  if (sameEndpoint(from, to)) {
    box.className = "estimate warn";
    box.textContent = "請選擇不同的寄出地與收件地";
    return;
  }
  const plan = planCourier({ from, to, pace: state.pace });
  box.className = "estimate";
  box.innerHTML = `<strong>${esc(formatDistance(plan.distanceKm))}</strong><span>約 ${esc(formatSpan(plan.durationSeconds))}</span><span class="via">信鴿直飛</span>`;
}

function routeUrl(fromId, toId) {
  const query = new URLSearchParams({ fromId, toId, pace: state.pace });
  return `/api/route?${query}`;
}

function applyComposeMode() {
  const recipientMode = state.mode === "recipient" && state.recipient;
  const legacyMode = state.mode === "legacy" && state.legacyTo;
  const addressed = recipientMode || legacyMode;
  $("recipient-banner").hidden = !addressed;
  $("btn-change-recipient").hidden = !recipientMode;
  const origin = senderById(state.originId);
  setText("compose-origin", origin ? `回郵地址 · ${originLabel(origin)}` : "");
  if (recipientMode) {
    $("recipient-name").textContent = state.recipient.name;
    $("recipient-where").textContent = whereLine(state.recipient);
  } else if (legacyMode) {
    const place = state.legacyTo;
    $("recipient-name").textContent = place.city && place.name !== place.city
      ? `${place.name} · ${place.city}`
      : place.name;
    $("recipient-where").textContent = place.country && place.country !== place.name
      ? place.country
      : "";
  }
  updateEstimate();
}

function setPace(pace, { remember = false } = {}) {
  if (!PACES[pace]) return;
  state.pace = pace;
  if (remember) rememberPace(pace);
  $("pace-fast").setAttribute("aria-pressed", pace === "playable-fast" ? "true" : "false");
  $("pace-slow").setAttribute("aria-pressed", pace === "romantic-slow" ? "true" : "false");
  const hint = $("pace-hint");
  hint.hidden = false;
  hint.textContent = PACE_HINT[pace];
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
  state.legacyTo = null;
  state.mode = "recipient";
  const recipient = findRecipient(params.get("to") || "");
  const draftId = params.get("draft");
  if (!recipient && !draftId) {
    navigate("#/draw");
    return;
  }
  if (recipient) {
    state.mode = "recipient";
    state.recipient = recipient;
    state.toId = recipient.id;
    state.fromId = state.originId;
  }
  if (draftId) {
    const letter = await api(`/api/letters/${draftId}`);
    if (token !== renderToken) return;
    if (letter.status !== "draft") {
      if (letter.status === "delivered") navigate(`#/read/${draftId}`);
      else navigate(`#/flight/${draftId}`);
      return;
    }
    state.draftId = letter.id;
    state.fromId = state.originId;
    state.toId = letter.to.id;
    if (PACES[letter.pace]) state.pace = letter.pace;
    const drafted = findRecipient(letter.to.id);
    if (drafted) {
      state.mode = "recipient";
      state.recipient = drafted;
      state.legacyTo = null;
    } else {
      state.mode = "legacy";
      state.recipient = null;
      state.legacyTo = letter.to;
    }
    if (letter.imageUrl) {
      const img = await loadImage(letter.imageUrl);
      paintContained(img);
    }
  }
  applyComposeMode();
  setPace(state.pace);
  await refreshQuota();
  if (token !== renderToken) return;
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
  $("btn-slip-confirm").disabled = true;
  try {
    const body = {
      fromId: from.id,
      toId: state.recipient ? state.recipient.id : to.id,
      pace: state.pace,
      senderId: state.senderId,
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
    closePostSlip();
    if (launch) playPost(letter.id, body.imageDataUrl);
    else navigate("#/");
  } catch (err) {
    const arrival = err.payload?.soonestArrivesAt ? formatArrival(err.payload.soonestArrivesAt) : "";
    showToast(arrival ? quotaWaitMessage(arrival) : err.message);
  } finally {
    state.submitting = false;
    $("btn-save").disabled = false;
    if (state.letters.length) paintMailQuota(state.letters);
    else {
      $("btn-send").disabled = false;
      $("btn-slip-confirm").disabled = false;
    }
  }
}

function setText(id, value) {
  const el = $(id);
  if (el.textContent !== value) el.textContent = value;
}

function pigeonHtml() {
  return `<div class="pigeon-rot"><span class="pigeon-ghost">${pigeonSvg("pigeon-ghost-mask")}</span><span class="pigeon-ink">${pigeonSvg("pigeon-ink-mask")}</span></div>`;
}

function routeEnds(record) {
  if (record?.from && record?.to && Number.isFinite(record.from.lat) && Number.isFinite(record.to.lat)) {
    return {
      from: { name: record.from.name, lat: record.from.lat, lng: record.from.lng },
      to: {
        name: record.to.city || record.to.name,
        lat: record.to.lat,
        lng: record.to.lng,
      },
    };
  }
  const legs = record?.legs;
  if (legs?.length) return { from: legs[0].from, to: legs[legs.length - 1].to };
  return null;
}

function pigeonPath(from, to) {
  const flat = samplePath(from, to, 64);
  return unwrapLongitudes(flat);
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

function mountRouteMap(container, from, to, { showPigeon = false, padBottom = 196, intro = false } = {}) {
  const path = pigeonPath(from, to);
  const latLngs = path.map((point) => [point.lat, point.lng]);
  const map = L.map(container, {
    zoomControl: false,
    attributionControl: true,
    worldCopyJump: true,
    touchZoom: true,
    scrollWheelZoom: true,
    doubleClickZoom: true,
  });
  addTiles(map);

  L.polyline(latLngs, {
    color: PIGEON_INK,
    weight: 2.2,
    opacity: 0.45,
    dashArray: "2 7",
    lineCap: "round",
    lineJoin: "round",
    className: "ink-route",
  }).addTo(map);
  const flown = L.polyline([], {
    color: PIGEON_INK,
    weight: 3.1,
    opacity: 0.92,
    lineCap: "round",
    lineJoin: "round",
    className: "ink-route",
  }).addTo(map);

  const dot = L.divIcon({
    className: "dot-icon",
    html: `<span class="dot dot-origin" style="background:${PIGEON_INK}"></span>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  });
  const origin = path[0];
  const dest = path[path.length - 1];
  L.marker([origin.lat, origin.lng], { icon: dot, interactive: false })
    .bindTooltip(pinLabel(from), { permanent: true, direction: "left", className: "city-label", offset: [-8, 0] })
    .addTo(map);
  L.marker([dest.lat, dest.lng], { icon: dot, interactive: false })
    .bindTooltip(pinLabel(to), { permanent: true, direction: "right", className: "city-label", offset: [8, 0] })
    .addTo(map);

  let pigeon = null;
  if (showPigeon) {
    pigeon = L.marker([origin.lat, origin.lng], {
      icon: L.divIcon({
        className: "pigeon-mark",
        html: pigeonHtml(),
        iconSize: [96, 68],
        iconAnchor: [40, 42],
      }),
      pane: "plane",
      interactive: false,
      zIndexOffset: 800,
    }).addTo(map);
  }

  const all = latLngs;
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
  const followPoint = path[Math.min(path.length - 1, Math.max(1, Math.round((path.length - 1) * 0.45)))];
  state.mapUnwrap = true;
  state.originLng = origin.lng;
  state.dots = new Map();
  container.__map = map;
  return {
    map,
    path,
    flown,
    pigeon,
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

function paintFlown(path, flown, progress) {
  const n = Math.round(clamp(progress, 0, 1) * (path.length - 1));
  flown.setLatLngs(path.slice(0, n + 1).map((point) => [point.lat, point.lng]));
}

function pointAlong(path, progress) {
  const index = clamp(progress, 0, 1) * (path.length - 1);
  const i = Math.floor(index);
  const frac = index - i;
  const a = path[i];
  const b = path[Math.min(path.length - 1, i + 1)];
  return {
    lat: a.lat + (b.lat - a.lat) * frac,
    lng: a.lng + (b.lng - a.lng) * frac,
  };
}

function mountFlight(letter, { intro = false } = {}) {
  const view = mountRouteMap($("map"), letter.from, letter.to, {
    showPigeon: true,
    padBottom: 250,
    intro,
  });
  state.map = view.map;
  const cameraTimers = intro
    ? playDepartureCamera(view.map, view.originPoint, view.followPoint, view.bounds, view.padBottom)
    : [];
  const ends = routeEnds(letter);
  state.flight = {
    letter,
    path: view.path,
    flown: view.flown,
    pigeon: view.pigeon,
    originLng: view.originLng,
    lastBearing: bearingDegrees(ends.from.lat, ends.from.lng, ends.to.lat, ends.to.lng),
    arrived: letter.status === "delivered",
    cameraTimers,
    introUntil: intro ? Date.now() + 4300 : 0,
  };
}

function setPigeon(position, bearing) {
  const { pigeon, originLng } = state.flight;
  if (!pigeon) return;
  pigeon.setLatLng([position.lat, alignLongitude(position.lng, originLng)]);
  const root = pigeon.getElement();
  const rot = root?.querySelector(".pigeon-rot");
  if (rot) rot.style.transform = `rotate(${bearing - 90}deg)`;
}

function renderFlightHud(letter, progress) {
  setText("flight-route", routeLine(letter.from, letter.to));
  setText("flight-origin", `回郵地址 · ${originLabel(letter.from)}`);
  const bar = $("flight-bar");
  bar.style.width = `${progress * 100}%`;
  $("flight-sheet")?.classList.toggle("is-arrived", progress >= 1);
  const dest = letter.to.city || letter.to.name;
  if (progress >= 1) {
    setText("flight-mode", "信鴿已送到");
    setText("flight-eta", "已抵達");
    $("flight-countdown").hidden = true;
    setText("flight-remain", pinLabel(letter.to));
    $("btn-open").hidden = false;
    $("flight-track").hidden = true;
  } else {
    setText("flight-mode", `信鴿在飛，前往${dest}`);
    $("flight-countdown").hidden = false;
    setText("flight-eta", formatArrival(letter.arrivesAt));
    setText("flight-countdown", formatCountdown(Math.max(0, (Date.parse(letter.arrivesAt) - nowMs()) / 1000)));
    const remain = Number.isFinite(letter.distanceKm) ? letter.distanceKm * (1 - progress) : letter.remainingKm;
    setText("flight-remain", `剩餘 ${formatDistance(remain)}`);
    $("btn-open").hidden = true;
    $("flight-track").hidden = false;
  }
}

function tripFraction(trip) {
  const start = Date.parse(trip.departedAt);
  const end = Date.parse(trip.arrivesAt);
  const span = Math.max(1, end - start);
  let elapsed = nowMs() - start;
  if (trip.kind === "background") elapsed = ((elapsed % span) + span) % span;
  else elapsed = clamp(elapsed, 0, span);
  return elapsed / span;
}

function tripPosition(trip) {
  const ends = routeEnds(trip);
  if (!ends) return null;
  const t = tripFraction(trip);
  return interpolate(ends.from.lat, ends.from.lng, ends.to.lat, ends.to.lng, t);
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
    const position = tripPosition(trip);
    if (!position) continue;
    seen.add(trip.id);
    const latlng = markerLatLng(position);
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
  const { letter, path } = flight;
  const start = Date.parse(letter.departedAt);
  const end = Date.parse(letter.arrivesAt);
  const span = Math.max(1, end - start);
  const t = clamp((nowMs() - start) / span, 0, 1);
  paintFlown(path, flight.flown, t);
  const here = pointAlong(path, t);
  const ahead = pointAlong(path, Math.min(1, t + 0.01));
  if (haversineKm(here.lat, here.lng, ahead.lat, ahead.lng) > 0.001) {
    flight.lastBearing = bearingDegrees(here.lat, here.lng, ahead.lat, ahead.lng);
  }
  setPigeon(here, flight.lastBearing);
  renderFlightHud(letter, t);
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
  renderFlightHud(letter, letter.progress || 0);
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
  const arrivedAt = letter.deliveredAt || letter.arrivesAt;
  const stamp = formatPostalStamp(arrivedAt);
  const dest = letter.to.city || letter.to.name;
  const who = letter.to.city && letter.to.name !== letter.to.city ? `，給${letter.to.name}` : "";
  $("read-caption").textContent = `${letter.from.name}寄出 · ${stamp} 抵達${dest}${who}`;
  $("postmark-place").textContent = letter.from.name;
  $("envelope-return").textContent = `寄自 ${originLabel(letter.from)}`;
  $("postmark-time").textContent = formatPostalDate(arrivedAt);
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

function fillAftertaste(letter) {
  const seconds = Number(letter.durationSeconds) || 0;
  const km = formatDistance(letter.distanceKm);
  const from = letter.from?.name || "";
  const to = letter.to?.city || letter.to?.name || "";
  $("read-after").innerHTML =
    `<p class="after-warm">這封信在路上 <b>${esc(formatSpan(seconds))}</b>。</p>` +
    `<p>${esc(`信鴿從${from}飛到${to}，${km}。`)}</p>`;
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
  setText("draw-name", quote.to.name);
  setText("draw-where", whereLine(quote.to));
  setText("draw-meta", `從${quote.from.name}寄出 · ${formatDistance(quote.distanceKm)} · 約 ${formatSpan(quote.durationSeconds)}`);
  setText("draw-via", "信鴿沿著這一條線飛過去");
  setText("draw-origin", `寄自 ${originLabel(quote.from)}`);
  $("btn-write").disabled = quote.to.cityId === quote.from.id;
  clearMap();
  const view = mountRouteMap($("draw-map"), quote.from, quote.to, {
    padBottom: 280,
  });
  state.map = view.map;
}

async function showDraw(params, token) {
  const fromId = state.originId;
  if (!params.get("id")) {
    const payload = { fromId, pace: state.pace };
    if (params.get("exclude")) payload.excludeId = params.get("exclude");
    const draw = await api("/api/recipients/draw", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (token !== renderToken) return;
    const next = `#/draw?id=${encodeURIComponent(draw.to.id)}`;
    if (location.hash !== next) location.replace(next);
    return;
  }
  const quote = await api(routeUrl(fromId, params.get("id")));
  if (token !== renderToken) return;
  await loadActivity().catch(() => {});
  if (token !== renderToken) return;
  presentDraw(quote);
  startAmbient(token);
}

async function redrawRecipient() {
  const excludeId = state.recipient?.id;
  const fromId = state.originId;
  const payload = { fromId, pace: state.pace };
  if (excludeId) payload.excludeId = excludeId;
  const draw = await api("/api/recipients/draw", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const next = `#/draw?id=${encodeURIComponent(draw.to.id)}`;
  if (location.hash === next) presentDraw(draw);
  else location.replace(next);
}

async function render() {
  const token = ++renderToken;
  const { parts, params } = parseHash();
  const keepPost = state.postLetterId && parts[0] === "flight" && parts[1] === state.postLetterId;
  if (!keepPost) cancelPost();
  closePostSlip();
  stopLoops();
  try {
    if (!state.originId) {
      if (parts[0] !== "region") state.afterRegion = location.hash || "#/";
      showRegion("register");
      return;
    }
    if (parts[0] === "region") {
      showRegion("settings");
      return;
    }
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

async function boot() {
  buildRegionList();
  bindCanvas();
  const profile = readSenderProfile();
  state.originId = profile?.originId || null;
  state.senderId = profile?.senderId || null;
  state.fromId = state.originId;
  paintRegionLink();
  $("btn-region").addEventListener("click", () => navigate("#/region"));
  $("region-back").addEventListener("click", () => navigate("#/"));
  $("btn-region-save").addEventListener("click", saveRegion);
  $("btn-slip-back").addEventListener("click", closePostSlip);
  $("btn-slip-confirm").addEventListener("click", () => submitLetter(true));
  $("btn-draw").addEventListener("click", () => navigate("#/draw"));
  $("btn-redraw").addEventListener("click", () => {
    redrawRecipient().catch((err) => showToast(err.message));
  });
  $("btn-write").addEventListener("click", () => {
    if (!state.recipient) return;
    navigate(`#/compose?to=${encodeURIComponent(state.recipient.id)}`);
  });
  $("btn-change-recipient").addEventListener("click", () => {
    if (!state.recipient) return;
    navigate(`#/draw?exclude=${encodeURIComponent(state.recipient.id)}`);
  });
  $("compose-back").addEventListener("click", () => navigate("#/"));
  $("draw-back").addEventListener("click", () => navigate("#/"));
  $("flight-back").addEventListener("click", () => navigate("#/"));
  $("read-back").addEventListener("click", () => navigate("#/"));
  $("ceremony-skip").addEventListener("click", () => {
    state.ceremonySkip = true;
    settleCeremony();
  });
  $("btn-send").addEventListener("click", () => openPostSlip());
  $("btn-save").addEventListener("click", () => submitLetter(false));
  $("btn-undo").addEventListener("click", undoStroke);
  $("btn-clear").addEventListener("click", clearCanvas);
  $("btn-upload").addEventListener("click", () => $("file-input").click());
  $("file-input").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    drawUpload(file);
  });
  $("pace-fast").addEventListener("click", () => setPace("playable-fast", { remember: true }));
  $("pace-slow").addEventListener("click", () => setPace("romantic-slow", { remember: true }));
  window.addEventListener("hashchange", () => {
    render().catch((err) => showToast(err.message));
  });
  await loadDefaultPace();
  if (!location.hash) location.replace("#/");
  else render().catch((err) => showToast(err.message));
}

async function loadDefaultPace() {
  const fromQuery = new URLSearchParams(location.search).get("pace");
  const fromHash = parseHash().params.get("pace");
  const requested = PACES[fromQuery] ? fromQuery : (PACES[fromHash] ? fromHash : null);
  if (requested) {
    setPace(requested, { remember: true });
    return;
  }
  const saved = recallPace();
  if (PACES[saved]) {
    setPace(saved);
    return;
  }
  try {
    const health = await api("/api/health");
    setPace(PACES[health.pace] ? health.pace : DEFAULT_PACE);
  } catch {
    setPace(DEFAULT_PACE);
  }
}

boot();
