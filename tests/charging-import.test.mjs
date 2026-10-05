import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../statistics.html", import.meta.url), "utf8");

test("failed share imports keep only the failed inbox entries for retry", () => {
  assert.match(html, /const failed = new Set\(\)/);
  assert.match(html, /failed\.add\(k\)/);
  assert.match(html, /keys\.filter\(\(_, index\) => !failed\.has\(index\)\)/);
});

test("folder drops accept charging CSV by extension, independent of filename", () => {
  assert.match(html, /files\.filter\(f => \/\\\.gpx\$\/i\.test\(f\.name\) \|\| \/\\\.csv\$\/i\.test\(f\.name\)\)/);
});

test("import status reports charging additions and isolates invalid CSV files", () => {
  assert.match(html, /addedCharges \? `, \$\{plural\(addedCharges, "charging session"\)\}`/);
  assert.match(html, /if \(\/\\\.csv\$\/i\.test\(f\.name\)\) \{ failed\.add\(k\); addError/);
});
