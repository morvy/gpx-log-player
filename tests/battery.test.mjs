import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGpx } from "../stats/gpx.js";
import { lowCharge, chargeJumps, hardPulls, cellMeans, cellSpread, measureBattery, SOC_BANDS } from "../stats/battery.js";
import { gpxLog } from "./gpx-builder.mjs";

const near = (actual, expected, tolerance) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

const START = Date.UTC(2026, 8, 14, 7, 0, 0);
const DEGREE_S = 1 / 3.6 / 111194.93;   // degrees of latitude a second per km/h, on the player's 6371 km earth

/** A drive north at [kmh], one point a second; [ev] adds readings per second k. */
function trace(seconds, kmh, ev = () => ({})) {
  const points = [];
  let lat = 48.1;
  for (let k = 0; k <= seconds; k++) {
    points.push({ t: START + k * 1000, lat, lon: 17.1, ev: { speed_kmh: kmh, ...ev(k) } });
    lat += kmh * DEGREE_S;
  }
  return points;
}

const logOf = points => parseGpx(gpxLog({ points }));

/** 96 cells at [mv] millivolts from 3.700 V, one of them [low] mV lower. */
const pack = (low = 0, cell = 1) => Array.from({ length: 96 }, (_, k) => 3.7 - (k === cell - 1 ? low / 1000 : 0));

/** What the page sums at draw time: the stretches at a whole point of charge under [limit]. */
const under = (moments, limit, field = "seconds") =>
  moments.filter(m => m.soc < Math.floor(limit)).reduce((a, m) => a + m[field], 0);

test("time and distance under 5 % come from the charge the driving was done at", () => {
  // 100 s at 36 km/h (10 m/s): the BMS reads 6 % at the start and 4 % at second 50, and a step is driven
  // at the charge last read before it - so fifty seconds and half a kilometre were driven under 5 %.
  const moments = lowCharge(logOf(trace(100, 36, k => ({ soc_percent: k === 0 ? 6 : k === 50 ? 4 : null }))));
  near(under(moments, 5), 50, 1e-9);
  near(under(moments, 5, "km"), 50 * 10 / 1000, 1e-3);
  // Both points of charge are stretches of their own; nothing was driven between 5 and 6 %.
  assert.deepEqual(moments.map(m => m.soc), [4, 6]);
  near(moments.find(m => m.soc === 6).seconds, 50, 1e-9);
  near(moments.reduce((a, m) => a + m.seconds, 0), 100, 1e-9);
  // The stretch says when and where it began, for the player link on the card.
  const empty = moments.find(m => m.soc === 4);
  assert.equal(empty.at, START + 50000);
  near(empty.speed, 36, 1e-9);
  near(empty.lat, 48.1 + 50 * 36 * DEGREE_S, 1e-6);
});

test("a part point of charge belongs to the point below it, and a pause is not driving", () => {
  // 4.6 % is under 5: the charge a step was driven at is the reading, not the reading rounded up.
  const moments = lowCharge(logOf(trace(20, 36, k => ({ soc_percent: k === 0 ? 4.6 : null }))));
  near(under(moments, 5), 20, 1e-9);
  assert.deepEqual(moments.map(m => m.soc), [4]);

  // The app stopped writing for half a minute in the middle: standing about is not time on an empty pack,
  // and the five-second gap either side of it still is.
  const points = trace(60, 36, k => ({ soc_percent: k === 0 ? 3 : null }))
    .filter(p => { const k = (p.t - START) / 1000; return k <= 20 || k >= 50 ? k % 5 === 0 : false; });
  const split = lowCharge(logOf(points));
  near(under(split, 5), 30, 1e-9);
  // The driving either side of the pause is two stretches, so the moment table points at the second the
  // driver was there and not at one half an hour before it.
  assert.deepEqual(split.map(m => m.at), [START, START + 50000]);
  assert.deepEqual(split.map(m => m.seconds), [20, 10]);

  // Ten seconds between two points is still a step; eleven is a pause. Where that gives way is the rule.
  const every = gap => lowCharge(logOf(trace(gap * 3, 36, k => ({ soc_percent: k === 0 ? 3 : null }))
    .filter(p => (p.t - START) / 1000 % gap === 0)));
  near(under(every(10), 5), 30, 1e-9);
  assert.equal(under(every(11), 5), 0);
});

