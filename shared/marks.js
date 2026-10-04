import { describeFlight, haversineKm, interpolate } from "./flight.js";
import { normalizeSenderId } from "./profile.js";
import { zoneForPlace } from "./slip.js";

/**
 * Static cities used to cancel a pigeon route.
 * Samples along the great circle snap to the nearest city. If that city is
 * still farther than LAND_RADIUS_KM, the sample is treated as ocean and
 * left unstamped. No outside lookup.
 */
export const LAND_RADIUS_KM = 700;

/** Along-track gap before a second city in the same country is stamped. */
const SAME_COUNTRY_GAP_KM = 1600;

/** A via this close to an endpoint is the endpoint's own stamp. */
const ENDPOINT_GAP_KM = 180;

export const PASSPORT_EMPTY = "還沒有蓋到任何國家。信飛過一個國家，這裡就留下一枚戳。";

export const GAZETTEER = [
  { id: "taipei", city: "台北", country: "台灣", lat: 25.037, lng: 121.564, timeZone: "Asia/Taipei" },
  { id: "tokyo", city: "東京", country: "日本", lat: 35.681, lng: 139.767, timeZone: "Asia/Tokyo" },
  { id: "osaka", city: "大阪", country: "日本", lat: 34.694, lng: 135.502, timeZone: "Asia/Tokyo" },
  { id: "seoul", city: "首爾", country: "韓國", lat: 37.566, lng: 126.978, timeZone: "Asia/Seoul" },
  { id: "beijing", city: "北京", country: "中國", lat: 39.904, lng: 116.407, timeZone: "Asia/Shanghai" },
  { id: "shanghai", city: "上海", country: "中國", lat: 31.23, lng: 121.474, timeZone: "Asia/Shanghai" },
  { id: "xian", city: "西安", country: "中國", lat: 34.341, lng: 108.94, timeZone: "Asia/Shanghai" },
  { id: "chengdu", city: "成都", country: "中國", lat: 30.573, lng: 104.066, timeZone: "Asia/Shanghai" },
  { id: "lanzhou", city: "蘭州", country: "中國", lat: 36.061, lng: 103.834, timeZone: "Asia/Shanghai" },
  { id: "urumqi", city: "烏魯木齊", country: "中國", lat: 43.825, lng: 87.617, timeZone: "Asia/Urumqi" },
  { id: "hong-kong", city: "香港", country: "香港", lat: 22.319, lng: 114.169, timeZone: "Asia/Hong_Kong" },
  { id: "guangzhou", city: "廣州", country: "中國", lat: 23.129, lng: 113.264, timeZone: "Asia/Shanghai" },
  { id: "kunming", city: "昆明", country: "中國", lat: 25.038, lng: 102.718, timeZone: "Asia/Shanghai" },
  { id: "singapore", city: "新加坡", country: "新加坡", lat: 1.352, lng: 103.82, timeZone: "Asia/Singapore" },
  { id: "bangkok", city: "曼谷", country: "泰國", lat: 13.756, lng: 100.502, timeZone: "Asia/Bangkok" },
  { id: "hanoi", city: "河內", country: "越南", lat: 21.028, lng: 105.854, timeZone: "Asia/Bangkok" },
  { id: "manila", city: "馬尼拉", country: "菲律賓", lat: 14.599, lng: 120.984, timeZone: "Asia/Manila" },
  { id: "jakarta", city: "雅加達", country: "印尼", lat: -6.208, lng: 106.846, timeZone: "Asia/Jakarta" },
  { id: "delhi", city: "德里", country: "印度", lat: 28.614, lng: 77.209, timeZone: "Asia/Kolkata" },
  { id: "mumbai", city: "孟買", country: "印度", lat: 19.076, lng: 72.878, timeZone: "Asia/Kolkata" },
  { id: "kolkata", city: "加爾各答", country: "印度", lat: 22.573, lng: 88.364, timeZone: "Asia/Kolkata" },
  { id: "almaty", city: "阿拉木圖", country: "哈薩克", lat: 43.238, lng: 76.945, timeZone: "Asia/Almaty" },
  { id: "tashkent", city: "塔什干", country: "烏茲別克", lat: 41.3, lng: 69.24, timeZone: "Asia/Tashkent" },
  { id: "tehran", city: "德黑蘭", country: "伊朗", lat: 35.689, lng: 51.389, timeZone: "Asia/Tehran" },
  { id: "dubai", city: "杜拜", country: "阿聯", lat: 25.205, lng: 55.271, timeZone: "Asia/Dubai" },
  { id: "istanbul", city: "伊斯坦堡", country: "土耳其", lat: 41.008, lng: 28.978, timeZone: "Europe/Istanbul" },
  { id: "ankara", city: "安卡拉", country: "土耳其", lat: 39.933, lng: 32.859, timeZone: "Europe/Istanbul" },
  { id: "moscow", city: "莫斯科", country: "俄羅斯", lat: 55.756, lng: 37.617, timeZone: "Europe/Moscow" },
  { id: "novosibirsk", city: "新西伯利亞", country: "俄羅斯", lat: 55.008, lng: 82.935, timeZone: "Asia/Novosibirsk" },
  { id: "irkutsk", city: "伊爾庫茨克", country: "俄羅斯", lat: 52.287, lng: 104.305, timeZone: "Asia/Irkutsk" },
  { id: "ulaanbaatar", city: "烏蘭巴托", country: "蒙古", lat: 47.886, lng: 106.905, timeZone: "Asia/Ulaanbaatar" },
  { id: "london", city: "倫敦", country: "英國", lat: 51.507, lng: -0.128, timeZone: "Europe/London" },
  { id: "paris", city: "巴黎", country: "法國", lat: 48.857, lng: 2.352, timeZone: "Europe/Paris" },
  { id: "berlin", city: "柏林", country: "德國", lat: 52.52, lng: 13.405, timeZone: "Europe/Berlin" },
  { id: "rome", city: "羅馬", country: "義大利", lat: 41.902, lng: 12.496, timeZone: "Europe/Rome" },
  { id: "lisbon", city: "里斯本", country: "葡萄牙", lat: 38.722, lng: -9.139, timeZone: "Europe/Lisbon" },
  { id: "madrid", city: "馬德里", country: "西班牙", lat: 40.417, lng: -3.704, timeZone: "Europe/Madrid" },
  { id: "vienna", city: "維也納", country: "奧地利", lat: 48.208, lng: 16.373, timeZone: "Europe/Vienna" },
  { id: "warsaw", city: "華沙", country: "波蘭", lat: 52.23, lng: 21.012, timeZone: "Europe/Warsaw" },
  { id: "bucharest", city: "布加勒斯特", country: "羅馬尼亞", lat: 44.426, lng: 26.102, timeZone: "Europe/Bucharest" },
  { id: "athens", city: "雅典", country: "希臘", lat: 37.984, lng: 23.728, timeZone: "Europe/Athens" },
  { id: "cairo", city: "開羅", country: "埃及", lat: 30.044, lng: 31.236, timeZone: "Africa/Cairo" },
  { id: "cape-town", city: "開普敦", country: "南非", lat: -33.925, lng: 18.424, timeZone: "Africa/Johannesburg" },
  { id: "johannesburg", city: "約翰尼斯堡", country: "南非", lat: -26.205, lng: 28.05, timeZone: "Africa/Johannesburg" },
  { id: "nairobi", city: "奈洛比", country: "肯亞", lat: -1.292, lng: 36.822, timeZone: "Africa/Nairobi" },
  { id: "lagos", city: "拉哥斯", country: "奈及利亞", lat: 6.524, lng: 3.379, timeZone: "Africa/Lagos" },
  { id: "casablanca", city: "卡薩布蘭卡", country: "摩洛哥", lat: 33.573, lng: -7.59, timeZone: "Africa/Casablanca" },
  { id: "new-york", city: "紐約", country: "美國", lat: 40.713, lng: -74.006, timeZone: "America/New_York" },
  { id: "chicago", city: "芝加哥", country: "美國", lat: 41.878, lng: -87.63, timeZone: "America/Chicago" },
  { id: "los-angeles", city: "洛杉磯", country: "美國", lat: 34.052, lng: -118.244, timeZone: "America/Los_Angeles" },
  { id: "anchorage", city: "安克拉治", country: "美國", lat: 61.218, lng: -149.9, timeZone: "America/Anchorage" },
  { id: "mexico-city", city: "墨西哥城", country: "墨西哥", lat: 19.433, lng: -99.133, timeZone: "America/Mexico_City" },
  { id: "vancouver", city: "溫哥華", country: "加拿大", lat: 49.283, lng: -123.121, timeZone: "America/Vancouver" },
  { id: "toronto", city: "多倫多", country: "加拿大", lat: 43.653, lng: -79.383, timeZone: "America/Toronto" },
  { id: "rio", city: "里約熱內盧", country: "巴西", lat: -22.907, lng: -43.173, timeZone: "America/Sao_Paulo" },
  { id: "sao-paulo", city: "聖保羅", country: "巴西", lat: -23.551, lng: -46.633, timeZone: "America/Sao_Paulo" },
  { id: "sydney", city: "雪梨", country: "澳洲", lat: -33.869, lng: 151.209, timeZone: "Australia/Sydney" },
  { id: "melbourne", city: "墨爾本", country: "澳洲", lat: -37.814, lng: 144.963, timeZone: "Australia/Melbourne" },
  { id: "perth", city: "伯斯", country: "澳洲", lat: -31.952, lng: 115.861, timeZone: "Australia/Perth" },
  { id: "auckland", city: "奧克蘭", country: "紐西蘭", lat: -36.851, lng: 174.764, timeZone: "Pacific/Auckland" },
];

