/** Real landmark coordinates used as send / receive pins. */
export const PLACES = [
  {
    id: "taipei",
    name: "台北",
    lat: 25.047924,
    lng: 121.517081,
  },
  {
    id: "taipei101",
    name: "台北101",
    lat: 25.033963,
    lng: 121.564472,
  },
  {
    id: "taichung",
    name: "台中",
    lat: 24.136849,
    lng: 120.684616,
  },
  {
    id: "kaohsiung",
    name: "高雄",
    lat: 22.627278,
    lng: 120.301435,
  },
  {
    id: "tokyo",
    name: "東京",
    lat: 35.681236,
    lng: 139.767125,
  },
];

export const PRESETS = [
  {
    id: "tpe-khh",
    from: "taipei",
    to: "kaohsiung",
    label: "台北 → 高雄",
    note: "同島",
  },
  {
    id: "tpe-tyo",
    from: "taipei",
    to: "tokyo",
    label: "台北 → 東京",
    note: "較長",
  },
  {
    id: "tpe-101",
    from: "taipei",
    to: "taipei101",
    label: "台北 → 台北101",
    note: "同城",
  },
];

export function findPlace(id) {
  return PLACES.find((place) => place.id === id) || null;
}

export function findPreset(id) {
  return PRESETS.find((preset) => preset.id === id) || null;
}