test("only the charge under the detection floor is kept, and a stretch is cut at the whole point", () => {
  // From 12 % down to 8 %, a point a minute. The floor is 10, so 12 and 11 are not stored at all -
  // and a limit at the floor still sums the same seconds a curve of all 101 points would.
  const soc = k => 12 - Math.floor(k / 60);
  const moments = lowCharge(logOf(trace(299, 36, k => ({ soc_percent: soc(k) }))));
  assert.deepEqual(moments.map(m => m.soc), [8, 9], "worst first, and nothing at or above the floor");
  near(under(moments, 10), 119, 1e-9);   // 60 s at 9 % and 59 at 8 %
  near(under(moments, 9), 59, 1e-9);
  assert.equal(under(moments, 5), 0, "none of this driving was under 5 %");

  // The BMS wandered back over the floor and down again. The same point of charge either side of it is
  // two stretches, not one that swallows the driving between them.
  const wander = lowCharge(logOf(trace(29, 36, k => ({ soc_percent: k < 10 || k >= 20 ? 4 : 12 }))));
  assert.deepEqual(wander.map(m => m.seconds), [10, 9]);
  assert.deepEqual(wander.map(m => m.at), [START, START + 20000]);
});

test("a charge jump the player would also find, and a fall energy explains", () => {
  // 1 kWh out of the pack between the two readings is 4.1 points: a fall of 4 is the driving,
  // a fall of 9 is 4.9 points the energy cannot explain.
  const counter = k => k < 20 ? 10 : 11;
  const explained = logOf(trace(40, 36, k => ({ soc_percent: k === 0 ? 50 : k === 30 ? 46 : null, energy_kwh: counter(k) })));
  assert.deepEqual(chargeJumps(explained), []);

  const jumped = logOf(trace(40, 36, k => ({ soc_percent: k === 0 ? 50 : k === 30 ? 41 : null, energy_kwh: counter(k) })));
  const [e] = chargeJumps(jumped);
  assert.equal(chargeJumps(jumped).length, 1);
  near(e.value, -4.9, 1e-9);
  assert.equal(e.before, 50);
  assert.equal(e.after, 41);
  assert.equal(e.at, START + 30000);
  near(e.speed, 36, 1e-9);
  near(e.lat, 48.1 + 30 * 36 * DEGREE_S, 1e-6);   // the file carries seven decimals of latitude

  // A fall of five and a half on the same kilowatt hour leaves 1.4 points unexplained: the BMS wandering,
  // not the BMS jumping. Two points is where it becomes one.
  const wander = logOf(trace(40, 36, k => ({ soc_percent: k === 0 ? 50 : k === 30 ? 44.5 : null, energy_kwh: counter(k) })));
  assert.deepEqual(chargeJumps(wander), []);

  // Two points exactly is a jump, and a hair under it is not. The card promises "2 points or more", and
  // where the rule fires is as much the rule as the 2 is.
  const at = fall => logOf(trace(40, 36, k => ({ soc_percent: k === 0 ? 50 : k === 30 ? 50 - fall : null, energy_kwh: 10 })));
  assert.equal(chargeJumps(at(2)).length, 1, "2.0 points the energy cannot explain is a jump");
  assert.deepEqual(chargeJumps(at(1.999)), []);

  // The same nine points, but read three minutes apart: a long gap is two states, not one jump.
  const slow = logOf(trace(240, 36, k => ({ soc_percent: k === 0 ? 50 : k === 200 ? 41 : null, energy_kwh: counter(k) })));
  assert.deepEqual(chargeJumps(slow), []);
});

test("jumps are kept worst first, so a drive's worst is the one the page shows", () => {
  // The counter never moves, so nothing is explained: −3 points at second 30, then −6 at second 60.
  const log = logOf(trace(80, 36, k => ({ soc_percent: k === 0 ? 50 : k === 30 ? 47 : k === 60 ? 41 : null, energy_kwh: 10 })));
  assert.deepEqual(chargeJumps(log).map(j => j.value), [-6, -3], "the worst first, whatever order they happened in");
});

test("without the car's own counter the jump is judged against the power through the pack", () => {
  // 10 s of 40 kW after the first reading is 0.111 kWh, worth 0.455 points: a fall of 3 is a jump.
  const log = logOf(trace(40, 36, k => ({ soc_percent: k === 0 ? 50 : k === 10 ? 47 : null, power_kw: k <= 10 ? 40 : 0 })));
  const [e] = chargeJumps(log);
  near(e.explained, -40 * 10 / 3600 * 4.1, 1e-6);
  near(e.value, -3 + 40 * 10 / 3600 * 4.1, 1e-6);
});

/** What the page sums at draw time: the stretches that pass the limits of the moment. */
const pulled = (moments, { kw = 40, packC = 10, soc = 10 } = {}) => moments
  .filter(m => m.kw > kw && ((m.packC != null && m.packC < packC) || (m.soc != null && m.soc < soc)))
  .reduce((a, m) => a + m.seconds, 0);

