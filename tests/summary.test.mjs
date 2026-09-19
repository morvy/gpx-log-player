import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGpx, continueCounters } from "../stats/gpx.js";
import { SUMMARY_VERSION, summarize, overlapping, fuller, visible, readable } from "../stats/summary.js";
import { gpxLog, steadyDrive } from "./gpx-builder.mjs";

const near = (actual, expected, tolerance) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
const summaryOf = (points, options = {}) => {
  const log = parseGpx(gpxLog({ points, ...options }));
  continueCounters(log);
  return summarize(log, { id: "abc:0", fileId: "abc", file: "drive.gpx" });
};

test("a steady drive: distance, time, energy from the counters, conditions", () => {
  const s = summaryOf(steadyDrive({ seconds: 600, ev: k => ({
    energy_kwh: 5 * k / 3600, energy_regen_kwh: 0, soc_percent: 80 - k / 100, outside_temp_c: 20,
    battery_temp_c: 25 + k / 600, aux_12v_v: 12.6, soh_percent: 89.4, aircon: k < 300 ? 1 : 0,
  }) }), { vehicle: "honda-e" });
  assert.equal(s.version, SUMMARY_VERSION);
  assert.equal(s.id, "abc:0");
  assert.equal(s.fileId, "abc");
  assert.equal(s.file, "drive.gpx");
  assert.equal(s.vehicle, "honda-e");
  assert.equal(s.points, 601);
  assert.equal(s.seconds, 600);
  assert.equal(s.moving, 600);
  near(s.km, 6, 0.001);
  near(s.energy, 3000 / 3600, 1e-9);
  near(s.out, 3000 / 3600, 1e-9);
  assert.equal(s.regen, 0);
  near(s.per100, 13.889, 0.01);
  assert.equal(s.socStart, 80);
  assert.equal(s.socEnd, 74);
  assert.equal(s.socMin, 74);
  assert.equal(s.outsideTemp, 20);
  assert.equal(s.packTempStart, 25);
  assert.equal(s.packTempEnd, 26);
  near(s.acShare, 300 / 601, 1e-9);
  assert.equal(s.aux12vStart, 12.6);
  assert.equal(s.soh, 89.4);
  assert.equal(s.startLat, 48.1);
  // Driving seconds are counted per hour of the driver's own day, so the hour asked for is the one this
  // machine puts the drive in - the rule, not one time zone's answer. Offsets are whole quarter hours,
  // so ten minutes from 07:00 UTC never crosses a local hour wherever it is run.
  assert.equal(s.hourSeconds[new Date(Date.UTC(2026, 8, 14, 7, 0, 0)).getHours()], 600);
});

test("without energy counters, energy and regen come from power over time", () => {
  const s = summaryOf(steadyDrive({ seconds: 600, ev: k => ({ power_kw: k < 300 ? 10 : -4 }) }));
  // 299 one-second steps at 10 kW, one at (10 - 4) / 2 = 3 kW, 300 at -4 kW
  near(s.out, 2993 / 3600, 1e-9);
  near(s.regen, 1200 / 3600, 1e-9);
  near(s.energy, 1793 / 3600, 1e-9);
  assert.equal(s.socStart, null);
  assert.equal(s.acShare, null);
  assert.equal(s.outsideTemp, null);
});

test("counters with no reading for this drive fall back to power", () => {
  // energy_kwh/energy_regen_kwh columns exist (splitDrives sliced them in) but are all NaN here - absent, not zero.
  const s = summaryOf(steadyDrive({ seconds: 600, ev: () => ({ power_kw: 10, energy_kwh: NaN, energy_regen_kwh: NaN }) }));
  near(s.energy, 6000 / 3600, 1e-9);
  near(s.out, 6000 / 3600, 1e-9);
  assert.equal(s.regen, 0);
});

test("without power, power is pack voltage times current", () => {
  const s = summaryOf(steadyDrive({ seconds: 600, powerKw: null, ev: () => ({ pack_voltage_v: 400, current_a: 25 }) }));
  near(s.out, 6000 / 3600, 1e-9);
});

test("overlapping finds every stored copy of the same drive", () => {
  const a = { id: "a", start: 1000, end: 5000 }, b = { id: "b", start: 6000, end: 9000 };
  // A long trip log covers several shorter live logs of the same driving.
  assert.deepEqual(overlapping([a, b], { id: "c", start: 4000, end: 7000 }), [a, b]);
  assert.deepEqual(overlapping([a, b], { id: "c", start: 5000, end: 6000 }), []);
  assert.deepEqual(overlapping([a], a), []);
});

test("fuller keeps the copy with the car's readings, then the one with more points", () => {
  const gps = { energy: null, socStart: null, points: 828 };
  const car = { energy: 5.8, socStart: 85, points: 826 };
  assert.ok(fuller(car, gps) > 0, "readings from the car beat GPS alone, even with fewer points");
  assert.ok(fuller(gps, car) < 0);
  assert.ok(fuller({ ...car, points: 900 }, car) > 0);
  assert.equal(fuller(car, { ...car }), 0);
});

test("visible counts the fullest copy of each stretch of driving, whatever order the files came in", () => {
  const live1 = { id: "live1", start: 0, end: 100, energy: 1, socStart: 50, points: 100 };
  const live2 = { id: "live2", start: 200, end: 300, energy: null, socStart: null, points: 90 };
  const trip = { id: "trip", start: 0, end: 300, energy: null, socStart: null, points: 300 };
  for (const order of [[live1, live2, trip], [trip, live2, live1], [live2, trip, live1]]) {
    assert.deepEqual(visible(order).map(s => s.id).sort(), ["live1", "live2"]);
  }
  assert.deepEqual(visible([{ ...live1, id: "thinner", points: 90 }, live1]).map(s => s.id), ["live1"]);
});

test("equal copies are decided by id, so the shown copy never depends on load order", () => {
  const a = { id: "a:0", start: 0, end: 100, energy: 1, socStart: 50, points: 100 };
  const b = { ...a, id: "b:0" };
  assert.deepEqual(visible([a, b]).map(s => s.id), ["a:0"]);
  assert.deepEqual(visible([b, a]).map(s => s.id), ["a:0"]);
});

test("a drive without times or positions is not readable", () => {
  const drive = { start: 0, end: 60000, km: 1 };
  assert.equal(readable(drive), true);
  assert.equal(readable({ ...drive, start: NaN }), false);
  assert.equal(readable({ ...drive, km: NaN }), false);
});

test("a summary carries the drive's episodes, or null without power", () => {
  const withPower = summaryOf(steadyDrive({ seconds: 60 }));
  assert.equal(SUMMARY_VERSION, 6);
  assert.deepEqual(Object.keys(withPower.episodes), ["up", "down"]);
  assert.equal(withPower.episodes.up.v0.length, 0);
  const without = summaryOf(steadyDrive({ seconds: 60 }).map(p => ({ ...p, ev: { speed_kmh: p.ev.speed_kmh } })));
  assert.equal(without.episodes, null);
});
