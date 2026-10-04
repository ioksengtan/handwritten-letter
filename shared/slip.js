/** Wording on the post-office counter slip. A posted letter cannot be recalled. */
export const POST_IRREVOCABLE = "一旦投入郵筒，這封信就不能收回，也不能再改。";

/**
 * IANA zones for the demo cities and the landmark pins still stored on old letters.
 * The slip prints the arrival in the destination's zone. Unknown places do not
 * pretend to know the local clock.
 */
const ZONES = {
  taipei: "Asia/Taipei",
  taipei101: "Asia/Taipei",
  taichung: "Asia/Taipei",
  kaohsiung: "Asia/Taipei",
  tokyo: "Asia/Tokyo",
  seoul: "Asia/Seoul",
  "hong-kong": "Asia/Hong_Kong",
  singapore: "Asia/Singapore",
  bangkok: "Asia/Bangkok",
  lisbon: "Europe/Lisbon",
  paris: "Europe/Paris",
  london: "Europe/London",
  berlin: "Europe/Berlin",
  rome: "Europe/Rome",
  cairo: "Africa/Cairo",
  "cape-town": "Africa/Johannesburg",
  nairobi: "Africa/Nairobi",
  "new-york": "America/New_York",
  "mexico-city": "America/Mexico_City",
  rio: "America/Sao_Paulo",
  vancouver: "America/Vancouver",
  sydney: "Australia/Sydney",
  auckland: "Pacific/Auckland",
  台北: "Asia/Taipei",
  台北101: "Asia/Taipei",
  台中: "Asia/Taipei",
  高雄: "Asia/Taipei",
  東京: "Asia/Tokyo",
  首爾: "Asia/Seoul",
  香港: "Asia/Hong_Kong",
  新加坡: "Asia/Singapore",
  曼谷: "Asia/Bangkok",
  里斯本: "Europe/Lisbon",
  巴黎: "Europe/Paris",
  倫敦: "Europe/London",
  柏林: "Europe/Berlin",
  羅馬: "Europe/Rome",
  開羅: "Africa/Cairo",
  開普敦: "Africa/Johannesburg",
  奈洛比: "Africa/Nairobi",
  紐約: "America/New_York",
  墨西哥城: "America/Mexico_City",
  里約熱內盧: "America/Sao_Paulo",
  溫哥華: "America/Vancouver",
  雪梨: "Australia/Sydney",
  奧克蘭: "Pacific/Auckland",
};

export function zoneForPlace(place) {
  if (!place) return null;
  return ZONES[place.id] || ZONES[place.cityId] || ZONES[place.city] || ZONES[place.name] || null;
}

function zonedParts(iso, timeZone) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("zh-TW", {
    timeZone,
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  const month = get("month");
  const day = get("day");
  if (!month || !day) return null;
  const period = get("dayPeriod");
  const hour = get("hour");
  const minute = get("minute");
  return {
    month,
    day,
    clock: [period, hour && minute ? `${hour}:${minute}` : ""].filter(Boolean).join(" "),
  };
}

/**
 * Counter-slip arrival line, in the destination's own zone.
 * Example: 預計 10 月 14 日抵達紐約, plus 當地時間 …
 * Without a known zone, both strings stay empty so the page can fall back
 * without calling that fallback 「當地」.
 */
export function formatSlipArrival(iso, place) {
  const city = place?.city || place?.name || "";
  const timeZone = zoneForPlace(place);
  if (!city || !timeZone) return { sentence: "", localTime: "" };
  let parts;
  try {
    parts = zonedParts(iso, timeZone);
  } catch {
    return { sentence: "", localTime: "" };
  }
  if (!parts) return { sentence: "", localTime: "" };
  return {
    sentence: `預計 ${parts.month} 月 ${parts.day} 日抵達${city}`,
    localTime: parts.clock ? `當地時間 ${parts.clock}` : "",
  };
}

/** Numeric month.day in an explicit zone, for a postmark. */
export function formatZonedDay(iso, timeZone) {
  if (!timeZone) return "";
  try {
    const parts = zonedParts(iso, timeZone);
    if (!parts) return "";
    return `${parts.month}.${parts.day}`;
  } catch {
    return "";
  }
}
