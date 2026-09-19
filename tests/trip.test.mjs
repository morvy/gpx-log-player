import { test } from "node:test";
import assert from "node:assert/strict";
import { chargingCurve } from "../stats/charges.js";
import { fmt } from "../stats/coach-view.js";
import {
  speedModel, estimated, parseSpeeds, round5, planAt, recommendSpeed, tableSpeeds, compareLine,
  SEARCH_MIN, SEARCH_MAX,
} from "../stats/trip.js";

const near = (actual, expected, tolerance) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

const BANDS = [0, 30, 50, 70, 90, 110, 130];
/** A stored drive whose speed bands are { from: [km, kmh, per100] }; every other band is empty. */
const drive = (bands, outsideTemp = null) => ({
  outsideTemp,
  habits: {
    bands: BANDS.map(from => {
      if (!bands[from]) return { seconds: 0, km: 0, energy: 0, energyKm: 0 };
      const [km, kmh, per100] = bands[from];
      return { seconds: km / kmh * 3600, km, energy: km * per100 / 100, energyKm: km };
    }),
  },
});

// A car that uses 8 kWh/100 km plus 0.001 × v².
const law = v => 8 + 0.001 * v * v;
const lawful = (km = 40, shift = 0) => ({
  50: [km, 60, law(60) + shift], 70: [km, 80, law(80) + shift], 90: [km, 100, law(100) + shift], 110: [km, 120, law(120) + shift],
});

// The physics fallback worked out by hand for the default calibration at 100 km/h.
const physicsAt100 = () => {
  const u = 100 / 3.6;
  const kw = (0.5 * 1.2 * 0.65 * u ** 3 + 1600 * 9.80665 * 0.010 * u) / 1000 / 0.85 + 0.5;
  return kw / 100 * 100;
};

// ---------- the consumption model ----------

test("the fit recovers a and b from bands built on a + b·v²", () => {
  const m = speedModel([drive({ ...lawful(), 30: [100, 40, 50], 130: [19, 140, 5] })]);
  assert.equal(m.source, "fit");
  near(m.a, 8, 1e-6);
  near(m.b, 0.001, 1e-9);
  near(m.per100(135), law(135), 1e-6);
  // Town driving and a band with under 20 km in it say nothing, however far off they are.
  assert.equal(m.points.length, 4);
  near(m.from, 60, 1e-9);
  near(m.to, 120, 1e-9);
  assert.equal(m.atTemp, false);
});

test("a band driven further pulls the line harder", () => {
  const off = km => speedModel([drive({ 50: [1000, 60, law(60)], 90: [1000, 100, law(100)], 110: [km, 120, law(120) + 5] })]);
  const light = off(20).per100(120) - law(120), heavy = off(2000).per100(120) - law(120);
  assert.ok(light > 0 && heavy > 2 * light, `${light} then ${heavy}`);
});

test("weather like the day's is used when two bands of it say something", () => {
  const drives = [drive(lawful(40), 20), drive(lawful(40, 4), 0)];
  const cold = speedModel(drives, { temp: 2 });
  assert.equal(cold.atTemp, true);
  near(cold.a, 12, 1e-6);
  const warm = speedModel(drives, { temp: 20 });
  assert.equal(warm.atTemp, true);
  near(warm.a, 8, 1e-6);
  // Ten degrees from both: all the driving, which is both drives merged band by band.
  const between = speedModel(drives, { temp: 10 });
  assert.equal(between.atTemp, false);
  near(between.a, 10, 1e-6);
  assert.equal(speedModel(drives).atTemp, false);
  // One band of cold driving is not enough to draw a line through.
  const one = speedModel([drive(lawful(40), 20), drive({ 90: [40, 100, 30] }, 0)], { temp: 0 });
  assert.equal(one.atTemp, false);
  assert.equal(one.source, "fit");
});

