import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGpx } from "../stats/gpx.js";
import { hardMoments, brakeLoss, speedBands, motorway, fullPower, measureHabits, SPEED_BANDS } from "../stats/habits.js";
import { CALIBRATION } from "../stats/settings.js";
import { gpxLog } from "./gpx-builder.mjs";

const near = (actual, expected, tolerance) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

const START = Date.UTC(2026, 8, 14, 7, 0, 0);
const DEGREE_S = 1 / 3.6 / 111194.93;   // degrees of latitude a second per km/h, on the player's 6371 km earth

/** A drive north whose speed (km/h) at second k is kmhAt(k); [ev] adds readings per second. */
function trace(kmhAt, seconds, ev = () => ({})) {
  const points = [];
  let lat = 48.1;
  for (let k = 0; k <= seconds; k++) {
    const kmh = kmhAt(k);
    points.push({ t: START + k * 1000, lat, lon: 17.1, ev: { speed_kmh: kmh, ...ev(k) } });
    lat += kmh * DEGREE_S;
  }
  return points;
}

const logOf = points => parseGpx(gpxLog({ points }));

// 20 km/h until second 10, then 3 m/s² (10.8 km/h a second) for five seconds, then steady.
const ramp = k => k <= 10 ? 20 : k >= 15 ? 74 : 20 + 10.8 * (k - 10);

test("a 3 m/s² pull is one event, not the five windows that see it", () => {
  const { hardAccel, hardBrake } = hardMoments(logOf(trace(ramp, 40)));
  // Windows ending at seconds 12 to 16 all clear 1.5 m/s², and they are a second apart: one press of the pedal.
  assert.equal(hardAccel.length, 1);
  near(hardAccel[0].value, 3, 1e-9);
  assert.equal(hardBrake.length, 0);
});

test("two pulls a minute apart stay two events", () => {
  const twice = k => k < 40 ? ramp(k) : ramp(k - 40) + 54;
  const { hardAccel } = hardMoments(logOf(trace(twice, 80)));
  assert.equal(hardAccel.length, 2);
  near(hardAccel[0].value, 3, 1e-9);
  near(hardAccel[1].value, 3, 1e-9);
});

test("braking is the same measurement, the other way round", () => {
  const { hardAccel, hardBrake } = hardMoments(logOf(trace(k => 74 - ramp(k) + 20, 40)));
  assert.equal(hardAccel.length, 0);
  assert.equal(hardBrake.length, 1);
  near(hardBrake[0].value, -3, 1e-9);
});

test("a one-second speed spike is a glitch, not driving", () => {
  // 200 km/h for a single point is 16.7 m/s² either side of it: past what the car can do, so nothing is reported.
  const spike = hardMoments(logOf(trace(k => k === 20 ? 200 : 20, 40)));
  assert.equal(spike.hardAccel.length, 0);
  assert.equal(spike.hardBrake.length, 0);
  // 80 km/h for a single point is 5.6 m/s²: still over the ceiling, still dropped.
  const smaller = hardMoments(logOf(trace(k => k === 20 ? 80 : 20, 40)));
  assert.equal(smaller.hardAccel.length, 0);
  assert.equal(smaller.hardBrake.length, 0);
});

test("crawling is not driving: a queue never reports a hard pull", () => {
  // 0 to 9 km/h is 2.5 m/s² if it is read over a single second, but the window is three: 0.83 m/s².
  const { hardAccel } = hardMoments(logOf(trace(k => k < 20 ? 0 : 9, 40)));
  assert.equal(hardAccel.length, 0);
});

test("a pull whose rate tapers off is still one press", () => {
  // 3.0 m/s² falling to 2.6 over fourteen seconds - the shape of every real launch. Measured against the
  // worst window kept rather than the window before, each later window would look 5 s away and start again.
  const taper = k => k <= 10 ? 20 : Math.min(160, 20 + (3.0 * (k - 10) - 0.007 * (k - 10) ** 2) * 3.6);
  const { hardAccel } = hardMoments(logOf(trace(taper, 40)));
  assert.equal(hardAccel.length, 1);
  near(hardAccel[0].value, 3, 0.05);
});

