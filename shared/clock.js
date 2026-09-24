// 寄出、抵達這類時刻只在瀏覽器格式化，用這台裝置自己的時區。
// 伺服器只給 ISO 時間戳，這裡不寫死任何時區。

export function browserTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function formatInBrowserZone(iso, fields) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: browserTimeZone(),
    ...fields,
  }).format(date);
}

export function formatPostalDate(iso) {
  return formatInBrowserZone(iso, {
    month: "numeric",
    day: "numeric",
  });
}

export function formatPostalStamp(iso) {
  const dateText = formatPostalDate(iso);
  const timeText = formatInBrowserZone(iso, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  if (!dateText || !timeText) return "";
  return `${dateText} ${timeText}`.replace(/\s+/g, " ").trim();
}
