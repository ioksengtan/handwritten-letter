import assert from "node:assert/strict";
import test from "node:test";
import { contactRefusal, findContactKinds } from "../shared/contact.js";

test("ordinary letter text can be posted", () => {
  const samples = [
    "",
    "今天天氣很好，想跟你說聲你好。",
    "台北到倫敦要十天。",
    "我喜歡寫信，也喜歡郵票。",
    "2026 年秋天",
    "還有 5 封",
    "預計 10 月 14 日抵達",
    "coastline",
    "online",
    "小紙",
  ];
  for (const sample of samples) {
    assert.deepEqual(findContactKinds(sample), [], sample);
  }
});

test("phone, email, url, and social accounts are named before posting", () => {
  assert.deepEqual(findContactKinds("請打 0912-345-678"), ["phone"]);
  assert.deepEqual(findContactKinds("手機 0912345678"), ["phone"]);
  assert.deepEqual(findContactKinds("國外號碼 +886 912 345 678"), ["phone"]);
  assert.deepEqual(findContactKinds("+1 (415) 555-2671"), ["phone"]);
  assert.deepEqual(findContactKinds("全形 ０９１２３４５６７８"), ["phone"]);
  assert.deepEqual(findContactKinds("寫到 hello@example.com"), ["email"]);
  assert.deepEqual(findContactKinds("網站 https://example.com/hi"), ["url"]);
  assert.deepEqual(findContactKinds("看 www.example.com"), ["url"]);
  assert.deepEqual(findContactKinds("網址 example.com"), ["url"]);
  assert.deepEqual(findContactKinds("找我 @paper_bird"), ["social"]);
  assert.deepEqual(findContactKinds("我的 LINE 是 abcde"), ["social"]);
  assert.deepEqual(findContactKinds("line id: postcard"), ["social"]);
  assert.deepEqual(findContactKinds("加賴"), ["social"]);
  assert.deepEqual(findContactKinds("IG: postcardfan"), ["social"]);
  assert.deepEqual(findContactKinds("微信 abc123"), ["social"]);

  const both = findContactKinds("信箱 a@b.co 還有 https://example.com/0912345678");
  assert.deepEqual(both, ["email", "url"]);
  assert.equal(both.includes("phone"), false);

  const letter = contactRefusal("請打 0912-345-678，信箱 a@b.co");
  assert.match(letter.error, /電話號碼/);
  assert.match(letter.error, /電子郵件/);
  assert.match(letter.error, /請拿掉再寄/);
  assert.equal(letter.error.includes("扔"), false);

  const nickname = contactRefusal("@paper", { subject: "nickname" });
  assert.match(nickname.error, /暱稱不能有社群帳號/);
  assert.equal(nickname.messages.length, 1);
});