test("cold driving that does not fit gives way to all the driving before the physics", () => {
  const drives = [drive(lawful(200), 20), drive({ 90: [30, 100, 30], 110: [30, 120, 20] }, 0)];
  const m = speedModel(drives, { temp: 0 });
  assert.equal(m.source, "fit");
  assert.equal(m.atTemp, false);
  assert.equal(m.points.length, 4);
});

test("under two points, or a line that falls with speed, the physics settings answer", () => {
  const one = speedModel([drive({ 90: [40, 100, 17] })]);
  assert.equal(one.source, "physics");
  assert.equal(one.a, null);
  assert.equal(one.b, null);
  assert.equal(one.points.length, 1, "the dot is still drawn");
  near(one.from, 100, 1e-9);
  near(one.per100(100), physicsAt100(), 1e-9);
  assert.ok(speedModel([drive({ 90: [40, 100, 17] })], { calibration: { massKg: 2000 } }).per100(100) > physicsAt100());

  const none = speedModel([]);
  assert.equal(none.source, "physics");
  assert.deepEqual([none.from, none.to, none.points], [null, null, []]);

  const falling = speedModel([drive({ 50: [40, 60, 20 - 0.001 * 3600], 90: [40, 100, 20 - 0.001 * 10000] })]);
  assert.equal(falling.source, "physics", "b ≤ 0");
  const below = speedModel([drive({ 50: [40, 60, -2 + 0.003 * 3600], 90: [40, 100, -2 + 0.003 * 10000] })]);
  assert.equal(below.source, "physics", "a < 0");
  // Two bands at one average speed have no slope to give.
  const flat = speedModel([drive({ 50: [40, 69, 12], 70: [40, 69, 14] })]);
  assert.equal(flat.source, "physics");
});

test("a speed well past the fastest band, or any speed on the physics, is estimated", () => {
  const m = speedModel([drive(lawful())]);
  assert.equal(estimated(m, 130), false);
  assert.equal(estimated(m, 140), true);
  assert.equal(estimated(speedModel([]), 60), true);
});

// ---------- the typed speeds ----------

test("typed speeds come back whole, once each and slowest first", () => {
  assert.deepEqual(parseSpeeds("110, 95 130"), { speeds: [95, 110, 130], bad: [] });
  assert.deepEqual(parseSpeeds("95.4, 95.6"), { speeds: [95, 96], bad: [] });
  assert.deepEqual(parseSpeeds("100,100.2,  100"), { speeds: [100], bad: [] });
  assert.deepEqual(parseSpeeds("35, 170, fast, 40, 160, -50, 1e2"), { speeds: [40, 160], bad: ["35", "170", "fast", "-50", "1e2"] });
  assert.deepEqual(parseSpeeds(""), { speeds: [], bad: [] });
  assert.deepEqual(parseSpeeds("  "), { speeds: [], bad: [] });
});

test("a speed is rounded to the nearest 5 km/h", () => {
  assert.deepEqual([97, 99, 102.5, 100].map(round5), [95, 100, 105, 100]);
});

test("the table has the typed speeds, and the recommended one when it was not typed", () => {
  assert.deepEqual(tableSpeeds([95, 110, 130], 105), [95, 105, 110, 130]);
  assert.deepEqual(tableSpeeds([95, 110], 110), [95, 110]);
  assert.deepEqual(tableSpeeds([], 105), [105]);
  assert.deepEqual(tableSpeeds([95], null), [95]);
});

// ---------- the recommendation ----------

// A curve flat at 60 kW to 80 % and slower above, as in tests/charges.test.mjs.
const CURVE = chargingCurve([]).map((b, i) => ({ ...b, kw: [60, 60, 60, 60, 60, 20, 10][i] }));
const TRIP = { curve: CURVE, perPoint: 0.25, km: 300, socStart: 100, socMin: 10, stopMinutes: 5 };
const fitted = speedModel([drive(lawful())]);