export function nearestGazetteer(lat, lng, gazetteer = GAZETTEER) {
  let city = null;
  let km = Infinity;
  for (const entry of gazetteer) {
    const distance = haversineKm(lat, lng, entry.lat, entry.lng);
    if (distance < km) {
      city = entry;
      km = distance;
    }
  }
  return { city, km };
}

function endpointStop(point, role) {
  const city = point.city || point.name || (role === "origin" ? "寄出地" : "收件地");
  return {
    id: point.cityId || point.id || role,
    role,
    city,
    country: point.country || "",
    lat: point.lat,
    lng: point.lng,
    timeZone: point.timeZone || zoneForPlace(point),
    t: role === "destination" ? 1 : 0,
  };
}

function selectVias(hits, origin, destination, distanceKm) {
  const vias = [];
  const seen = new Set();
  for (const hit of hits) {
    if (seen.has(hit.id)) continue;
    if (haversineKm(hit.lat, hit.lng, origin.lat, origin.lng) < ENDPOINT_GAP_KM) continue;
    if (haversineKm(hit.lat, hit.lng, destination.lat, destination.lng) < ENDPOINT_GAP_KM) continue;
    const previous = vias.findLast?.((stop) => stop.country === hit.country)
      || [...vias].reverse().find((stop) => stop.country === hit.country);
    if (previous && (hit.t - previous.t) * distanceKm < SAME_COUNTRY_GAP_KM) continue;
    seen.add(hit.id);
    vias.push({
      id: hit.id,
      role: "via",
      city: hit.city,
      country: hit.country,
      lat: hit.lat,
      lng: hit.lng,
      timeZone: hit.timeZone,
      t: hit.t,
    });
  }
  return vias;
}