test("an event between the floor and the limit is stored, so lowering a limit needs no re-import", () => {
  // 2.0 m/s² is under the 2.5 default but over the 1.5 floor: the page must find it without reading the file again.
  const gentle = k => k <= 10 ? 20 : k >= 15 ? 56 : 20 + 7.2 * (k - 10);
  const { hardAccel } = hardMoments(logOf(trace(gentle, 40)));
  assert.equal(hardAccel.length, 1);
  near(hardAccel[0].value, 2, 1e-9);
});

test("a window stretched across a gap in the points measures nothing", () => {
  // The same 3 m/s² pull, but the app stopped writing for five seconds in the middle of it. The only
  // windows that see the pull now span six seconds, and six seconds of speed is not a press of the pedal.
  const points = trace(ramp, 40).filter(p => p.t <= START + 10000 || p.t >= START + 16000);
  assert.equal(hardMoments(logOf(points)).hardAccel.length, 0);
});

// A stop worked out by hand: 20 s at 72 km/h (20 m/s), then 2 m/s² braking for 10 s to a standstill.
//   kinetic energy       0.5 × 1600 × 20²                                        = 320,000 J
//   air over the stop    0.5 × 1.2 × 0.65 × Σv³, v = 19, 17 … 1 m/s (Σv³ = 19,900) =   7,761 J
//   rolling over it      1600 × 9.80665 × 0.010 × Σv, Σv = 100 m/s               =  15,690.64 J
//   recoverable          320,000 − 7,761 − 15,690.64                             = 296,548.36 J
const stopping = k => k <= 20 ? 72 : Math.max(0, 72 - 7.2 * (k - 20));
const RECOVERABLE = 296548.36;

test("a stop with no regen leaves all of the recoverable energy in the pads", () => {
  const log = logOf(trace(stopping, 40, k => ({ power_kw: 0, brake_pedal: k > 20 && k <= 30 ? 1 : 0 })));
  const b = brakeLoss(log, CALIBRATION);
  near(b.recoverableKwh * 3.6e6, RECOVERABLE, 1);
  near(b.kwh * 3.6e6, RECOVERABLE, 1);
  assert.equal(b.share, 1);
  assert.equal(b.moments.length, 1);
  assert.equal(b.moments[0].at, START + 20000, "the press starts at the last point before the pedal went down");
  near(b.moments[0].speed, 72, 1e-9);
  near(b.moments[0].value, 72, 1e-9);
});

test("regen taken back is not lost, once the motor's own losses are added to it", () => {
  // 20 kW back for the ten braking seconds: (0 + 20)/2 + 20 × 9 = 190 kJ into the pack, and
  // 190,000 ÷ 0.85 = 223,529.41 J of movement produced it. 296,548.36 − 223,529.41 = 73,018.95 J for the pads.
  const log = logOf(trace(stopping, 40, k => ({ power_kw: k > 20 && k <= 30 ? -20 : 0, brake_pedal: k > 20 && k <= 30 ? 1 : 0 })));
  const b = brakeLoss(log, CALIBRATION);
  near(b.kwh * 3.6e6, 73018.95, 1);
  near(b.share, 73018.95 / RECOVERABLE, 1e-6);
});

test("a stab of the pedal too short to be a falling stretch is still divided by its own energy", () => {
  // Two seconds of braking: under the three the falling stretches need, so before this the loss had
  // nothing to divide by and the drive reported no braking at all while heat went into the pads.
  const stab = k => k <= 20 ? 72 : k <= 22 ? 72 - 7.2 * (k - 20) : 57.6;
  const b = brakeLoss(logOf(trace(stab, 40, k => ({ power_kw: 0, brake_pedal: k > 20 && k <= 22 ? 1 : 0 }))), CALIBRATION);
  assert.ok(b.kwh > 0, "the pads took the energy");
  assert.equal(b.share, 1, "and every joule of it was recoverable");
});

