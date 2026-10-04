import assert from "node:assert/strict";
import test from "node:test";
import {
  DRAFT_DISCARD_CONFIRM,
  DRAFT_IMAGE_LIMIT,
  DRAFT_RESUME_PROMPT,
  draftImageDecision,
} from "../shared/draft.js";

test("the draft prompts say what happens to an unfinished letter", () => {
  assert.equal(DRAFT_RESUME_PROMPT, "還有一封沒寄出的信，要接著寫嗎？");
  assert.match(DRAFT_DISCARD_CONFIRM, /確定丟掉/);
  assert.match(DRAFT_DISCARD_CONFIRM, /筆跡和照片都會消失/);
});

test("a large letter face is shrunk before the browser store gives up", () => {
  assert.deepEqual(draftImageDecision(1000, 0.86), { action: "store", quality: 0.86 });
  assert.deepEqual(draftImageDecision(DRAFT_IMAGE_LIMIT + 1, 0.86), { action: "shrink", quality: 0.6 });
  assert.deepEqual(draftImageDecision(DRAFT_IMAGE_LIMIT + 1, 0.6), { action: "shrink", quality: 0.4 });
  assert.deepEqual(draftImageDecision(DRAFT_IMAGE_LIMIT + 1, 0.4), { action: "drop-image", quality: 0.4 });
});