test("each row is planned at the model's consumption and says whether it is estimated", () => {
  const rows = planAt([100, 140], fitted, TRIP);
  assert.deepEqual(rows.map(r => r.speed.kmh), [100, 140]);
  near(rows[0].kwh, 300 * law(100) / 100, 1e-9);
  assert.deepEqual(rows.map(r => r.estimated), [false, true]);
});

test("the recommended speed is the best multiple of 5, and nothing slower comes within a minute of it", () => {
  const rec = recommendSpeed(fitted, TRIP);
  const all = [];
  for (let v = SEARCH_MIN; v <= SEARCH_MAX; v++) all.push(v);
  const rows = planAt(all, fitted, TRIP).filter(r => r.total != null);
  const least = Math.min(...rows.map(r => r.total));
  assert.ok(rec.found > SEARCH_MIN && rec.found < SEARCH_MAX, `the best whole speed is in between (${rec.found})`);
  assert.ok(rows.find(r => r.speed.kmh === rec.found).total <= least + 1);
  // Among multiples of 5, the recommended speed should be the best or tied within TIE_MINUTES.
  assert.equal(rec.speed % 5, 0, "speed is a multiple of 5");
  const roundRows = rows.filter(r => r.speed.kmh % 5 === 0);
  const leastRound = Math.min(...roundRows.map(r => r.total));
  const recRow = rows.find(r => r.speed.kmh === rec.speed);
  assert.ok(recRow.total <= leastRound + 1, `${rec.speed} km/h is within 1 min of best multiple-of-5 total`);
  // No faster multiple of 5 should be within the tie window.
  for (const r of roundRows.filter(r => r.speed.kmh > rec.speed)) {
    assert.ok(r.total > recRow.total + 1, `faster speed ${r.speed.kmh} km/h is outside tie window`);
  }
  assert.equal(rec.row.speed.kmh, rec.speed);
});

test("of two totals within a minute the slower speed wins, searched among multiples of 5", () => {
  // No stop on this trip, so the fastest arrives first: 6000 / v minutes. At 150 km/h it takes 40 min.
  // Within a minute of that is 145 km/h at 41.38 min (outside window) and 150 at 40 min (the only multiple of 5).
  // But an earlier whole speed 147 km/h takes 40.82 min (within the window) and is the slowest found.
  const rec = recommendSpeed({ per100: () => 10, source: "fit", to: 200 }, { ...TRIP, km: 100 });
  assert.equal(rec.found, 147);
  assert.equal(rec.speed, 150);
  assert.equal(rec.row.speed.kmh, 150);
  assert.equal(rec.row.stops, 0);
  near(rec.row.total, 6000 / 150, 1e-9);
});

test("no recommendation when nothing can be planned", () => {
  const blind = CURVE.map(b => ({ ...b, kw: null }));
  assert.equal(recommendSpeed(fitted, { ...TRIP, curve: blind }), null);
  assert.equal(recommendSpeed(fitted, { ...TRIP, socStart: 10 }), null);
});

test("the recommendation is chosen from multiples of 5, not by rounding the fine best", () => {
  // The specification requires searching only multiples of 5, not rounding after search.
  // With a trip where fine best differs from the nearest multiple-of-5 best, they diverge.
  // Setup: 240 km, 15-min stops, model 11 + 0.0015·v² creates non-trivial speed penalties.
  // This makes faster speeds cost more charging time, so fine best may not round cleanly.
  const model = { per100: v => 11 + 0.0015 * v * v, source: "fit", to: 150 };
  const trip240 = { curve: CURVE, perPoint: 0.25, km: 240, socStart: 100, socMin: 10, stopMinutes: 15 };
  const rec = recommendSpeed(model, trip240);
  assert.ok(rec, "trip can be planned");
  assert.equal(rec.speed % 5, 0, "recommended speed is a multiple of 5");

  // Check: speed is selected from multiples of 5, not derived by round5(found).
  // If the code rounded after search, it would be round5(found). With the fix, it's the best multiple-of-5.
  // They can differ because fine search and multiple-of-5 search have different candidates.
  const allSpeeds = [];
  for (let v = SEARCH_MIN; v <= SEARCH_MAX; v++) allSpeeds.push(v);
  const allRows = planAt(allSpeeds, model, trip240).filter(r => r.total != null);
  const roundSpeeds = [];
  for (let v = SEARCH_MIN; v <= SEARCH_MAX; v += 5) roundSpeeds.push(v);
  const roundRows = planAt(roundSpeeds, model, trip240).filter(r => r.total != null);

  // The recommended speed should be among the best multiples of 5, not a rounded fine speed.
  const bestRoundTotal = Math.min(...roundRows.map(r => r.total));
  const recRoundRow = roundRows.find(r => r.speed.kmh === rec.speed);
  assert.ok(recRoundRow.total <= bestRoundTotal + 1, `recommended ${rec.speed} is within 1 min of best multiple-of-5`);
});