test("the share of the recoverable energy left in the pads never passes 100 %", () => {
  // Stabs of the pedal between stretches of coasting: every press is in the denominator through itself.
  const speed = k => 90 - 3 * Math.floor(k / 10) - (k % 10 < 3 ? 6 * (k % 10) : 12);
  const b = brakeLoss(logOf(trace(speed, 120, k => ({ power_kw: 0, brake_pedal: k % 10 < 3 ? 1 : 0 }))), CALIBRATION);
  assert.ok(b.share > 0 && b.share <= 1, `share ${b.share}`);
});

test("a hill given up is energy the brakes could have taken back", () => {
  // The same stop, 20 m lower at the end: 1600 × 9.80665 × 20 = 313,812.8 J more to recover.
  const points = trace(stopping, 40, k => ({ power_kw: 0, brake_pedal: k > 20 && k <= 30 ? 1 : 0 }));
  points.forEach((p, k) => { p.ele = 200 - (k <= 20 ? 0 : k >= 30 ? 20 : 2 * (k - 20)); });
  const b = brakeLoss(logOf(points), CALIBRATION);
  near(b.kwh * 3.6e6, RECOVERABLE + 1600 * 9.80665 * 20, 1);
});

test("lifting off instead of braking loses nothing to the pads", () => {
  // The same stop, the same regen, but the pedal never goes down: no press, so no loss - and the
  // falling speed still counts towards what could have been recovered.
  const log = logOf(trace(stopping, 40, k => ({ power_kw: k > 20 && k <= 30 ? -20 : 0, brake_pedal: 0 })));
  const b = brakeLoss(log, CALIBRATION);
  assert.equal(b.kwh, 0);
  assert.equal(b.share, 0);
  near(b.recoverableKwh * 3.6e6, RECOVERABLE, 1);
});

test("distance, time and energy land in the right speed bands", () => {
  const log = logOf(trace(k => k <= 60 ? 40 : 100, 120, () => ({ power_kw: 10 })));
  const bands = speedBands(log);
  assert.equal(bands.length, SPEED_BANDS.length);
  // The second from 40 to 100 km/h averages 70 and belongs to neither neighbour.
  near(bands[1].seconds, 60, 1e-9);
  near(bands[3].seconds, 1, 1e-9);
  near(bands[4].seconds, 59, 1e-9);
  near(bands[1].km, 60 * 40 / 3600, 1e-4);
  near(bands[4].km, 59 * 100 / 3600, 1e-4);
  near(bands[1].energy, 10 * 60 / 3600, 1e-9);
  assert.equal(bands[0].seconds, 0);
  assert.equal(bands[6].seconds, 0);
});

test("motorway smoothness is the spread over each minute of a stretch", () => {
  const steady = motorway(logOf(trace(() => 100, 119, () => ({ power_kw: 20 }))));
  near(steady.seconds, 119, 1e-9);
  near(steady.speedSpread, 0, 1e-9);
  near(steady.powerSpread, 0, 1e-9);
  // Alternating 95 and 105 km/h: every window of a minute holds about as many of each, so about 5 km/h.
  const wobbly = motorway(logOf(trace(k => k % 2 ? 105 : 95, 119)));
  near(wobbly.speedSpread, 5, 0.01);
  assert.equal(wobbly.powerSpread, null, "no power column, so no power spread");
  // A minute is the shortest stretch that counts.
  assert.equal(motorway(logOf(trace(k => k < 30 ? 100 : 50, 120))), null);
  // 85 km/h is not the motorway, however long it is held.
  assert.equal(motorway(logOf(trace(() => 85, 600))), null);
});

test("a long steady motorway run does not score worse than a short one", () => {
  // Speed drifting a few km/h over the whole run: read over the whole stretch the spread would grow with
  // the length of the road, which says where the driver went, not how they drove.
  const drift = k => 100 + 6 * Math.sin(k / 240);
  const short = motorway(logOf(trace(drift, 180))), long = motorway(logOf(trace(drift, 1800)));
  near(long.speedSpread, short.speedSpread, 0.5);
  assert.ok(long.speedSpread < 1, `a minute of this drift is steady, got ${long.speedSpread}`);
});

test("full power is the time above 60 kW", () => {
  // 80 kW for the first 40 points: 39 seconds between them, and the step down to 10 kW averages 45 kW.
  assert.equal(fullPower(logOf(trace(() => 100, 100, k => ({ power_kw: k < 40 ? 80 : 10 })))), 39);
});

