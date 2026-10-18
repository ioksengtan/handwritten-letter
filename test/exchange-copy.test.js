import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("the first visit, mailbox, and safety lines are written out in full", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const mailbox = fs.readFileSync(new URL("../shared/mailbox.js", import.meta.url), "utf8");
  const page = `${html}\n${app}\n${mailbox}`;
  assert.match(page, /我已滿 16 歲/);
  assert.match(page, /未滿 16 歲不能使用/);
  assert.match(page, /這是示範收件人/);
  assert.match(page, /我的信箱/);
  assert.match(page, /已收到/);
  assert.match(page, /檢舉/);
  assert.match(page, /封鎖/);
  assert.match(page, /已到信箱，等待對方拆收/);
  assert.match(page, /有一封信正在飛來/);
  assert.equal(page.includes("扔"), false);
});
