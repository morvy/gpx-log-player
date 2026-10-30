import { test } from "node:test";
import assert from "node:assert/strict";
import { wanted, unseen, listLogs, syncLogs } from "../stats/drive.js";

test("only drive logs and charging sessions are fetched", () => {
  assert.ok(wanted("gpx-20261030-195017.gpx"));
  assert.ok(wanted("gpx-20261030-195017-conflict-c43d1.gpx"));
  assert.ok(wanted("charging-20261029-183055-1793295055828.csv"));
  for (const name of ["raw-20261030-192813.csv", "capture-20261030-194354.txt", "trip-20261030-192813.csv", "cellsdrive-20261030-1.csv"]) assert.ok(!wanted(name), name);
});

test("new files come oldest first, and a changed file is new again", () => {
  const files = [
    { id: "b", name: "gpx-2.gpx", md5Checksum: "2" }, { id: "a", name: "gpx-1.gpx", md5Checksum: "1" },
    { id: "c", name: "gpx-3.gpx", md5Checksum: "new" }, { id: "r", name: "raw-1.csv", md5Checksum: "r" },
  ];
  assert.deepEqual(unseen(files, { b: "2", c: "old" }).map(f => f.id), ["a", "c"]);
});

/** A Drive that holds [files] in one folder, [broken] ids failing with a 500. */
function fakeDrive(files, { broken = [], pageSize = 1000 } = {}) {
  const asked = [];
  globalThis.fetch = async (url, { headers }) => {
    assert.equal(headers.Authorization, "Bearer t");
    const u = new URL(url);
    asked.push(u.pathname + u.search);
    const json = body => ({ ok: true, json: async () => body });
    const q = u.searchParams.get("q");
    if (q?.includes("mimeType")) return json({ files: [{ id: "folder" }] });
    if (q) {
      const from = Number(u.searchParams.get("pageToken") ?? 0), to = from + pageSize;
      return json({ files: files.slice(from, to), nextPageToken: to < files.length ? String(to) : undefined });
    }
    const id = u.pathname.split("/").pop();
    return broken.includes(id) ? { ok: false, status: 500 } : { ok: true, text: async () => `text of ${id}` };
  };
  return asked;
}

test("a long folder is read to its last page", async () => {
  const files = Array.from({ length: 5 }, (_, k) => ({ id: `f${k}`, name: `gpx-${k}.gpx`, md5Checksum: "m" }));
  fakeDrive(files, { pageSize: 2 });
  assert.equal((await listLogs("t")).length, 5);
});

test("a file read is seen whatever came of it; one that failed to fetch waits for the next sync", async () => {
  const files = Array.from({ length: 12 }, (_, k) => ({ id: `f${k}`, name: `gpx-${String(k).padStart(2, "0")}.gpx`, md5Checksum: "m" }));
  fakeDrive(files, { broken: ["f3"] });
  const added = [], kept = [];
  const seen = { f0: "m" };
  const result = await syncLogs({ token: "t", seen, add: async got => added.push(...got.map(f => f.name)), keep: async s => kept.push(Object.keys(s).length) });
  assert.deepEqual(result, { found: 11, unread: 1 });
  assert.equal(added.length, 10);
  assert.ok(!added.includes("gpx-00.gpx"));
  assert.equal(seen.f3, undefined);
  assert.equal(kept.length, 2, "stored after each chunk");
  assert.deepEqual((await syncLogs({ token: "t", seen, add: async () => {}, keep: async () => {} })), { found: 1, unread: 1 });
});

test("a Drive that refuses the listing says so", async () => {
  globalThis.fetch = async () => ({ ok: false, status: 401 });
  await assert.rejects(listLogs("t"), /401/);
});