test("a basic log simply has no habit where it has no reading", () => {
  // Extended data off: GPS speed and nothing else.
  const points = Array.from({ length: 121 }, (_, k) => ({ t: START + k * 1000, lat: 48.1 + k * 36 * DEGREE_S, lon: 17.1, speedMs: 10 }));
  const h = measureHabits(parseGpx(gpxLog({ points })));
  assert.equal(h.brakeLoss, null, "no brake pedal and no power: the share is unknown, not nought");
  assert.equal(h.fullPowerSeconds, null);
  assert.equal(h.motorway, null);
  assert.deepEqual(h.hardAccel, []);
  assert.equal(h.bands[1].energy, null, "distance and time are known, energy is not");
  near(h.bands[1].seconds, 120, 1e-9);
});

test("measureHabits falls back to the default calibration", () => {
  const points = trace(stopping, 40, k => ({ power_kw: 0, brake_pedal: k > 20 && k <= 30 ? 1 : 0 }));
  assert.deepEqual(measureHabits(logOf(points)), measureHabits(logOf(points), CALIBRATION));
  // A heavier car gives up more energy at the same speed, so more of it ends in the pads.
  const heavy = measureHabits(logOf(points), { ...CALIBRATION, massKg: 2000 });
  assert.ok(heavy.brakeLoss.kwh > measureHabits(logOf(points)).brakeLoss.kwh);
});

/**
 * The drive as the app actually writes it: points come faster than its clock of
 * whole seconds ticks, so they arrive in pairs sharing a timestamp - 4,154
 * points over 3,090 distinct times in one of the owner's trip logs.
 */
function paired(kmh, seconds) {
  const points = [];
  for (let h = 0; h <= seconds * 2; h++) {
    points.push({
      t: START + Math.floor(h / 2) * 1000, lat: 48.1 + h * 0.5 * kmh * DEGREE_S, lon: 17.1,
      ev: { speed_kmh: kmh, power_kw: 10 },
    });
  }
  return points;
}

test("a step of no length keeps its ground: a band's speed lands inside the band", () => {
  // A minute at 100 km/h written as two points a second. Dropping the half of the steps that measure no
  // time would drop their distance too, and the band would read 50 km/h - outside its own 90-110 bounds.
  const bands = speedBands(logOf(paired(100, 60)));
  near(bands[4].seconds, 60, 1e-9);
  near(bands[4].km, 100 * 60 / 3600, 1e-4);
  near(bands[4].km / (bands[4].seconds / 3600), 100, 0.01);
  near(bands[4].energy, 10 * 60 / 3600, 1e-9);
  near(bands[4].energyKm, bands[4].km, 1e-9);
  // Every other band is untouched by the carry: nothing rolls across a band boundary it never crossed.
  assert.deepEqual(bands.map(b => b.seconds > 0), [false, false, false, false, true, false, false]);
});

test("a pause breaks the carry rather than rolling the ground crossed during it into a band", () => {
  // Two half-minutes at 100 km/h with the app not writing for a minute in between, and the car somewhere
  // else when it starts again. The minute is not driving, and neither is the ground crossed during it.
  const points = paired(100, 120).filter(p => { const k = (p.t - START) / 1000; return k <= 30 || k >= 90; });
  const bands = speedBands(logOf(points));
  near(bands[4].seconds, 60, 1e-9);
  near(bands[4].km, 100 * 60 / 3600, 1e-4);
});

test("a band's energy carries the distance it was measured over, not the band's whole distance", () => {
  // The power column stops reading half a minute in: the kilometres keep counting, the kWh cannot, and
  // energyKm says which of the two the consumption may be divided by.
  const log = logOf(trace(() => 100, 60, k => ({ power_kw: k <= 30 ? 10 : null })));
  const bands = speedBands(log);
  near(bands[4].km, 100 * 60 / 3600, 1e-4);
  near(bands[4].energyKm, 100 * 30 / 3600, 1e-4);
  near(bands[4].energy, 10 * 30 / 3600, 1e-9);
});
