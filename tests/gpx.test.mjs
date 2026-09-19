import { test } from "node:test";
import assert from "node:assert/strict";
import { decode, tokenize, parseGpx, splitDrives, continueCounters } from "../stats/gpx.js";
import { gpxLog, steadyDrive } from "./gpx-builder.mjs";

test("decode handles named and numeric references", () => {
  assert.equal(decode("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;&#10;f&#x41;"), `a & b <c> "d" 'e'\nfA`);
});

test("tokenize reports tags, attributes and text in order", () => {
  const seen = [];
  tokenize(`<?xml version="1.0"?><!-- c --><a x="1" y='&amp;'><b/>hi<![CDATA[<raw>]]></a>`, {
    onOpen: (name, attrs, selfClosing) => seen.push(["open", name, attrs, selfClosing]),
    onText: text => text.trim() && seen.push(["text", text]),
    onClose: name => seen.push(["close", name]),
  });
  assert.deepEqual(seen, [
    ["open", "a", { x: "1", y: "&" }, false], ["open", "b", {}, true], ["close", "b"],
    ["text", "hi"], ["text", "<raw>"], ["close", "a"],
  ]);
});

test("parseGpx reads points, readings, cells, key, vehicle and events", () => {
  const points = steadyDrive({ seconds: 2 });
  points[0].ele = 150.5;
  points[0].cells = [4.1, 4.2];
  points[1].cells = [4.1, 4.2];
  Object.assign(points[2], { name: "Charge low", desc: "line one\nline two & more", type: "soc" });
  const log = parseGpx(gpxLog({ points, fields: { power_kw: ["Power", "kW"] }, vehicle: "honda-e" }));
  assert.equal(log.n, 3);
  assert.equal(log.vehicle, "honda-e");
  assert.equal(log.name, "test drive");
  assert.equal(log.t[1] - log.t[0], 1000);
  assert.equal(log.lat[0], 48.1);
  assert.equal(log.cols.ele[0], 150.5);
  assert.ok(Number.isNaN(log.cols.ele[1]));
  assert.equal(log.cols.speed_kmh[2], 36);
  assert.equal(log.cols.gps_speed[0], 36);
  assert.deepEqual([...log.cells[0]], [4.1, 4.2]);
  assert.equal(log.cells[0], log.cells[1], "identical cell text shares one array, as in the player");
  assert.equal(log.cells[2], null);
  assert.deepEqual(log.key.power_kw, { label: "Power", unit: "kW" });
  assert.deepEqual(log.carEvents, [{ i: 2, name: "Charge low", desc: "line one\nline two & more", type: "soc" }]);
});

test("point names are events only in a file with an ev:field key", () => {
  const points = steadyDrive({ seconds: 1 });
  Object.assign(points[1], { name: "Lap", type: "user" });
  assert.deepEqual(parseGpx(gpxLog({ points })).carEvents, []);
});

test("the ev namespace is found under any prefix", () => {
  const log = parseGpx(gpxLog({ points: steadyDrive({ seconds: 1 }), prefix: "x" }));
  assert.equal(log.cols.power_kw[0], 5);
  assert.equal(log.vehicle, "test-car");
});

test("a bare GPX 1.0 speed is read as m/s", () => {
  const xml = `<gpx xmlns="http://www.topografix.com/GPX/1/0"><trk><trkseg>` +
    `<trkpt lat="1" lon="2"><time>2026-09-14T07:00:00Z</time><speed>10</speed></trkpt>` +
    `<trkpt lat="1" lon="2.0001"><time>2026-09-14T07:00:01Z</time><speed>12.5</speed></trkpt>` +
    `</trkseg></trk></gpx>`;
  assert.deepEqual([...parseGpx(xml).cols.gps_speed], [36, 45]);
});

test("parseGpx rejects too few points and broken XML", () => {
  assert.throws(() => parseGpx(gpxLog({ points: steadyDrive({ seconds: 0 }) })), /fewer than two track points/);
  assert.throws(() => parseGpx(`<gpx><trk><trkseg><trkpt lat="1" lon="2"></trkseg></trk></gpx>`), /not a readable GPX file/);
  assert.throws(() => parseGpx(`<gpx><trk>`), /not a readable GPX file/);
});

