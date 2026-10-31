import { test } from "node:test";
import assert from "node:assert/strict";
import { importLogs } from "../stats/importing.js";
import { sessionCopies } from "../stats/charging-csv.js";

const csv = ({ ended = "2026-09-23T19:05:00Z", points = 2, id = "s1" } = {}) => `format_version,1
vehicle,honda-e
session_id,${id}
started_at,2026-09-23T18:15:00Z
ended_at,${ended}
soc_from,31.0
soc_to,70.0
kwh_added,18.42
seconds,3000
peak_kw,52.1
charge_s,charge_kw,soc_pct,observed
${Array.from({ length: points }, (_, k) => `${k},49.2,31.0,true`).join("\n")}
`;

/** A store that remembers what reached it; [full] refuses every write, as a full disk does. */
function world({ full = false, summarize } = {}) {
  const stored = new Map(), errors = [];
  return {
    stored, errors, summaries: [], logged: [],
    change: async ops => {
      if (full) throw new Error("QuotaExceededError");
      for (const op of ops) if ("value" in op) stored.set(`${op.store}/${op.key}`, op.value); else stored.delete(`${op.store}/${op.key}`);
    },
    summarize: summarize ?? (async name => ({ fileId: name, summaries: [{ id: `${name}:0`, fileId: name }] })),
    refused: (name, message) => errors.push(`${name}: ${message}`),
  };
}

test("a drive is stored with its file, and the same file again is only counted", async () => {
  const w = world();
  const first = await importLogs([{ name: "a.gpx", text: "<gpx/>" }], w);
  assert.deepEqual(first.fresh, ["a.gpx:0"]);
  assert.ok(w.stored.has("files/a.gpx") && w.stored.has("summaries/a.gpx:0"));
  const again = await importLogs([{ name: "a.gpx", text: "<gpx/>" }], w);
  assert.deepEqual(again.fresh, []);
  assert.equal(again.skipped, 1);
});

test("a file that is no log is refused for good, one that met a full disk is handed back", async () => {
  const bad = world({ summarize: async name => ({ name, error: "no drive" }) });
  const refused = await importLogs([{ name: "a.gpx", text: "x" }, { name: "b.csv", text: "x" }], bad);
  assert.equal(refused.retry.size, 0);
  assert.equal(bad.errors.length, 2);

  const full = world({ full: true });
  const handedBack = await importLogs([{ name: "a.gpx", text: "x" }, { name: "c.csv", text: csv() }], full);
  assert.deepEqual([...handedBack.retry], [0, 1]);
  assert.equal(full.summaries.length, 0, "nothing counted that was not stored");
  assert.equal(full.logged.length, 0);
});

test("a crashed worker says nothing about the file, a malformed session does", async () => {
  const crashed = world({ summarize: async name => ({ name, error: "out of memory", crashed: true }) });
  assert.deepEqual([...(await importLogs([{ name: "a.gpx", text: "x" }], crashed)).retry], [0]);
  const malformed = world();
  const r = await importLogs([{ name: "c.csv", text: csv().replace("31.0,true", "nope,true") }], malformed);
  assert.equal(r.retry.size, 0);
  assert.equal(malformed.errors.length, 1);
});

test("a charging session rewritten as it ran is kept once, as its fullest copy, in either order", async () => {
  const partial = { name: "c.csv", text: csv({ ended: "", points: 2 }) }, final = { name: "c.csv", text: csv({ points: 5 }) };
  for (const order of [[partial, final], [final, partial]]) {
    const w = world();
    for (const f of order) await importLogs([f], w);
    assert.equal(w.logged.length, 1);
    assert.equal(w.logged[0].points.length, 5);
    assert.equal([...w.stored.keys()].filter(k => k.startsWith("charges/")).length, 1);
  }
  const w = world();
  await importLogs([{ name: "a.csv", text: csv({ id: "s1" }) }, { name: "b.csv", text: csv({ id: "s2" }) }], w);
  assert.equal(w.logged.length, 2, "two sessions are two sessions");
});

test("copies stored before sessions had an identity are picked out, leaving the fullest", () => {
  const record = (fileId, sessionId, endedAt, points) => ({ fileId, sessionId, vehicle: "e", endedAt, points: Array(points) });
  const logged = [record("old", "s1", "", 9), record("final", "s1", "x", 3), record("other", "s2", "x", 3)];
  assert.deepEqual(sessionCopies(logged).map(c => c.fileId), ["old"]);
});