test("a hard pull is stored with the pack it was pulled from, and judged at draw time", () => {
  // 50 kW throughout; the pack warms past 10 °C at second 20 and the charge is comfortable.
  const warming = hardPulls(logOf(trace(60, 90, k => ({ power_kw: 50, battery_temp_c: k < 20 ? 5 : 15, soc_percent: 50 }))));
  // One pull of 60 s, stored whole with the pack as it was when the pull began.
  assert.equal(warming.length, 1);
  near(warming[0].kw, 50, 1e-9);
  near(warming[0].seconds, 60, 1e-9);
  assert.equal(warming[0].packC, 5);
  assert.equal(warming[0].soc, 50);
  assert.equal(warming[0].at, START);
  near(warming[0].speed, 90, 1e-9);
  near(pulled(warming), 60, 1e-9);
  // Nothing about the limits is stored: a warmer pack, or a higher bar for a pull, re-judges the same drive.
  assert.equal(pulled(warming, { packC: 4 }), 0);
  assert.equal(pulled(warming, { kw: 50 }), 0, "50 kW is not above a 50 kW limit");
  near(pulled(warming, { kw: 49.9 }), 60, 1e-9);

  // The same drive at 35 kW is over the 30 kW detection floor, so it is stored - and under the limit,
  // so the page counts none of it. A limit lowered to 34 finds it without reading the file again.
  const gentle = hardPulls(logOf(trace(60, 90, k => ({ power_kw: 35, battery_temp_c: 5, soc_percent: 50 }))));
  assert.equal(pulled(gentle), 0);
  near(pulled(gentle, { kw: 34 }), 60, 1e-9);

  // A warm pack nearly empty is weak too. The charge falls under 10 % at second 30, but the whole pull was
  // one stretch from a pack at 12 %, so it is the state at the start that the page judges.
  const empty = hardPulls(logOf(trace(60, 90, k => ({ power_kw: 50, battery_temp_c: 25, soc_percent: k < 30 ? 12 : 8 }))));
  assert.equal(empty.length, 1);
  assert.equal(empty[0].soc, 12);
  assert.equal(pulled(empty), 0);
  near(pulled(empty, { soc: 13 }), 60, 1e-9);
});

test("the detection floor and what it lets through", () => {
  // Exactly 30 kW is not over the floor: where the floor fires is as much the floor as the 30 is.
  const at = kw => hardPulls(logOf(trace(20, 90, () => ({ power_kw: kw, battery_temp_c: 5 }))));
  assert.deepEqual(at(30), []);
  assert.equal(at(30.1).length, 1);

  // A pull whose power wobbles over the floor and back is one pull, not three, and its seconds are the
  // seconds over the floor - the dips are not counted as driving at 45 kW.
  // Seven seconds at 45 kW, seven at 35 and seven at 45, each run cut off by a dip to 10: 21 s over the
  // floor, and the pull is what the driver held on average, not the hardest second of it.
  const step = k => k % 10 < 8 ? (k < 10 || k >= 20 ? 45 : 35) : 10;
  const wobble = hardPulls(logOf(trace(30, 90, k => ({ power_kw: step(k), battery_temp_c: 5 }))));
  assert.equal(wobble.length, 1, "the dips are under MERGE_MS, so one pull");
  near(wobble[0].seconds, 21, 1e-9);
  near(wobble[0].kw, (7 * 45 + 7 * 35 + 7 * 45) / 21, 1e-9);

  // A gap of exactly five seconds is still one pull: where the merge gives way is as much the rule as
  // the five seconds is. Half a minute apart, and the harder of the two is the one the card shows first.
  const gapped = kw => hardPulls(logOf(trace(60, 90, k => ({ power_kw: k < 10 ? 45 : k > 50 ? kw : 10, battery_temp_c: 5 }))));
  assert.equal(hardPulls(logOf(trace(20, 90, k => ({ power_kw: k <= 5 || k >= 10 ? 45 : 10, battery_temp_c: 5 })))).length, 1);
  assert.equal(gapped(45).length, 2);
  assert.deepEqual(gapped(60).map(m => m.at), [START + 50000, START], "hardest first, whenever it happened");

  // The pack is read where the pull began, not where it ended: this driver floored it on a cold pack.
  const [cold] = hardPulls(logOf(trace(20, 90, k => ({ power_kw: 50, battery_temp_c: k < 1 ? 5 : 15 }))));
  assert.equal(cold.packC, 5);

  // A log with no temperature and no charge cannot say whether a pack was weak; power alone is not enough.
  assert.equal(hardPulls(logOf(trace(20, 90, () => ({ power_kw: 50 })))), null);
});

test("per cell: the mean mV each one sat from the pack median", () => {
  // Cell 7 is 30 mV low for the first reading, 10 mV low for the second: −20 mV on average. The median of
  // 96 cells with one of them low is the value of the other 95, so every other cell sits at nought.
  const log = logOf(trace(60, 36, k => ({})).map((p, k) => ({ ...p, cells: pack(k < 30 ? 30 : 10, 7) })));
  const { mv, readings } = cellMeans(log);
  assert.equal(readings, 2);
  assert.equal(mv.length, 96);
  near(mv[6], -20, 1e-9);
  near(mv[0], 0, 1e-9);
  near(mv[95], 0, 1e-9);
});

