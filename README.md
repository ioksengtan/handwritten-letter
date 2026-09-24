# 手寫信

直式手機網頁原型。信依真實地理距離飛行，地圖上看得到目前位置、剩餘距離與預計抵達。沒有帳號：同一台裝置負責寄出與拆信。

## 本機執行

需要 Node.js 18 以上。

```bash
npm install
npm test
npm start
```

瀏覽器打開 [http://localhost:3000](http://localhost:3000)。畫面是直式欄位，手機寬度會滿版。

主路徑：抽一位隨機收件人 → 地圖上先看到對方的名字和城市 → 寫信或上傳照片 → 扔出 → 看紙飛機沿航線移動 → 抵達後打開信。重新整理後，飛行中的信仍停在當時的軌跡位置。

固定路線（台北 → 高雄、台北 → 東京、台北 → 台北101）留在首頁下方，用來很快看完短途降落。

想清空資料，停掉伺服器後刪除 `data/letters.json` 和 `data/images/`。

## 固定路線

地點用真實座標（台北車站、台北101、高雄市、東京車站，另可選台中車站）。

| 路線 | 距離 | 可玩快 | 浪漫慢（預留） |
| --- | ---: | ---: | ---: |
| 台北 → 台北101 | 5.0 公里 | 27 秒 | 3 分鐘 |
| 台北 → 高雄 | 296 公里 | 3 分 27 秒 | 20 分 5 秒 |
| 台北 → 東京 | 2107 公里 | 9 分 11 秒 | 53 分 33 秒 |

同城那條用來在半分鐘內看完降落。預設節奏是可玩快。

## 隨機收件人

名單裡有 20 位示範收件人，分在亞洲、歐洲、非洲、美洲、大洋洲的真實城市。抽籤在伺服器：避開寄出地所在城市，也避開剛剛抽到、或這台裝置剛寄出的那位。寄出地預設台北，也可以改成名單上的其他城市。飛行時間仍用上面的距離公式，不另外加速。

抽出之後先停在地圖上，確認名字和城市，再進入寫信。

## 飛行時間怎麼算

距離是兩點的大圓距離（haversine，地球半徑 6371.0088 公里）。

可玩快（預設 `playable-fast`）：

```text
秒數 = clamp(12 × √距離公里, 25, 1080)
```

- 下限 25 秒，短途也不會瞬移。
- 同城約數十秒，跨城數分鐘。
- 上限 1080 秒（18 分鐘）。約 8000 公里以上會頂到上限，跨洲落在 10–20 分鐘內。12000 公里就是 18 分鐘。

浪漫慢（預留 `romantic-slow`，寫信時可切換）：

```text
秒數 = clamp(70 × √距離公里, 180, 5400)
```

上限 90 分鐘，跨洋約一小時級。

扔出時後端寫入 `departedAt`、`arrivesAt` 和狀態（`draft` / `in_flight` / `delivered`）。進度只看時間：

```text
進度 = (現在 − 起飛時間) / (落地時間 − 起飛時間)
```

位置是這段進度在大圓航線上的插值。剩餘距離 = 總距離 × (1 − 進度)。客戶端只畫航線與紙飛機；時間到了，後端把狀態改成 `delivered`。飛行中不能讀信面，抵達後才打得開。

## API

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| GET | `/api/places` | 固定路線用地點 |
| GET | `/api/presets` | 固定路線 |
| GET | `/api/recipients` | 隨機收件人名單 |
| POST | `/api/recipients/draw` | 抽一位。可帶 `fromId`、`excludeId` |
| GET | `/api/route?fromId&toId` | 某組起迄的距離與飛行時間 |
| GET | `/api/letters` | 信件與目前進度 |
| POST | `/api/letters` | 建立。`launch: true` 會直接起飛 |
| PUT | `/api/letters/:id` | 更新草稿 |
| POST | `/api/letters/:id/throw` | 草稿起飛 |
| GET | `/api/letters/:id` | 單封信，含位置與剩餘時間 |
| GET | `/api/letters/:id/image` | 信面。飛行中回 403 |

建立信件的 JSON：

```json
{
  "fromId": "taipei",
  "toId": "kaohsiung",
  "pace": "playable-fast",
  "imageDataUrl": "data:image/png;base64,...",
  "launch": true
}
```

`pace` 只接受 `playable-fast` 或 `romantic-slow`。

地圖圖磚是 CARTO Positron（資料來自 OpenStreetMap）。