test("splitDrives drops the lone point before a charge hidden in a gap", () => {
  const start = Date.UTC(2026, 8, 13, 14, 0, 0);
  const lead = { t: start, lat: 48.1, lon: 17.1, ev: { soc_percent: 47 } };
  const drive = steadyDrive({ start: start + 29 * 60000, seconds: 120, ev: k => ({ soc_percent: 85 - k / 100 }) });
  const parts = splitDrives(parseGpx(gpxLog({ points: [lead, ...drive] })));
  assert.equal(parts.length, 1);
  assert.equal(parts[0].n, 121);
  assert.equal(parts[0].offset, 1);
  assert.equal(parts[0].t[0], start + 29 * 60000);
  assert.equal(parts[0].cols.soc_percent[0], 85);
});

test("splitDrives keeps a short stop, cuts at a short charge and around charging points", () => {
  const a = steadyDrive({ seconds: 60, ev: () => ({ soc_percent: 40 }) });
  const stop = steadyDrive({ start: a[60].t + 3 * 60000, seconds: 60, ev: () => ({ soc_percent: 40 }) });
  const charged = steadyDrive({ start: stop[60].t + 4 * 60000, seconds: 60, ev: () => ({ soc_percent: 52 }) });
  const plugged = steadyDrive({ start: charged[60].t + 1000, seconds: 5, ev: () => ({ soc_percent: 52, charging: 1 }) });
  const after = steadyDrive({ start: plugged[5].t + 1000, seconds: 60, ev: () => ({ soc_percent: 60 }) });
  Object.assign(after[10], { name: "Recording resumed", type: "resumed" });
  const parts = splitDrives(parseGpx(gpxLog({
    points: [...a, ...stop, ...charged, ...plugged, ...after], fields: { soc_percent: ["SoC", "%"] },
  })));
  // 3 min parked is the same drive; 4 min with 12 points more is a charge; charging points belong to no drive
  assert.deepEqual(parts.map(p => p.n), [122, 61, 61]);
  assert.deepEqual(parts[2].carEvents.map(e => e.i), [10]);
});

const rounded = a => [...a].map(v => Math.round(v * 1e4) / 1e4);

test("counters carry on where they fall - the app restarted", () => {
  const points = steadyDrive({ seconds: 5, ev: k => ({
    energy_kwh: k < 3 ? 1 + k / 10 : (k - 3) / 10,
    energy_regen_kwh: k < 3 ? 0.5 : 0,
  }) });
  const log = parseGpx(gpxLog({ points }));
  assert.deepEqual(continueCounters(log), [3]);
  assert.deepEqual(rounded(log.cols.energy_kwh), [1, 1.1, 1.2, 1.2, 1.3, 1.4]);
  assert.deepEqual(rounded(log.cols.energy_regen_kwh), [0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
});

test("a resumed event is a restart even where the new count is higher", () => {
  const points = steadyDrive({ seconds: 5, ev: k => ({
    energy_kwh: k < 3 ? 1 + k / 10 : 5 + (k - 3) / 10,
    energy_regen_kwh: k < 3 ? 0.5 : 2,
  }) });
  Object.assign(points[3], { name: "Recording resumed", type: "resumed" });
  const log = parseGpx(gpxLog({ points, fields: { energy_kwh: ["Energy", "kWh"] } }));
  assert.deepEqual(continueCounters(log), [3]);
  assert.deepEqual(rounded(log.cols.energy_kwh), [1, 1.1, 1.2, 1.2, 1.3, 1.4]);
  assert.deepEqual(rounded(log.cols.energy_regen_kwh), [0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
});

test("without a regen counter a falling energy counter is regen, not a restart", () => {
  const values = [1, 1.1, 1.05, 1.1];
  const log = parseGpx(gpxLog({ points: steadyDrive({ seconds: 3, ev: k => ({ energy_kwh: values[k] }) }) }));
  assert.deepEqual(continueCounters(log), []);
  assert.deepEqual(rounded(log.cols.energy_kwh), values);
});

test("splitDrives does not compare the charge across a drive it already closed", () => {
  const a = steadyDrive({ seconds: 60, ev: () => ({ soc_percent: 40 }) });
  const plugged = steadyDrive({ start: a[60].t + 1000, seconds: 4, ev: () => ({ soc_percent: 40, charging: 1 }) });
  const first = steadyDrive({ start: plugged[4].t + 1000, seconds: 20 });                                  // no charge reading yet
  const rest = steadyDrive({ start: first[20].t + 90000, seconds: 60, ev: () => ({ soc_percent: 60 }) });  // 90 s stop, then readings
  const parts = splitDrives(parseGpx(gpxLog({ points: [...a, ...plugged, ...first, ...rest] })));
  assert.deepEqual(parts.map(p => p.n), [61, 82]);
});
