/**
 * Landmark coordinates kept so letters already stored in data/letters.json,
 * and older requests that still name these ids, can resolve a pin.
 * They are not offered as routes on the home page.
 */
export const PLACES = [
  {
    id: "taipei",
    name: "台北",
    country: "台灣",
    lat: 25.047924,
    lng: 121.517081,
  },
  {
    id: "taipei101",
    name: "台北101",
    country: "台灣",
    lat: 25.033963,
    lng: 121.564472,
  },
  {
    id: "taichung",
    name: "台中",
    country: "台灣",
    lat: 24.136849,
    lng: 120.684616,
  },
  {
    id: "kaohsiung",
    name: "高雄",
    country: "台灣",
    lat: 22.627278,
    lng: 120.301435,
  },
  {
    id: "tokyo",
    name: "東京",
    country: "日本",
    lat: 35.681236,
    lng: 139.767125,
  },
];

export function findPlace(id) {
  return PLACES.find((place) => place.id === id) || null;
}
