import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGpx } from "../stats/gpx.js";
import { measureEpisodes, UP_FIELDS, DOWN_FIELDS } from "../stats/episodes.js";
import { gpxLog } from "./gpx-builder.mjs";

const near = (actual, expected, tolerance) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

const START = Date.UTC(2026, 8, 14, 7, 0, 0);
const DEGREE_S = 1 / 3.6 / 111194.93;   // degrees of latitude a second per km/h, on the player's 6371 km earth

/** A drive north whose speed (km/h) at second k is kmhAt(k); [ev] adds readings per second; [skip] drops seconds. */
function trace(kmhAt, seconds, ev = () => ({}), skip = () => false) {
  const points = [];
  let lat = 48.1;
  for (let k = 0; k <= seconds; k++) {
    const kmh = kmhAt(k);
    if (!skip(k)) points.push({ t: START + k * 1000, lat, lon: 17.1, ev: { speed_kmh: kmh, ...ev(k) } });
    lat += kmh * DEGREE_S;
  }
  return points;
}
const episodesOf = points => measureEpisodes(parseGpx(gpxLog({ points })));

test("a hard pull-away then a steady hold is one speed-up with its hold timed", () => {
  // Standing until second 10, 3 m/s² (10.8 km/h a second) to 54 km/h at second 15, then held.
  const speed = k => k <= 10 ? 0 : k >= 15 ? 54 : 10.8 * (k - 10);
  const e = episodesOf(trace(speed, 60, k => ({ power_kw: k >= 10 && k <= 15 ? 60 : 8 })));
  assert.deepEqual(Object.keys(e.up), UP_FIELDS);
  assert.deepEqual(Object.keys(e.down), DOWN_FIELDS);
  assert.equal(e.up.v0.length, 1);
  assert.equal(e.down.v0.length, 0);
  assert.equal(e.up.v0[0], 0);
  assert.equal(e.up.v1[0], 54);
  assert.equal(e.up.seconds[0], 5);
  near(e.up.accel[0], 3, 0.01);
  assert.equal(e.up.peakKw[0], 60);
  near(e.up.kwh[0], 60 * 5 / 3600, 0.002);
  assert.equal(e.up.holdSeconds[0], 45);
  assert.ok(!("holdKwh" in e.up));
});

test("a gentle pull-away is one long, low-acceleration speed-up", () => {
  // 1.2 km/h a second from second 10 to 54 km/h at second 55: each step is under the 2 km/h wobble.
  const speed = k => k <= 10 ? 0 : k >= 55 ? 54 : 1.2 * (k - 10);
  const e = episodesOf(trace(speed, 100, k => ({ power_kw: k >= 10 && k <= 55 ? 15 : 8 })));
  assert.equal(e.up.v0.length, 1);
  assert.equal(e.up.seconds[0], 45);
  near(e.up.accel[0], 54 / 3.6 / 45, 0.01);
});

// 72 km/h under power until second 20; coasting on light regen to 62 km/h at second 40; braking to a stop at 50.
const coasting = k => k <= 20 ? 72 : k <= 40 ? 72 - 0.5 * (k - 20) : k <= 50 ? 62 - 6.2 * (k - 40) : 0;
const coastingEv = k => ({
  power_kw: k <= 20 ? 10 : k <= 40 ? -2 : k <= 50 ? -5 : 0,
  brake_pedal: k > 40 && k <= 50 ? 1 : 0,
});
// 72 km/h under power until second 40, then straight onto the brake: 9 km/h a second to a stop at 48.
const late = k => k <= 40 ? 72 : k <= 48 ? 72 - 9 * (k - 40) : 0;
const lateEv = k => ({ power_kw: k <= 40 ? 10 : k <= 48 ? -5 : 0, brake_pedal: k > 40 && k <= 48 ? 1 : 0 });

test("lifting off early: the coasting before the pedal is the lift-off time", () => {
  const e = episodesOf(trace(coasting, 70, coastingEv));
  assert.equal(e.down.v0.length, 1);
  assert.equal(e.down.v0[0], 72);
  assert.equal(e.down.v1[0], 0);
  assert.equal(e.down.toStop[0], 1);
  assert.equal(e.down.braked[0], 1);
  assert.equal(e.down.liftSeconds[0], 21);
  assert.ok(e.down.regenKwh[0] > 0);
  assert.ok(e.down.brakeKwh[0] > 0);
  assert.ok(e.down.recoveredShare[0] > 0 && e.down.recoveredShare[0] < 1);
});

test("braking late from full speed loses more to the pads than coasting first", () => {
  const coast = episodesOf(trace(coasting, 70, coastingEv));
  const hard = episodesOf(trace(late, 70, lateEv));
  assert.equal(hard.down.v0.length, 1);
  assert.ok(hard.down.liftSeconds[0] <= 1);
  assert.ok(hard.down.brakeKwh[0] > coast.down.brakeKwh[0]);
  assert.ok(hard.down.recoveredShare[0] < coast.down.recoveredShare[0]);
});

test("a slow-down with no press has no lift-off time and no brake loss", () => {
  const e = episodesOf(trace(coasting, 70, k => ({ ...coastingEv(k), brake_pedal: 0 })));
  assert.equal(e.down.v0.length, 1);
  assert.equal(e.down.braked[0], 0);
  assert.equal(e.down.liftSeconds[0], null);
  assert.equal(e.down.brakeKwh[0], 0);
});