/**
 * Origin, land cities along the great circle, then the destination.
 * Ocean samples are dropped. Origin and destination are always present
 * when both points have coordinates.
 */
export function planStops(from, to, gazetteer = GAZETTEER) {
  if (!from || !to) return [];
  if (!Number.isFinite(from.lat) || !Number.isFinite(from.lng)) return [];
  if (!Number.isFinite(to.lat) || !Number.isFinite(to.lng)) return [];
  const origin = endpointStop(from, "origin");
  const destination = endpointStop(to, "destination");
  const distanceKm = haversineKm(from.lat, from.lng, to.lat, to.lng);
  const samples = Math.max(16, Math.ceil(distanceKm / 260));
  const hits = [];
  for (let i = 1; i < samples; i += 1) {
    const t = i / samples;
    const point = interpolate(from.lat, from.lng, to.lat, to.lng, t);
    const near = nearestGazetteer(point.lat, point.lng, gazetteer);
    if (!near.city || near.km > LAND_RADIUS_KM) continue;
    hits.push({ ...near.city, t });
  }
  return [origin, ...selectVias(hits, origin, destination, distanceKm), destination];
}

/**
 * Stamps the pigeon has earned.
 * Origin is there from the start. A via appears once progress reaches it.
 * The destination city and 「已送達」 appear together, when the letter has arrived.
 */
export function revealStops(stops, progress, { delivered = false } = {}) {
  const t = delivered ? 1 : Math.min(1, Math.max(0, Number(progress) || 0));
  const visible = [];
  for (const stop of stops || []) {
    if (stop.role === "destination") {
      if (t >= 1) visible.push(stop);
    } else if (t + 1e-9 >= stop.t) {
      visible.push(stop);
    }
  }
  if (delivered || t >= 1) {
    const dest = (stops || []).find((stop) => stop.role === "destination");
    visible.push({
      id: "arrived",
      role: "arrived",
      city: "已送達",
      country: dest?.city || "",
      lat: dest?.lat,
      lng: dest?.lng,
      timeZone: dest?.timeZone || null,
      t: 1,
    });
  }
  return visible;
}

