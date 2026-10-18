/** Copy for the mailbox and for a letter that has landed but is not registered yet. */

export const WAITING_RECEIPT = "已到信箱，等待對方拆收";
export const DEMO_LABEL = "這是示範收件人";

/** `dayText` is already a calendar day, such as "10 月 20 日". */
export function flyingNotice(dayText) {
  const day = String(dayText || "").trim();
  if (!day) return "有一封信正在飛來。";
  return `有一封信正在飛來，預計 ${day}抵達。`;
}

/** Real recipients register the letter. Demo and older letters do not. */
export function awaitsReceipt(letter) {
  return letter?.to?.demo === false;
}
