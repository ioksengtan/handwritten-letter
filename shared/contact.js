/**
 * Text fields on a letter are checked before it can be posted.
 * Pictures are not read. This only looks at the words the sender typed.
 */

const NOUN = {
  phone: "電話號碼",
  email: "電子郵件",
  url: "網址",
  social: "社群帳號",
};

const EMAIL = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;
const URL = /(?:https?:\/\/|www\.)\S+|(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+(?:com|net|org|tw|jp|kr|hk|io|me|app|dev|uk|de|fr|info|xyz|site|link|co)\b/gi;
const PHONE = /\+?\d[\d\s().-]{6,}\d/g;
const HANDLE = /(^|[^\w@])@[a-z0-9._]{2,30}(?![a-z0-9._@])/i;
const LINE_WORD = /\bLINE\b/;
const LINE_ID = /line\s*(?:id|帳號)\b|line\s*[:：]\s*[a-z0-9._-]{3,}|加賴|賴\s*[:：]\s*[a-z0-9._-]{3,}/i;
const PLATFORM = /(?:微信|wechat|instagram|discord|telegram|whatsapp|facebook|臉書|tiktok|抖音|threads|snapchat|reddit|推特|小紅書|ig)\s*[:：]?\s*[a-z0-9._-]{3,}/i;

function fold(text) {
  return String(text || "").replace(/[\uFF01-\uFF5E]/g, (ch) => (
    String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
  ));
}

function looksLikeCalendarDay(digits) {
  if (digits.length !== 8 || !/^20|^19/.test(digits)) return false;
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function hasPhone(text) {
  const matches = text.match(PHONE) || [];
  return matches.some((token) => {
    const digits = token.replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) return false;
    if (looksLikeCalendarDay(digits)) return false;
    return true;
  });
}

function hasSocial(text) {
  return HANDLE.test(text) || LINE_WORD.test(text) || LINE_ID.test(text) || PLATFORM.test(text);
}

/** Stable order: phone, email, url, social. Empty when the text can be posted. */
export function findContactKinds(text) {
  const folded = fold(text);
  if (!folded.trim()) return [];
  const withoutEmail = folded.replace(EMAIL, " ");
  const withoutUrl = withoutEmail.replace(URL, " ");
  const found = new Set();
  if (withoutEmail !== folded) found.add("email");
  if (withoutUrl !== withoutEmail) found.add("url");
  if (hasPhone(withoutUrl)) found.add("phone");
  if (hasSocial(withoutEmail)) found.add("social");
  return ["phone", "email", "url", "social"].filter((kind) => found.has(kind));
}

/**
 * @param {"letter"|"nickname"} subject
 * Letter copy is shown before the counter slip. Nickname copy is for the first visit.
 */
export function contactRefusal(text, { subject = "letter" } = {}) {
  const kinds = findContactKinds(text);
  const messages = kinds.map((kind) => {
    if (subject === "nickname") return `暱稱不能有${NOUN[kind]}。`;
    return `這封信裡有${NOUN[kind]}，請拿掉再寄。`;
  });
  return {
    kinds,
    messages,
    error: messages.join(""),
  };
}