test("cell spread is split by charge band and only read at low current", () => {
  // Four readings: 40 mV of spread at 90 % and at 70 %, 100 mV at 30 % under load, and 100 mV at 50 %
  // under heavy regen - which is current flowing the other way, and just as far from a resting pack.
  const at = { 0: [40, 90, 2], 20: [40, 70, 2], 40: [100, 30, 60], 50: [100, 50, -110] };
  const points = trace(60, 36).map((p, k) => at[k]
    ? { ...p, cells: pack(at[k][0], 7), ev: { ...p.ev, soc_percent: at[k][1], current_a: at[k][2] } }
    : { ...p, ev: { ...p.ev, soc_percent: k < 20 ? 90 : k < 40 ? 70 : 30 } });
  const bands = cellSpread(logOf(points));
  assert.equal(bands.length, SOC_BANDS.length);
  near(bands[4].mv, 40, 1e-6);   // 80-100 %
  near(bands[3].mv, 40, 1e-6);   // 60-80 %
  assert.equal(bands[1].mv, null, "60 A is not a resting pack, so 20-40 % has no reading");
  assert.equal(bands[1].readings, 0);
  assert.equal(bands[2].mv, null, "−110 A is a pack under heavy regen, which spreads as wide as one under load");
  assert.equal(bands[2].readings, 0);
  assert.equal(bands[0].mv, null);
});

test("a short reply at the head of a drive does not throw the whole pack away", () => {
  // The car answered once with a truncated response, then 96 cells for the rest of the drive. The pack is
  // the commonest reply, not the first one: the odd reply is the one left out.
  const cells = k => k === 0 ? [3.7, 3.69] : pack(30, 7);
  const log = logOf(trace(60, 36, () => ({})).map((p, k) => (k % 20 ? p : { ...p, cells: cells(k) })));
  const { mv, readings } = cellMeans(log);
  assert.equal(readings, 3, "the three 96-cell replies, not the one short one");
  assert.equal(mv.length, 96);
  near(mv[6], -30, 1e-9);
});

test("a basic log knows nothing about the pack, and says so", () => {
  // Extended data off: GPS speed and nothing else.
  const points = Array.from({ length: 121 }, (_, k) => ({ t: START + k * 1000, lat: 48.1 + k * 36 * DEGREE_S, lon: 17.1, speedMs: 10 }));
  const b = measureBattery(parseGpx(gpxLog({ points })));
  assert.equal(b.lowCharge, null);
  assert.equal(b.jumps, null);
  assert.equal(b.hardPulls, null, "no power and no pack state: unknown, not nought");
  assert.equal(b.cells, null);
  assert.equal(b.cellSpread, null);
  assert.deepEqual(Object.entries(b.carEvents), []);
});

test("the car's events are counted by type", () => {
  const points = trace(30, 36, () => ({ soc_percent: 50 }));
  points[5] = { ...points[5], name: "Cell drop", desc: "#7", type: "cell" };
  points[9] = { ...points[9], name: "Cell drop", desc: "#7", type: "cell" };
  points[20] = { ...points[20], name: "Charge jump", desc: "50 → 41 %", type: "soc" };
  // A type out of somebody's file is not a key on Object.prototype: __proto__ is counted like any other.
  points[25] = { ...points[25], name: "Odd", desc: "", type: "__proto__" };
  const log = parseGpx(gpxLog({ points, fields: { soc_percent: ["Charge", "%"] } }));
  assert.deepEqual(Object.entries(measureBattery(log).carEvents).sort(), [["__proto__", 1], ["cell", 2], ["soc", 1]]);
});

test("driving on an empty pack keeps the ground crossed on a step of no length", () => {
  // The app writes two points a second against a clock of whole seconds, so pairs share a timestamp.
  // A minute at 36 km/h (10 m/s) under 5 % is one stretch of 600 m, not half of one cut into pieces.
  const points = [];
  for (let h = 0; h <= 120; h++) {
    points.push({
      t: START + Math.floor(h / 2) * 1000, lat: 48.1 + h * 0.5 * 36 * DEGREE_S, lon: 17.1,
      ev: { speed_kmh: 36, soc_percent: h === 0 ? 3 : null },
    });
  }
  const moments = lowCharge(logOf(points));
  assert.deepEqual(moments.map(m => m.soc), [3], "one point of charge, one stretch");
  near(under(moments, 5), 60, 1e-9);
  near(under(moments, 5, "km"), 60 * 10 / 1000, 1e-3);
});
