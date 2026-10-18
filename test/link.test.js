import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { findCity } from "../shared/recipients.js";
import { planCourier } from "../shared/route.js";
import { planFriendLetter, normalizeFriendName } from "../shared/friend.js";
import {
  FRIEND_OPEN_MS,
  assignLetterLinks,
  friendOpenState,
  isPublicToken,
  mintToken,
  mintUniqueToken,
  projectFriendOpen,
  sharePublished,
} from "../shared/link.js";
import { shareCardModel, shareCardSvg } from "../lib/card.js";

const taipei = findCity("taipei");

describe("friend address", () => {
  test("a name is a short line of writing, not markup", () => {
    assert.equal(normalizeFriendName("  小安  "), "小安");
    assert.equal(normalizeFriendName("阿橘"), "阿橘");
    assert.equal(normalizeFriendName(""), null);
    assert.equal(normalizeFriendName("   "), null);
    assert.equal(normalizeFriendName("a".repeat(25)), null);
    assert.equal(normalizeFriendName("小<安>"), null);
    assert.equal(normalizeFriendName("小\n安"), null);
  });

  test("flight time follows the real distance to the friend's city", () => {
    const planned = planFriendLetter({
      from: taipei,
      cityId: "london",
      friendName: "阿橘",
    });
    assert.equal(planned.error, undefined);
    assert.equal(planned.audience, "friend");
    assert.equal(planned.to.name, "阿橘");
    assert.equal(planned.to.city, "倫敦");
    assert.equal(planned.to.kind, "friend");
    assert.equal(planned.pace, "romantic-slow");
    const same = planCourier({
      from: taipei,
      to: planned.to,
      pace: "romantic-slow",
    });
    assert.equal(planned.durationSeconds, same.durationSeconds);
    assert.equal(planned.distanceKm, same.distanceKm);
    assert.deepEqual(planned.legs.map((leg) => leg.mode), ["pigeon"]);
    const refused = planFriendLetter({ from: taipei, cityId: "london", friendName: "a@b.co" });
    assert.match(refused.error, /電子郵件/);
    assert.deepEqual(refused.reasons, ["email"]);
    assert.equal(planFriendLetter({ from: taipei, cityId: "taipei", friendName: "阿橘" }).error, "請選擇不同的寄出地與收件地");
    assert.equal(planFriendLetter({ from: taipei, cityId: "no-such", friendName: "阿橘" }).error, "請選擇朋友所在的城市");
  });
});

describe("letter links", () => {
  test("codes are long, random, and not a sequence", () => {
    const fill = (size) => Buffer.alloc(size, 7);
    const first = mintToken(fill);
    assert.equal(isPublicToken(first), true);
    assert.equal(first.length, 43);
    assert.equal(isPublicToken("1"), false);
    assert.equal(isPublicToken("2"), false);
    assert.equal(isPublicToken("a".repeat(42)), false);
    let calls = 0;
    const second = mintUniqueToken(new Set([first]), () => {
      calls += 1;
      return Buffer.alloc(32, calls === 1 ? 7 : 8);
    });
    assert.equal(calls, 2);
    assert.notEqual(second, first);
    assert.equal(isPublicToken(second), true);
    assert.notEqual(String(Number(first) + 1), second);
    let serial = 0;
    const letter = assignLetterLinks({ audience: "friend", status: "draft" }, [], (size) => {
      serial += 1;
      return Buffer.alloc(size, serial);
    });
    assert.equal(letter.audience, "friend");
    assert.equal(isPublicToken(letter.shareToken), true);
    assert.equal(isPublicToken(letter.friendToken), true);
    assert.notEqual(letter.shareToken, letter.friendToken);
    const stranger = assignLetterLinks({ audience: "stranger" }, [letter.shareToken, letter.friendToken], (size) => Buffer.alloc(size, 9));
    assert.equal(stranger.friendToken, null);
    assert.notEqual(stranger.shareToken, letter.shareToken);
    const token = "c".repeat(43);
    assert.equal(sharePublished({ status: "awaiting_receipt", shareToken: token, departedAt: "2026-10-01T00:00:00.000Z", arrivesAt: "2026-10-02T00:00:00.000Z" }), true);
    assert.equal(sharePublished({ status: "in_flight", shareToken: token, departedAt: "2026-10-01T00:00:00.000Z", arrivesAt: "2026-10-02T00:00:00.000Z" }), true);
    assert.equal(sharePublished({ status: "draft", shareToken: token, departedAt: "2026-10-01T00:00:00.000Z", arrivesAt: "2026-10-02T00:00:00.000Z" }), false);
  });

  test("the friend link stays shut for fourteen days after arrival, then returns", () => {
    const departed = Date.parse("2026-10-01T00:00:00.000Z");
    const arrives = Date.parse("2026-10-11T00:00:00.000Z");
    const letter = {
      audience: "friend",
      status: "in_flight",
      friendToken: "a".repeat(43),
      shareToken: "b".repeat(43),
      senderId: "browser-sender",
      id: "mailbox-id",
      imageFile: "secret-face.png",
      from: { ...taipei, name: "台北" },
      to: { id: "london", name: "阿橘", city: "倫敦", cityId: "london", country: "英國", lat: 51.5074, lng: -0.1278, kind: "friend" },
      distanceKm: 9781,
      durationSeconds: (arrives - departed) / 1000,
      departedAt: new Date(departed).toISOString(),
      arrivesAt: new Date(arrives).toISOString(),
      deliveredAt: null,
      pace: "romantic-slow",
    };
    assert.equal(friendOpenState(letter, departed + 1000), "traveling");
    const flying = projectFriendOpen(letter, departed + 1000);
    assert.equal(flying.state, "traveling");
    assert.equal(flying.imageUrl, null);
    assert.equal(flying.to.name, "阿橘");
    assert.equal(flying.to.city, "倫敦");
    const flyingJson = JSON.stringify(flying);
    assert.equal(flyingJson.includes("secret-face.png"), false);
    assert.equal(flyingJson.includes("browser-sender"), false);
    assert.equal(flyingJson.includes("mailbox-id"), false);

    const arrivedLetter = {
      ...letter,
      status: "delivered",
      deliveredAt: new Date(arrives).toISOString(),
    };
    assert.equal(friendOpenState(arrivedLetter, arrives), "arrived");
    assert.equal(friendOpenState(arrivedLetter, arrives + FRIEND_OPEN_MS), "arrived");
    const open = projectFriendOpen(arrivedLetter, arrives + 1000);
    assert.equal(open.state, "arrived");
    assert.equal(open.imageUrl, `/api/open/${letter.friendToken}/image`);
    assert.equal(friendOpenState(arrivedLetter, arrives + FRIEND_OPEN_MS + 1), "returned");
    const returned = projectFriendOpen(arrivedLetter, arrives + FRIEND_OPEN_MS + 1);
    assert.equal(returned.state, "returned");
    assert.equal(returned.note, "這封信已經退回郵局");
    assert.equal(JSON.stringify(returned).includes("阿橘"), false);
    assert.equal(JSON.stringify(returned).includes("secret-face"), false);

    const card = shareCardModel(letter, departed + (arrives - departed) / 2);
    assert.equal(card.fromCity, "台北");
    assert.equal(card.toCity, "倫敦");
    assert.equal(card.daysText.includes("天"), true);
    const svg = shareCardSvg(card);
    assert.equal(svg.includes("阿橘"), false);
    assert.equal(svg.includes("secret-face"), false);
    assert.equal(svg.includes("台北"), true);
    assert.equal(svg.includes("倫敦"), true);
    assert.equal(svg.includes("<image"), false);
  });
});
