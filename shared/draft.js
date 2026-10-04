/**
 * Browser draft of a letter that has not been posted yet.
 * The picture may be large, so the page stores it in the browser database
 * and shrinks it when the write would be too big.
 */

export const DRAFT_RESUME_PROMPT = "還有一封沒寄出的信，要接著寫嗎？";
export const DRAFT_RESUME_ACTION = "接著寫";
export const DRAFT_DISCARD_ACTION = "丟棄草稿";
export const DRAFT_DISCARD_CONFIRM = "確定丟掉這封沒寄出的信？筆跡和照片都會消失。";
export const DRAFT_DISCARD_YES = "確定丟掉";
export const DRAFT_DISCARD_NO = "先留著";
export const DRAFT_SHRINK_NOTE = "圖片太大，已改存成較小的版本。";
export const DRAFT_DROP_IMAGE_NOTE = "圖片太大，筆跡這次沒能存進瀏覽器。收件人還在。";
export const DRAFT_STORE_UNAVAILABLE = "這台瀏覽器存不了沒寄出的信。寄出前先別關掉這一頁。";

/** Bytes. Above this, try a smaller picture before giving up. */
export const DRAFT_IMAGE_LIMIT = 900_000;

export const DRAFT_QUALITIES = [0.86, 0.6, 0.4];

/**
 * What to do with one attempt to store the letter face.
 * `store` keeps this quality. `shrink` tries the next smaller quality.
 * `drop-image` means even the smallest quality is too big.
 */
export function draftImageDecision(byteLength, quality) {
  const size = Math.max(0, Number(byteLength) || 0);
  const known = DRAFT_QUALITIES.includes(quality) ? quality : DRAFT_QUALITIES[0];
  if (size <= DRAFT_IMAGE_LIMIT) return { action: "store", quality: known };
  const next = DRAFT_QUALITIES[DRAFT_QUALITIES.indexOf(known) + 1];
  if (next == null) return { action: "drop-image", quality: known };
  return { action: "shrink", quality: next };
}
