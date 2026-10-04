import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("the traveling cap is described as our own limit of ten", () => {
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const quota = fs.readFileSync(new URL("../shared/quota.js", import.meta.url), "utf8");
  for (const text of [readme, quota]) {
    assert.match(text, /參考 Postcrossing，上限 10 封/);
    assert.doesNotMatch(text, /照 Postcrossing 規則/);
    assert.doesNotMatch(text, /對照 Postcrossing/);
  }
  assert.match(readme, /100 封/);
});
