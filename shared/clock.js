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

/** Arrival clock time in the browser zone, with the calendar day. */
export function formatArrival(iso) {
  return formatInBrowserZone(iso, {
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * How long a letter is on the way.
 * A day or more is spoken in days and hours, so a week does not become
 * a pile of minutes. Under a day, minutes and seconds stay, for the fast pace.
 */
export function formatSpan(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小時` : `${days} 天`;
  if (hours > 0) return minutes > 0 ? `${hours} 小時 ${minutes} 分` : `${hours} 小時`;
  if (minutes > 0) return secs > 0 ? `${minutes} 分 ${secs} 秒` : `${minutes} 分鐘`;
  return `${secs} 秒`;
}

/** Remaining wait. The last second reads as about to arrive. */
export function formatCountdown(seconds) {
  const total = Math.max(0, Math.ceil(Number(seconds) || 0));
  if (total <= 1) return "即將抵達";
  return `還有 ${formatSpan(total)}`;
}
