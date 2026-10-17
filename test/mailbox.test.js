import assert from "node:assert/strict";
import test from "node:test";
import { awaitsReceipt, flyingNotice, WAITING_RECEIPT } from "../shared/mailbox.js";

test("a flying letter is announced with the day, and only real recipients wait to register", () => {
  assert.equal(flyingNotice("10 月 20 日"), "有一封信正在飛來，預計 10 月 20 日抵達。");
  assert.equal(flyingNotice(""), "有一封信正在飛來。");
  assert.equal(flyingNotice("   "), "有一封信正在飛來。");
  assert.equal(WAITING_RECEIPT, "已到信箱，等待對方拆收");
  assert.equal(awaitsReceipt({ to: { demo: false } }), true);
  assert.equal(awaitsReceipt({ to: { demo: true } }), false);
  assert.equal(awaitsReceipt({ to: { name: "Ellen" } }), false);
  assert.equal(awaitsReceipt({}), false);
});