export function stopTimeMs(letter, t) {
  const start = Date.parse(letter?.departedAt);
  const end = Date.parse(letter?.arrivesAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return NaN;
  return start + (end - start) * Math.min(1, Math.max(0, Number(t) || 0));
}

function hashText(text) {
  let hash = 2166136261;
  const value = String(text);
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

function wobbleRing(cx, cy, radius, seed, amount) {
  const steps = 16;
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const angle = (i / steps) * Math.PI * 2;
    const jitter = ((((seed >> (i % 12)) & 7) - 3) / 3) * amount;
    const r = radius + jitter;
    points.push(`${(cx + Math.cos(angle) * r).toFixed(2)} ${(cy + Math.sin(angle) * r).toFixed(2)}`);
  }
  return `M ${points.join(" L ")} Z`;
}

/**
 * Vintage cancel, drawn as vectors. Ink depth and tilt come from the place,
 * so the same city always sits a little crooked the same way.
 */
export function postmarkSvg(mark, { date = "" } = {}) {
  const seed = hashText(`${mark?.role || ""}|${mark?.country || ""}|${mark?.city || ""}|${date}`);
  const tilt = ((seed % 700) / 100 - 3.5).toFixed(2);
  const opacity = (0.74 + (seed % 18) / 100).toFixed(2);
  const shift = ((seed >> 6) % 5) - 2;
  const city = esc(mark?.city || "");
  const arc = esc(mark?.role === "arrived" ? (mark?.country || "在路上") : (mark?.country || ""));
  const day = esc(date);
  const size = [...(mark?.city || "")].length > 4 ? 15 : 18;
  const uid = `pm${seed.toString(36)}`;
  const outer = wobbleRing(80, 78, 58, seed, 1.15);
  const inner = wobbleRing(80, 78, 50, seed >> 3, 0.85);
  const wave = (y, salt) => {
    let d = `M 36 ${y}`;
    for (let x = 36; x <= 124; x += 10) {
      const dy = ((((seed + salt + x) >> 2) % 7) - 3);
      d += ` Q ${x + 5} ${y + dy} ${x + 10} ${y}`;
    }
    return d;
  };
  return `<svg class="postmark-svg" viewBox="0 0 160 160" width="148" height="148" role="img" aria-label="${city}" style="transform:rotate(${tilt}deg)">
  <g fill="none" stroke="#6e342e" stroke-width="1.6" opacity="${opacity}">
    <g transform="translate(${shift * 0.35} ${-0.6})">
      <path d="${outer}" />
      <path d="${inner}" />
    </g>
    <path d="${outer}" stroke-width="1.35" opacity="0.55" transform="translate(1.6 -1.1)" />
    <path d="${wave(70, 3)}" stroke-width="1.15" />
    <path d="${wave(86, 11)}" stroke-width="1.15" />
    <circle cx="${92 + (seed % 5)}" cy="${46 + (seed % 4)}" r="0.8" fill="#6e342e" stroke="none" opacity="0.45" />
    <circle cx="${48 + (seed % 6)}" cy="${108 + (seed % 3)}" r="0.7" fill="#6e342e" stroke="none" opacity="0.4" />
  </g>
  <defs>
    <path id="${uid}" d="M28 58 A52 52 0 0 1 132 58" fill="none" />
  </defs>
  <text fill="#6e342e" opacity="${opacity}" font-family="Noto Serif TC, Songti TC, PMingLiU, serif">
    <textPath href="#${uid}" startOffset="50%" text-anchor="middle" font-size="11">${arc}</textPath>
    <tspan x="80" y="96" text-anchor="middle" font-size="${size}">${city}</tspan>
    <tspan x="80" y="118" text-anchor="middle" font-size="11">${day}</tspan>
  </text>
</svg>`;
}

/**
 * Countries this sender's letters have reached, once each.
 * The first time a country is crossed is the one that stays.
 * Letters with no sender id, or a different one, are ignored.
 * A broken letter is skipped rather than failing the whole passport.
 */
export function collectPassport(letters, senderId, nowMs = Date.now()) {
  const id = normalizeSenderId(senderId);
  if (!id) return [];
  const first = new Map();
  for (const letter of letters || []) {
    try {
      if (!letter || letter.senderId !== id) continue;
      if (letter.status !== "in_flight" && letter.status !== "delivered") continue;
      const stops = planStops(letter.from, letter.to);
      if (!stops.length) continue;
      const flight = describeFlight(letter, nowMs);
      const delivered = letter.status === "delivered" || flight.status === "delivered";
      const visible = revealStops(stops, flight.progress, { delivered });
      for (const stop of visible) {
        if (!stop.country || stop.role === "arrived") continue;
        const atMs = stopTimeMs(letter, stop.t);
        if (!Number.isFinite(atMs)) continue;
        const prev = first.get(stop.country);
        if (prev && prev.atMs <= atMs) continue;
        first.set(stop.country, {
          country: stop.country,
          city: stop.city,
          timeZone: stop.timeZone || null,
          at: new Date(atMs).toISOString(),
          atMs,
        });
      }
    } catch {
      /* old or partial letters still must not break the passport */
    }
  }
  return [...first.values()]
    .sort((a, b) => a.atMs - b.atMs)
    .map(({ atMs, ...rest }) => rest);
}
