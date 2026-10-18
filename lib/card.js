import { Resvg } from "@resvg/resvg-js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatSpan } from "../shared/clock.js";
import { describeFlight } from "../shared/flight.js";
import { planStops, revealStops } from "../shared/marks.js";
import { shareCities } from "../shared/link.js";

const fontFile = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../assets/fonts/NotoSerifTC-Regular.ttf",
);

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

/**
 * Cities, days, and the postmarks the pigeon has already earned.
 * The friend's personal name and the letter face are not on this card.
 */
export function shareCardModel(letter, nowMs) {
  const flight = describeFlight(letter, nowMs);
  const delivered = flight.status === "delivered";
  const stops = revealStops(planStops(letter.from, letter.to), flight.progress, { delivered });
  const places = shareCities(letter);
  return {
    ...places,
    daysText: formatSpan(letter.durationSeconds),
    traveling: !delivered,
    stamps: stops
      .filter((stop) => stop.role !== "arrived")
      .slice(0, 3)
      .map((stop) => ({ city: stop.city || "", country: stop.country || "" })),
  };
}

function stampMark(x, y, rotate, stamp) {
  const city = esc(stamp.city);
  const country = esc(stamp.country);
  return `<g transform="translate(${x} ${y}) rotate(${rotate})" fill="none" stroke="#6e342e">
    <circle cx="0" cy="0" r="54" stroke-width="2.6" opacity="0.88"/>
    <circle cx="0" cy="0" r="44" stroke-width="1.3" opacity="0.78"/>
    <path d="M-34 4 H34" stroke-width="1.1" opacity="0.55"/>
    <path d="M-30 16 H30" stroke-width="1.1" opacity="0.55"/>
    <text x="0" y="-6" text-anchor="middle" font-size="14" fill="#6e342e" stroke="none" font-family="Noto Serif TC">${country}</text>
    <text x="0" y="24" text-anchor="middle" font-size="20" fill="#6e342e" stroke="none" font-family="Noto Serif TC">${city}</text>
  </g>`;
}

export function shareCardSvg(model) {
  const from = esc(model.fromCity);
  const to = esc(model.toCity);
  const fromCountry = esc(model.fromCountry);
  const toCountry = esc(model.toCountry);
  const days = esc(model.daysText);
  const where = fromCountry && toCountry ? `從${fromCountry}寄往${toCountry}` : "";
  const places = model.stamps || [];
  const offsets = [
    [980, 188, -12],
    [860, 230, 8],
    [748, 168, -3],
  ];
  const marks = places.slice(0, 3).map((stamp, index) => {
    const [x, y, rotate] = offsets[index];
    return stampMark(x, y, rotate, stamp);
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <filter id="paper-grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" stitchTiles="stitch" result="noise"/>
      <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0.32  0 0 0 0 0.24  0 0 0 0 0.16  0 0 0 0.16 0"/>
    </filter>
  </defs>
  <rect width="1200" height="630" fill="#d9c4a4"/>
  <rect x="168" y="86" width="900" height="470" fill="#cbb392"/>
  <rect x="150" y="70" width="900" height="470" fill="#f7f1e4" stroke="#6e342e" stroke-width="3"/>
  <rect x="150" y="70" width="900" height="470" filter="url(#paper-grain)"/>
  <path d="M150 70 L600 292 L1050 70" fill="#f7f1e6" stroke="#6e342e" stroke-width="2"/>
  <path d="M150 70 L600 292 L1050 70" fill="none" stroke="#6e342e" stroke-width="1.2" opacity="0.45" transform="translate(1.2 -0.8)"/>
  <g transform="translate(868 104)">
    <rect width="150" height="176" fill="#f3eadc" stroke="#6e342e" stroke-width="3" stroke-dasharray="7 6"/>
    <rect x="10" y="10" width="130" height="156" fill="none" stroke="#6e342e" stroke-width="1.3"/>
    <text x="75" y="78" text-anchor="middle" font-size="26" fill="#6e342e" font-family="Noto Serif TC">在路上</text>
    <text x="75" y="128" text-anchor="middle" font-size="40" fill="#6e342e" font-family="Noto Serif TC">郵</text>
  </g>
  <text x="188" y="400" font-size="46" fill="#2c241e" font-family="Noto Serif TC">${from} → ${to}</text>
  <text x="188" y="454" font-size="28" fill="#6e342e" font-family="Noto Serif TC">路上 ${days}</text>
  <text x="188" y="500" font-size="22" fill="#6e342e" font-family="Noto Serif TC">${esc(where)}</text>
  ${marks}
  <circle cx="210" cy="120" r="1.2" fill="#6e342e" opacity="0.35"/>
  <circle cx="1040" cy="500" r="1.4" fill="#6e342e" opacity="0.28"/>
  <circle cx="430" cy="150" r="0.9" fill="#6e342e" opacity="0.3"/>
</svg>`;
}

export function renderShareCard(model) {
  const svg = shareCardSvg(model);
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 1200 },
    font: {
      fontFiles: [fontFile],
      loadSystemFonts: false,
      defaultFontFamily: "Noto Serif TC",
    },
  });
  return resvg.render().asPng();
}