// 72 km/h until second 20, falling 3.2 km/h a second to 8 km/h at second 40, held there to second 44;
// then [after] from second 45. Regen through the fall, no power after it. No brake_pedal column.
const creep = after => k => k <= 20 ? 72 : k <= 40 ? 72 - 3.2 * (k - 20) : k <= 44 ? 8 : after(k);
const creepEv = k => ({ power_kw: k <= 20 ? 10 : k <= 40 ? -3 : 0 });

test("a stop that ends in a slow creep is still a stop", () => {
  // From second 45, 1 km/h a second down to 0: at or under 3 km/h by second 49, 9 s after the fall ended.
  const e = episodesOf(trace(creep(k => Math.max(0, 8 - (k - 44))), 70, creepEv));
  assert.equal(e.down.v0.length, 1);
  assert.equal(e.down.v1[0], 8);
  assert.equal(e.down.toStop[0], 1);
});

test("a creep that picks up again before stopping is not a stop", () => {
  // 9.5 then 11 km/h at seconds 45-47 - more than 2 km/h above the fall's end - then down 3 km/h a second.
  const after = k => k === 45 ? 9.5 : k <= 47 ? 11 : Math.max(0, 11 - 3 * (k - 47));
  const e = episodesOf(trace(creep(after), 70, creepEv));
  assert.equal(e.down.v0.length, 2);
  assert.equal(e.down.v1[0], 8);
  assert.deepEqual(e.down.toStop, [0, 1]);
});

test("a creep followed by silence is a stop: the track writes no point while the car stands", () => {
  // No points from second 45 to 64, then standing; and a log that ends at second 44.
  const gap = episodesOf(trace(creep(() => 0), 70, creepEv, k => k >= 45 && k < 65));
  assert.deepEqual(gap.down.toStop, [1]);
  const ends = episodesOf(trace(creep(() => 0), 44, creepEv));
  assert.deepEqual(ends.down.toStop, [1]);
  // A gap at speed is lost signal, not a stop: 72 down to 50, then nothing for 20 s.
  const fast = k => k <= 20 ? 72 : k <= 40 ? 72 - 1.1 * (k - 20) : 50;
  const tunnel = episodesOf(trace(fast, 80, creepEv, k => k >= 45 && k < 65));
  assert.deepEqual(tunnel.down.toStop, [0]);
});

test("creeping under 10 km/h is no episode", () => {
  const speed = k => k <= 10 ? 0 : k >= 15 ? 8 : 1.6 * (k - 10);
  const e = episodesOf(trace(speed, 40, () => ({ power_kw: 3 })));
  assert.equal(e.up.v0.length, 0);
  assert.equal(e.down.v0.length, 0);
});

test("a log without power has no episodes to measure", () => {
  const speed = k => k <= 10 ? 0 : k >= 15 ? 54 : 10.8 * (k - 10);
  assert.equal(episodesOf(trace(speed, 40)), null);
});

test("without the brake pedal a slow-down is kept, its pedal figures unknown", () => {
  const e = episodesOf(trace(coasting, 70, k => ({ power_kw: coastingEv(k).power_kw })));
  assert.equal(e.down.v0.length, 1);
  assert.equal(e.down.braked[0], null);
  assert.equal(e.down.liftSeconds[0], null);
  assert.equal(e.down.brakeKwh[0], null);
  assert.equal(e.down.recoveredShare[0], null);
  assert.ok(e.down.regenKwh[0] > 0);
});

test("power back on right at the trough still counts the slow-down (real logs drop it otherwise)", () => {
  // 72 km/h under 10 kW until second 20; coasting on -3 kW, 1.1 km/h a second, down to 50 km/h at second 40;
  // from second 40 back under 15 kW, rising 1 km/h a second to 70 km/h. No brake_pedal column.
  const speed = k => k <= 20 ? 72 : k <= 40 ? 72 - 1.1 * (k - 20) : Math.min(70, 50 + (k - 40));
  const power = k => k <= 20 ? 10 : k < 40 ? -3 : 15;
  const e = episodesOf(trace(speed, 70, k => ({ power_kw: power(k) })));
  assert.equal(e.down.v0.length, 1);
  assert.equal(e.down.v0[0], 72);
  assert.equal(e.down.v1[0], 50);
  assert.equal(e.down.toStop[0], 0);
  assert.equal(e.down.liftSeconds[0], null);
  assert.ok(e.down.regenKwh[0] > 0);
});

test("power missing right at the fall's start still finds the leading run past the gap", () => {
  // 72 km/h under 10 kW until second 20, then falling 1.1 km/h a second, held flat from second 40.
  // power_kw is 10 kW through second 25 but omitted (null, dropped by gpxLog) at second 20 itself,
  // then -3 kW from second 26. No brake_pedal column.
  const speed = k => k <= 20 ? 72 : k <= 40 ? 72 - 1.1 * (k - 20) : 50;
  const power = k => k === 20 ? null : k <= 25 ? 10 : -3;
  const e = episodesOf(trace(speed, 50, k => ({ power_kw: power(k) })));
  assert.equal(e.down.v0.length, 1);
  assert.equal(e.down.v0[0], Math.round(speed(25)));
  assert.equal(e.down.v1[0], 50);
});

test("a gap over 10 s splits a speed-up in two", () => {
  const speed = k => k <= 10 ? 0 : k >= 55 ? 54 : 1.2 * (k - 10);
  const e = episodesOf(trace(speed, 100, () => ({ power_kw: 15 }), k => k >= 30 && k < 45));
  assert.equal(e.up.v0.length, 2);
  for (const s of e.up.seconds) assert.ok(s < 25, `${s} s spans the gap`);
});
