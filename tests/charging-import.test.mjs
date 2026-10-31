import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../statistics.html", import.meta.url), "utf8");

test("folder drops accept charging CSV by extension, independent of filename", () => {
  assert.match(html, /files\.filter\(f => \/\\\.gpx\$\/i\.test\(f\.name\) \|\| \/\\\.csv\$\/i\.test\(f\.name\)\)/);
});