test("among multiples of 5 with totals within a minute, the slowest is recommended", () => {
  // A short no-stop trip where two multiples of 5 are within the tie window, testing the tie-break direction.
  // Setup: 60 km with flat model 11 kWh/100 km, no stops needed.
  // At 150 km/h: 24.00 min (best)
  // At 145 km/h: 24.83 min (within 1 minute of best)
  // At 140 km/h: 25.71 min (outside the tie window)
  // The slowest within the tie window (145 km/h) should be recommended.
  const model = { per100: () => 11, source: "fit", to: 200 };
  const tripShort = { curve: CURVE, perPoint: 0.25, km: 60, socStart: 100, socMin: 10, stopMinutes: 5 };
  const rec = recommendSpeed(model, tripShort);
  assert.ok(rec, "trip can be planned");
  assert.equal(rec.speed, 145, `recommended speed is 145 km/h (the slowest in tie group), not 150`);
  assert.equal(rec.row.speed.kmh, 145, "row is at recommended speed");
  near(rec.row.total, 60 / 145 * 60, 1e-9, `total is 60 / 145 × 60 ≈ ${(60 / 145 * 60).toFixed(2)} min`);
  // Verify there is indeed a tie group with at least two multiples of 5.
  const allRound = planAt([140, 145, 150], model, tripShort);
  const totals = allRound.filter(r => r.total != null).map(r => r.total);
  const best = Math.min(...totals);
  const tieGroup = totals.filter(t => t <= best + 1);
  assert.ok(tieGroup.length >= 2, `tie group has ${tieGroup.length} members (at least 2 required)`);
});

// ---------- the comparison ----------

const row = (kmh, total, stops, kwh) => ({ speed: { kmh }, total, stops, kwh });

test("the recommended row is set against the fastest other speed that plans", () => {
  const best = row(105, 210, 1, 57.9);
  assert.equal(compareLine(best, [row(95, 219.4, 1, 52.5), best, row(130, 219, 2, 72.1)]),
    `vs 130 km/h: 9 min sooner, 1 stop fewer, ${fmt(14.2, 1)} kWh less`);
  assert.equal(compareLine(best, [row(95, 219.4, 1, 52.5), best, { speed: { kmh: 150 }, blocked: { from: 70 } }]),
    `vs 95 km/h: 9 min sooner, the same number of stops, ${fmt(5.4, 1)} kWh more`);
  assert.equal(compareLine(row(90, 212, 2, 40), [row(90, 212, 2, 40), row(100, 210.6, 0, 45)]),
    `vs 100 km/h: 1 min later, 2 stops more, ${fmt(5, 1)} kWh less`);
  assert.equal(compareLine(row(90, 212, 1, 40), [row(90, 212, 1, 40), row(100, 212.3, 3, 45)]),
    `vs 100 km/h: the same time, 2 stops fewer, ${fmt(5, 1)} kWh less`);
});

test("with nothing else to compare there is no line", () => {
  const best = row(105, 210, 1, 57.9);
  assert.equal(compareLine(best, [best]), null);
  assert.equal(compareLine(null, [best]), null);
});
