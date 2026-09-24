import { haversineKm } from "./flight.js";

/**
 * Demo Postcrossing-style pool. One person per real city.
 * cityId matches a sender pin. taipei and tokyo use the same coordinates
 * as the preset places.
 */
export const RECIPIENTS = [
  { id: "yu-an", name: "郁安", cityId: "taipei", city: "台北", country: "台灣", continent: "亞洲", lat: 25.047924, lng: 121.517081 },
  { id: "aoi", name: "葵", cityId: "tokyo", city: "東京", country: "日本", continent: "亞洲", lat: 35.681236, lng: 139.767125 },
  { id: "seoyeon", name: "書妍", cityId: "seoul", city: "首爾", country: "韓國", continent: "亞洲", lat: 37.5665, lng: 126.978 },
  { id: "jiahui", name: "嘉慧", cityId: "hong-kong", city: "香港", country: "香港", continent: "亞洲", lat: 22.2819, lng: 114.1586 },
  { id: "sari", name: "Sari", cityId: "singapore", city: "新加坡", country: "新加坡", continent: "亞洲", lat: 1.2905, lng: 103.852 },
  { id: "arun", name: "Arun", cityId: "bangkok", city: "曼谷", country: "泰國", continent: "亞洲", lat: 13.7563, lng: 100.5018 },
  { id: "mina", name: "Mina", cityId: "lisbon", city: "里斯本", country: "葡萄牙", continent: "歐洲", lat: 38.7223, lng: -9.1393 },
  { id: "camille", name: "Camille", cityId: "paris", city: "巴黎", country: "法國", continent: "歐洲", lat: 48.8566, lng: 2.3522 },
  { id: "ellen", name: "Ellen", cityId: "london", city: "倫敦", country: "英國", continent: "歐洲", lat: 51.5074, lng: -0.1278 },
  { id: "jonas", name: "Jonas", cityId: "berlin", city: "柏林", country: "德國", continent: "歐洲", lat: 52.52, lng: 13.405 },
  { id: "giulia", name: "Giulia", cityId: "rome", city: "羅馬", country: "義大利", continent: "歐洲", lat: 41.9028, lng: 12.4964 },
  { id: "nadia", name: "Nadia", cityId: "cairo", city: "開羅", country: "埃及", continent: "非洲", lat: 30.0444, lng: 31.2357 },
  { id: "lindiwe", name: "Lindiwe", cityId: "cape-town", city: "開普敦", country: "南非", continent: "非洲", lat: -33.9249, lng: 18.4241 },
  { id: "amina", name: "Amina", cityId: "nairobi", city: "奈洛比", country: "肯亞", continent: "非洲", lat: -1.2921, lng: 36.8219 },
  { id: "noah", name: "Noah", cityId: "new-york", city: "紐約", country: "美國", continent: "美洲", lat: 40.758, lng: -73.9855 },
  { id: "lucia", name: "Lucía", cityId: "mexico-city", city: "墨西哥城", country: "墨西哥", continent: "美洲", lat: 19.4326, lng: -99.1332 },
  { id: "bruno", name: "Bruno", cityId: "rio", city: "里約熱內盧", country: "巴西", continent: "美洲", lat: -22.9068, lng: -43.1729 },
  { id: "sophie", name: "Sophie", cityId: "vancouver", city: "溫哥華", country: "加拿大", continent: "美洲", lat: 49.2827, lng: -123.1207 },
  { id: "owen", name: "Owen", cityId: "sydney", city: "雪梨", country: "澳洲", continent: "大洋洲", lat: -33.8732, lng: 151.2069 },
  { id: "maia", name: "Maia", cityId: "auckland", city: "奧克蘭", country: "紐西蘭", continent: "大洋洲", lat: -36.8509, lng: 174.7645 },
];

export const CITIES = RECIPIENTS.map((recipient) => ({
  id: recipient.cityId,
  name: recipient.city,
  lat: recipient.lat,
  lng: recipient.lng,
}));

export function findRecipient(id) {
  return RECIPIENTS.find((recipient) => recipient.id === id) || null;
}

export function findCity(id) {
  return CITIES.find((city) => city.id === id) || null;
}

function tooClose(from, recipient) {
  if (!from) return false;
  if (recipient.cityId === from.id) return true;
  return haversineKm(from.lat, from.lng, recipient.lat, recipient.lng) < 30;
}

/**
 * Pick a demo recipient. Skips the sender's own city and anyone in
 * `excludeIds` (the person just drawn, or the last one this device sent to).
 */
export function pickRecipient({
  from,
  excludeIds = [],
  random = Math.random,
  recipients = RECIPIENTS,
} = {}) {
  const banned = new Set(excludeIds.filter(Boolean));
  const awayFromHome = (extraBan) => recipients.filter((recipient) => {
    if (extraBan.has(recipient.id)) return false;
    return !tooClose(from, recipient);
  });

  let pool = awayFromHome(banned);
  if (!pool.length) pool = recipients.filter((recipient) => !banned.has(recipient.id));
  if (!pool.length) pool = awayFromHome(new Set());
  if (!pool.length) pool = recipients.slice();

  const roll = Math.abs(Number(random()));
  const fraction = Number.isFinite(roll) ? roll % 1 : 0;
  const index = Math.min(pool.length - 1, Math.floor(fraction * pool.length));
  return pool[index];
}
