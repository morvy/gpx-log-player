import { test } from "node:test";
import assert from "node:assert/strict";
import { haversineKm } from "../stats/num.js";
import { LIMITS } from "../stats/settings.js";
import {
  KWH_PER_POINT, CHARGE_BANDS, learnKwhPerPoint, findCharges, curveCharges, chargingCurve,
  bandUse, chargeMinutes, tripPlan, noSocCount,
} from "../stats/charges.js";

/** The curve as the page draws it: the charges the limits allow, then the bands off those. */
const curveOf = (charges, limits = LIMITS) => chargingCurve(curveCharges(charges, limits));

const near = (actual, expected, tolerance) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

const HOUR = 3.6e6;
const START = Date.UTC(2026, 8, 14, 7, 0, 0);
// A metre of latitude on the player's 6371 km earth, so a distance between two drives can be asked for exactly.
const METRE = 1 / 111194.93;

/** A stored summary, with only the fields the charges read - the rest of a drive says nothing about charging. */
const drive = (o = {}) => ({
  id: "f:0", fileId: "f", file: "drive.gpx", start: START, end: START + HOUR, km: 50,
  energy: null, socStart: null, socEnd: null, outsideTemp: null, habits: null,
  startLat: 48.1, startLon: 17.1, endLat: 48.1, endLon: 17.1, ...o,
});

/** Two drives with a gap between them: [gapMs] apart, the charge going from [from] to [to], [movedM] down the road. */
const gap = ({ from, to, gapMs = HOUR, movedM = 0, ...rest }) => [
  drive({ id: "a:0", fileId: "a", socStart: from + 20, socEnd: from, ...rest }),
  drive({
    id: "b:0", fileId: "b", socStart: to, socEnd: to - 10,
    start: START + HOUR + gapMs, end: START + 2 * HOUR + gapMs,
    startLat: 48.1 + movedM * METRE, endLat: 48.1 + movedM * METRE, ...rest,
  }),
];

// ---------- the size of a point of charge ----------

test("a point of charge is the 0.244 kWh default until three drives have said otherwise", () => {
  const used = [
    drive({ socStart: 90, socEnd: 80, energy: 3 }),
    drive({ socStart: 80, socEnd: 70, energy: 3 }),
  ];
  const two = learnKwhPerPoint(used);
  assert.equal(two.learned, false);
  assert.equal(two.kwh, 0.244);
  assert.equal(KWH_PER_POINT, 0.244);
  assert.equal(two.drives, 2);

  // The third drive makes it learnable: 9 kWh over 30 points is 0.3 kWh a point.
  const three = learnKwhPerPoint([...used, drive({ socStart: 70, socEnd: 60, energy: 3 })]);
  assert.equal(three.learned, true);
  assert.equal(three.drives, 3);
  near(three.kwh, 0.3, 1e-12);
});

test("a drive has to have used five points before it says how big a point is", () => {
  // Exactly five counts; 4.9 does not. Four drives, so only the qualifying ones decide whether three exist.
  const four = n => [0, 1, 2, 3].map(k => drive({ id: `d${k}:0`, socStart: 90, socEnd: 90 - n, energy: n * 0.5 }));
  assert.equal(learnKwhPerPoint(four(5)).learned, true);
  near(learnKwhPerPoint(four(5)).kwh, 0.5, 1e-12);
  assert.equal(learnKwhPerPoint(four(4.9)).learned, false);
});

test("driving that used no energy at all leaves the default in place", () => {
  // A pack cannot be worth nought a point: a set of drives whose energy adds up to nothing is broken
  // data, not a learned figure, and dividing every charge by it would make every charge free.
  const odd = [
    drive({ id: "d0:0", socStart: 90, socEnd: 80, energy: 3 }),
    drive({ id: "d1:0", socStart: 80, socEnd: 70, energy: -3 }),
    drive({ id: "d2:0", socStart: 70, socEnd: 60, energy: 0 }),
  ];
  assert.equal(learnKwhPerPoint(odd).learned, false);
  assert.equal(learnKwhPerPoint(odd).kwh, 0.244);
});

test("a drive with no charge reading, or no energy, says nothing about the size of a point", () => {
  const basic = [0, 1, 2].map(k => drive({ id: `d${k}:0`, socStart: null, socEnd: null, energy: 10 }));
  assert.equal(learnKwhPerPoint(basic).drives, 0);
  const noEnergy = [0, 1, 2].map(k => drive({ id: `d${k}:0`, socStart: 90, socEnd: 80, energy: null }));
  assert.equal(learnKwhPerPoint(noEnergy).drives, 0);
});

test("a drive whose charge went up across itself says nothing about the size of a point", () => {
  // splitDrives cuts a drive at a rise of five points over a minute or more, so a slow charge inside a
  // drive with sparse charge readings stays in one piece: it ends on more charge than it set off with.
  // That is a charge, not a fall, and feeding its size in as if it were one would move every charge on
  // the page. Four drives, so three qualifying ones exist either way and only the rise decides.
  const rising = [
    drive({ id: "d0:0", socStart: 90, socEnd: 80, energy: 3 }),
    drive({ id: "d1:0", socStart: 80, socEnd: 70, energy: 3 }),
    drive({ id: "d2:0", socStart: 70, socEnd: 60, energy: 3 }),
    drive({ id: "d3:0", socStart: 20, socEnd: 60, energy: 2 }),
  ];
  assert.equal(learnKwhPerPoint(rising).drives, 3, "the drive that charged is not one of them");
  near(learnKwhPerPoint(rising).kwh, 0.3, 1e-12);
});

// ---------- charges between drives ----------

test("a charge is the gap two drives left, and its kW is averaged over the whole of it", () => {
  // 40 % to 80 % is 40 points; at 0.25 kWh a point that is 10 kWh, and over two hours 5 kW.
  const [c] = findCharges(gap({ from: 40, to: 80, gapMs: 2 * HOUR }), LIMITS, 0.25);
  assert.equal(c.points, 40);
  near(c.kwh, 10, 1e-12);
  near(c.kw, 5, 1e-12);
  near(c.hours, 2, 1e-12);
  assert.equal(c.dc, false, "5 kW is a socket, not a DC charger");
  assert.equal(c.at, START + HOUR, "the charge starts where the drive before it stopped");
});

test("five points is a charge, four is the BMS changing its mind", () => {
  assert.equal(findCharges(gap({ from: 50, to: 55 }), LIMITS, 0.25).length, 1);
  assert.equal(findCharges(gap({ from: 50, to: 54 }), LIMITS, 0.25).length, 0);
  // And the rise is the limit, not the constant: raising it drops the charge that was just found.
  assert.equal(findCharges(gap({ from: 50, to: 55 }), { ...LIMITS, chargeRise: 6 }, 0.25).length, 0);
});

test("exactly 8 kW is DC; a shade under it is not", () => {
  // 8 points at 0.25 is 2 kWh; over a quarter of an hour that is exactly 8 kW.
  const [dc] = findCharges(gap({ from: 50, to: 58, gapMs: 0.25 * HOUR }), LIMITS, 0.25);
  near(dc.kw, 8, 1e-12);
  assert.equal(dc.dc, true);
  const [ac] = findCharges(gap({ from: 50, to: 58, gapMs: 0.26 * HOUR }), LIMITS, 0.25);
  assert.ok(ac.kw < 8);
  assert.equal(ac.dc, false);
});

test("a car that came back somewhere else was driven there unlogged", () => {
  const far = findCharges(gap({ from: 40, to: 80, movedM: 500 }), LIMITS, 0.25)[0];
  assert.equal(far.moved, true);
  near(far.movedM, 500, 0.5);
  assert.equal(findCharges(gap({ from: 40, to: 80, movedM: 200 }), LIMITS, 0.25)[0].moved, false);
  // Exactly at the limit is not moved: asking for the distance the pair actually has pins the comparison
  // itself, which no pair of round numbers either side of 300 m can do.
  const exact = haversineKm(48.1, 17.1, 48.1 + 300 * METRE, 17.1) * 1000;
  assert.equal(findCharges(gap({ from: 40, to: 80, movedM: 300 }), { ...LIMITS, movedM: exact }, 0.25)[0].moved, false);
});

test("the 300 m default is pinned from both sides, not to the nearest fifty", () => {
  // 320 m is over the default and 280 m is under it: a default moved either way by fifty metres is a
  // different answer for this car on this charge, and the boundary fixture above alone would not say so.
  assert.equal(findCharges(gap({ from: 40, to: 80, movedM: 320 }), LIMITS, 0.25)[0].moved, true);
  assert.equal(findCharges(gap({ from: 40, to: 80, movedM: 280 }), LIMITS, 0.25)[0].moved, false);
});

test("a charge is measured and placed where the drive before it ended, not where that drive began", () => {
  // Home, then 30 km north to the charger; the car is left 200 m up the road from where it stopped and
  // driven on from there. The gap is 200 m - the car did not go anywhere - and the charge belongs at the
  // charger. Measured from the start of the drive instead, the 30 km it covered would read as the car
  // having been moved, and the charge would be struck off the curve; pinned to the start of the next
  // drive instead, the map would put it 200 m away.
  const charger = 48.1 + 30000 * METRE;
  const home = drive({ id: "a:0", fileId: "a", socStart: 60, socEnd: 20, startLat: 48.1, endLat: charger });
  const on = drive({
    id: "b:0", fileId: "b", socStart: 70, socEnd: 50, start: START + 2 * HOUR, end: START + 3 * HOUR,
    startLat: charger + 200 * METRE, endLat: 48.2,
  });
  const [c] = findCharges([home, on], LIMITS, 0.25);
  near(c.movedM, 200, 0.5);
  assert.equal(c.moved, false);
  assert.equal(c.lat, charger, "the pin sits where the car was plugged in");
  assert.equal(c.lon, home.endLon);
  assert.equal(c.fileId, "a");
});

test("no charge is found where the drive that would carry the reading has none", () => {
  const [a, b] = gap({ from: 40, to: 80 });
  assert.equal(findCharges([{ ...a, socEnd: null }, b], LIMITS, 0.25).length, 0);
  assert.equal(findCharges([a, { ...b, socStart: null }], LIMITS, 0.25).length, 0);
});

test("a drive with a charge level at only one end breaks the chain, as a basic log does not", () => {
  // socStart known, socEnd null (Extended data switched off mid-drive): it still pairs as the far end
  // of one real charge, but it cannot carry the chain onward - it is not a basic log (skippedM), and it
  // is not a full anchor either, so the drive after it must not be able to reach back past it.
  const a = drive({ id: "a:0", fileId: "a", socEnd: 60 });
  const x = drive({ id: "x:0", fileId: "x", socStart: 65, socEnd: null, km: 20, start: START + 2 * HOUR, end: START + 3 * HOUR });
  const c = drive({ id: "c:0", fileId: "c", socStart: 90, socEnd: 20, start: START + 4 * HOUR, end: START + 5 * HOUR });
  const found = findCharges([a, x, c], LIMITS, 0.25);
  assert.equal(found.length, 1, "only the real 60→65 charge, no bogus 60→90 one reaching past x");
  assert.equal(found[0].from, 60);
  assert.equal(found[0].to, 65);
  assert.equal(found[0].at, a.end);
  assert.equal(found[0].until, x.start);
});

test("a drive with a charge level at only its end, not its start, still becomes the anchor - it just cannot be paired as the far end of a charge", () => {
  const a = drive({ id: "a:0", fileId: "a", socEnd: 60 });
  const y = drive({ id: "y:0", fileId: "y", socStart: null, socEnd: 70, start: START + 2 * HOUR, end: START + 3 * HOUR });
  const c = drive({ id: "c:0", fileId: "c", socStart: 90, socEnd: 20, start: START + 4 * HOUR, end: START + 5 * HOUR });
  const found = findCharges([a, y, c], LIMITS, 0.25);
  assert.equal(found.length, 1, "only 70→90, off the newer anchor y - a→y never pairs since y has no socStart");
  assert.equal(found[0].from, 70);
  assert.equal(found[0].to, 90);
});

test("a basic log between two full ones is skipped, not a break in the chain: the charge either side of it is still found", () => {
  // The real case this fixes: a GPS-only drive (Extended data off) sitting between two drives that do
  // carry the charge level used to hide the charge between them entirely.
  const [a, b] = gap({ from: 40, to: 80 });
  const basic = drive({ id: "m:0", fileId: "m", socStart: null, socEnd: null, km: 0, start: START + 2 * HOUR, end: START + 3 * HOUR });
  const [c] = findCharges([a, basic, { ...b, start: START + 4 * HOUR, end: START + 5 * HOUR }], LIMITS, 0.25);
  assert.equal(c.points, 40);
  assert.equal(c.moved, false, "the basic log covered no distance, so nothing says the car moved");
  assert.equal(c.at, a.end);
});

test("a basic log with real distance keeps the charge listed but marks it moved", () => {
  const [a, b] = gap({ from: 40, to: 80 });
  const basic = drive({ id: "m:0", fileId: "m", socStart: null, socEnd: null, km: 5, start: START + 2 * HOUR, end: START + 3 * HOUR });
  const [c] = findCharges([a, basic, { ...b, start: START + 4 * HOUR, end: START + 5 * HOUR }], LIMITS, 0.25);
  assert.equal(c.points, 40);
  assert.equal(c.moved, true, "5 km of unlogged driving is well past the 300 m the car may sit from where it stopped");
});

test("two consecutive basic logs are both skipped, and the charge either side of them is still one charge", () => {
  const [a, b] = gap({ from: 40, to: 80 });
  const m1 = drive({ id: "m1:0", fileId: "m1", socStart: null, socEnd: null, km: 0, start: START + 2 * HOUR, end: START + 2.5 * HOUR });
  const m2 = drive({ id: "m2:0", fileId: "m2", socStart: null, socEnd: null, km: 0, start: START + 2.5 * HOUR, end: START + 3 * HOUR });
  const found = findCharges([a, m1, m2, { ...b, start: START + 4 * HOUR, end: START + 5 * HOUR }], LIMITS, 0.25);
  assert.equal(found.length, 1);
  assert.equal(found[0].points, 40);
  assert.equal(found[0].moved, false);
});

test("a gap of no time at all has no kW to speak of", () => {
  // The next drive began the instant the last one ended: dividing by that gap would report a charger
  // of infinite power, and one glance at the curve would be the last honest thing on the page.
  const [c] = findCharges(gap({ from: 40, to: 80, gapMs: 0 }), LIMITS, 0.25);
  assert.equal(c.kw, null);
  assert.equal(c.dc, false);
  assert.equal(curveOf([c])[2].charges, 0);
});

test("the charges come out in the order the driving happened, whatever order the files were added in", () => {
  const [a, b] = gap({ from: 40, to: 80 });
  const later = { ...b, id: "c:0", fileId: "c", socStart: 90, socEnd: 60, start: START + 6 * HOUR, end: START + 7 * HOUR };
  const found = findCharges([later, b, a], LIMITS, 0.25);
  assert.equal(found.length, 2);
  assert.ok(found[0].at < found[1].at);
});

test("noSocCount counts the drives that carry a charge level at neither end", () => {
  const full = drive({ socStart: 80, socEnd: 60 });
  const half = drive({ id: "h:0", socStart: 80, socEnd: null });
  const basic = drive({ id: "b:0", socStart: null, socEnd: null });
  assert.equal(noSocCount([full, half, basic]), 1);
  assert.equal(noSocCount([full]), 0);
  assert.equal(noSocCount([basic, basic]), 2);
  assert.equal(noSocCount([]), 0);
});

// ---------- the charging curve ----------

// Two DC charges worked out by hand, each half an hour at 0.25 kWh a point:
//   X  20 -> 70 %, 50 points, 12.5 kWh, 25 kW
//   Y  50 -> 90 %, 40 points, 10 kWh,   20 kW
// Band by band, weighted by how much of the band each charge covered:
//   0-20   nothing
//   20-40  X over all 20 points                       -> 25 kW,   1 charge
//   40-60  X over 20, Y over 10: (25x20 + 20x10) / 30 -> 23.33 kW, 2 charges
//   60-70  X over 10, Y over 10: (25x10 + 20x10) / 20 -> 22.5 kW,  2 charges
//   70-80  Y over 10                                  -> 20 kW,   1 charge
//   80-90  Y over 10                                  -> 20 kW,   1 charge
//   90-100 nothing
const twoCharges = () => findCharges([
  drive({ id: "a:0", fileId: "a", socStart: 60, socEnd: 20 }),
  drive({ id: "b:0", fileId: "b", socStart: 70, socEnd: 50, start: START + 1.5 * HOUR, end: START + 2.5 * HOUR }),
  drive({ id: "c:0", fileId: "c", socStart: 90, socEnd: 30, start: START + 3 * HOUR, end: START + 4 * HOUR }),
], LIMITS, 0.25);

test("the curve is each band's charges, weighted by how much of the band they covered", () => {
  const charges = twoCharges();
  assert.equal(charges.length, 2);
  near(charges[0].kw, 25, 1e-12);
  near(charges[1].kw, 20, 1e-12);

  const curve = curveOf(charges);
  assert.deepEqual(curve.map(b => b.from), CHARGE_BANDS.slice(0, -1));
  assert.deepEqual(curve.map(b => b.charges), [0, 1, 2, 2, 1, 1, 0]);
  assert.equal(curve[0].kw, null, "a band no charge covered has no data, not a nought");
  assert.equal(curve[6].kw, null);
  near(curve[1].kw, 25, 1e-12);
  near(curve[2].kw, 700 / 30, 1e-12);
  near(curve[3].kw, 22.5, 1e-12);
  near(curve[4].kw, 20, 1e-12);
  near(curve[5].kw, 20, 1e-12);
});

test("only a DC charge, in one place, over a gap of two hours or less, is on the curve", () => {
  const dc = () => findCharges(gap({ from: 20, to: 90, gapMs: 2 * HOUR }), LIMITS, 0.25);
  // 70 points over two hours is 8.75 kW: DC, and the gap is exactly the two hours the curve allows.
  near(dc()[0].kw, 8.75, 1e-12);
  assert.equal(curveOf(dc())[1].charges, 1);

  const slow = findCharges(gap({ from: 20, to: 90, gapMs: 2 * HOUR + 1 }), LIMITS, 0.25);
  assert.equal(curveOf(slow)[1].charges, 0, "a gap over two hours is a night, not a charge to time");

  const ac = findCharges(gap({ from: 20, to: 90, gapMs: 4 * HOUR }), LIMITS, 0.25);
  assert.equal(curveOf(ac)[1].charges, 0);

  const moved = findCharges(gap({ from: 20, to: 90, gapMs: 2 * HOUR, movedM: 400 }), LIMITS, 0.25);
  assert.equal(curveOf(moved)[1].charges, 0, "a car driven between the two drives cannot time its charge");
});

// ---------- the speed bands a trip is planned from ----------

/** A drive of [km] in the band starting at [from] km/h, at [kmh] and [per100] kWh/100 km. */
const banded = (from, km, kmh, per100, rest = {}) => drive({
  id: `${from}-${km}-${rest.outsideTemp}:0`,
  habits: {
    bands: [0, 30, 50, 70, 90, 110, 130].map(b => b === from
      ? { seconds: km / kmh * 3600, km, energy: km * per100 / 100, energyKm: km }
      : { seconds: 0, km: 0, energy: 0, energyKm: 0 }),
  },
  ...rest,
});

test("bandUse adds the bands of every drive, and says nothing where no drive measured energy", () => {
  const bands = bandUse([banded(90, 100, 100, 20), banded(90, 50, 100, 26)]);
  near(bands[4].km, 150, 1e-9);
  near(bands[4].per100, (20 + 26 * 0.5) / 1.5, 1e-9);
  assert.equal(bands[0].kmh, null);
  assert.equal(bands[0].per100, null);
});

test("a basic log brings its kilometres to a band and no energy, and does not dilute the consumption", () => {
  // One drive with Extended data off. Its 100 km count towards the band's speed and
  // towards the 20 km a speed has to have before it can be planned at, but it measured no kWh - so the
  // band's consumption is the 20 kWh the full log used over the 100 km the full log covered, not over 200.
  const basic = banded(90, 100, 100, 0);
  basic.habits.bands[4] = { seconds: 100 / 100 * 3600, km: 100, energy: null, energyKm: 0 };
  const bands = bandUse([banded(90, 100, 100, 20), basic]);
  near(bands[4].km, 200, 1e-9);
  near(bands[4].energyKm, 100, 1e-9);
  near(bands[4].per100, 20, 1e-9);
});

test("kilometres a drive measured no power over do not dilute its band's consumption either", () => {
  // One drive whose power column exists and is half blank: powerOf returns it on a single valid reading,
  // so the band has an energy figure for half its distance. Divided by the whole distance, a motorway
  // band would read 10 kWh/100 km and every plan built on it would run out of charge short of the stop.
  const half = banded(90, 100, 100, 20);
  half.habits.bands[4] = { ...half.habits.bands[4], energyKm: 50, energy: 10 };
  near(bandUse([half])[4].per100, 20, 1e-9);
});

// ---------- the trip calculator ----------

// A curve that is flat at 60 kW to 80 % and then slows, the shape of a real DC charge. At 0.25 kWh a
// point, a point takes 0.25 / 60 h = 15 s at 60 kW, 45 s at 20 kW and 90 s at 10 kW.
const CURVE = chargingCurve([]).map((b, i) => ({ ...b, kw: [60, 60, 60, 60, 60, 20, 10][i] }));
const PER_POINT = 0.25;

// One speed, worked out by hand:
//   100 km/h at 20 kWh/100 km, so 0.2 kWh a km, and at 0.25 kWh a point that is 0.8 points a km.
//   200 km therefore costs 160 points, and 40 kWh.
//   Starting at 100 % with 10 % to arrive on, the first leg has 90 points = 112.5 km in it.
//   87.5 km are left, which need 70 points, so the one stop must reach 10 + 70 = 80 %.
//   Charging 10 -> 80 % is 70 points, every one of them in a 60 kW band: 70 x 15 s = 17.5 min.
//   Driving 200 km at 100 km/h is 120 min, the stop costs 5 min: 142.5 min in all, arriving on 10 %.
const FAST = { band: 4, from: 90, to: 110, kmh: 100, km: 500, per100: 20, atTemp: true };
const TRIP = { curve: CURVE, km: 200, socStart: 100, socMin: 10, stopMinutes: 5, perPoint: PER_POINT };

test("a trip at one speed, end to end, against numbers worked out by hand", () => {
  const [row] = tripPlan({ ...TRIP, speeds: [FAST] });
  assert.equal(row.stops, 1);
  assert.equal(row.target, 80, "the last stop charges only enough to finish, so every level from 80 up plans the same");
  near(row.driving, 120, 1e-9);
  near(row.charging, 17.5, 1e-9);
  near(row.waiting, 5, 1e-9);
  near(row.total, 142.5, 1e-9);
  near(row.arrival, 10, 1e-9);
  near(row.kwh, 40, 1e-9);
});

test("a trip inside the first leg needs no stop at all", () => {
  const [row] = tripPlan({ ...TRIP, km: 100, speeds: [FAST] });
  assert.equal(row.stops, 0);
  near(row.charging, 0, 1e-12);
  near(row.total, 60, 1e-9);
  // 100 km costs 80 points, so the car arrives on 20 % with nothing charged.
  near(row.arrival, 20, 1e-9);
});

test("charging to the top costs more than it saves, so a level below it is chosen", () => {
  // 250 km needs 200 points and the pack starts with 90 of them: 110 points to charge whatever the level.
  // Filling to 100 % puts 20 of them in the 20 kW and 10 kW bands (7.5 + 15 min against 5 min at 60 kW),
  // so the plan that stops twice below 80 % is the faster one even though it charges the same energy.
  const [row] = tripPlan({ ...TRIP, km: 250, speeds: [FAST] });
  assert.equal(row.stops, 2);
  assert.ok(row.target <= 80, `charged to ${row.target} %`);
  near(row.charging, 110 * 0.25, 1e-9);           // 110 points, all of them at 60 kW: 15 s each
  near(row.total, 150 + 27.5 + 10, 1e-9);
  near(row.arrival, 10, 1e-9);
});

test("a band with no data stops the level, not the trip", () => {
  // Nothing has ever been charged through 70-80 %, so the single stop at 80 % the full curve planned is
  // gone and the trip takes two - but it is still a trip. The 70 points it charges cost the same either
  // way, so the level chosen is the lowest that gets there in two stops: 45 %.
  const holed = CURVE.map(b => b.from === 70 ? { ...b, kw: null } : b);
  const [row] = tripPlan({ ...TRIP, curve: holed, speeds: [FAST] });
  assert.equal(row.blocked, undefined);
  assert.equal(row.target, 45);
  assert.equal(row.stops, 2);
  near(row.charging, 17.5, 1e-9);
  near(row.total, 120 + 17.5 + 10, 1e-9);
});

test("a speed is not plannable past a band no charge has ever covered", () => {
  // The hole is at 20-40 %, which every level from 30 % up has to charge through.
  const holed = CURVE.map(b => b.from === 20 ? { ...b, kw: null } : b);
  const [row] = tripPlan({ ...TRIP, curve: holed, speeds: [FAST] });
  assert.equal(row.total, undefined);
  assert.equal(row.blocked.from, 20, "the lowest band that stopped it is the one the page names");
  assert.equal(row.blocked.to, 40);
});

test("charging time is read off the curve band by band", () => {
  // 10 -> 90 % is 80 points: 70 of them at 60 kW (17.5 min) and 10 at 20 kW (7.5 min).
  const step = chargeMinutes(CURVE, 10, 90, PER_POINT);
  near(step.minutes, 25, 1e-9);
  assert.equal(step.blocked, null);
  assert.equal(chargeMinutes(CURVE, 10, 10, PER_POINT).minutes, 0, "charging to where it already is takes no time");

  const holed = CURVE.map(b => b.from === 40 ? { ...b, kw: null } : b);
  assert.equal(chargeMinutes(holed, 10, 90, PER_POINT).minutes, null);
  assert.equal(chargeMinutes(holed, 10, 40, PER_POINT).minutes, 7.5, "a hole above the charge does not stop it");
});

// The same car on a curve that never slows down, for the plans where what is being pinned is which
// level was chosen rather than what the top of the curve costs.
const FLAT = CURVE.map(b => ({ ...b, kw: 60 }));

test("the last stop takes the two points it needs and not a level off a list", () => {
  // 115 km is 92 points; the pack sets off with 90 of them, so the one stop has two points to put back.
  // Charging them takes half a minute, and the car still arrives on the 10 % it was told to keep.
  const [row] = tripPlan({ ...TRIP, km: 115, speeds: [FAST] });
  assert.equal(row.stops, 1);
  assert.equal(row.target, 30, "every level plans the same trip, so the lowest tried is the one reported");
  near(row.charging, 0.5, 1e-9);
  near(row.arrival, 10, 1e-9);
  near(row.total, 69 + 0.5 + 5, 1e-9);
});

test("a trip that only fits in one stop if the car fills right up", () => {
  // 225 km is 180 points; 90 of them are in the pack, and the other 90 fit in one stop only by going
  // all the way to 100 %. Anything less is a second stop, and on this curve the top costs no more.
  const [row] = tripPlan({ ...TRIP, curve: FLAT, km: 225, speeds: [FAST] });
  assert.equal(row.target, 100);
  assert.equal(row.stops, 1);
  near(row.charging, 22.5, 1e-9);
  near(row.total, 135 + 22.5 + 5, 1e-9);
});

test("a long trip stops as many times as it has to", () => {
  // 1,000 km is 800 points against a pack that holds 90 of them at a time: eight stops, and the plan
  // has to keep going rather than give up part-way down the road.
  const [row] = tripPlan({ ...TRIP, curve: FLAT, km: 1000, speeds: [FAST] });
  assert.equal(row.stops, 8);
  near(row.charging, 710 * 0.25, 1e-9);
  near(row.arrival, 10, 1e-9);
});

test("a slower speed uses less energy and stops less often", () => {
  const slow = { ...FAST, band: 3, from: 70, to: 90, kmh: 80, per100: 16 };
  const rows = tripPlan({ ...TRIP, km: 300, speeds: [FAST, slow] });
  assert.deepEqual(rows.map(r => r.speed.kmh), [100, 80]);
  assert.ok(rows[1].kwh < rows[0].kwh);
  assert.ok(rows[1].stops <= rows[0].stops);
  assert.ok(rows[1].driving > rows[0].driving, "the slower speed is longer on the road");
});

test("a trip that cannot be started is no plan at all", () => {
  // Arriving on more charge than the car set off with.
  assert.equal(tripPlan({ ...TRIP, socStart: 5, speeds: [FAST] })[0].total, undefined);
  assert.equal(tripPlan({ ...TRIP, km: 0, speeds: [FAST] })[0].total, undefined);
});

test("the band the driver is told to worry about is the lowest one with no data", () => {
  // Two holes, at 20-40 % and at 80-90 %. Every charge-to level the planner tries starts from the floor,
  // so the band that stops it is the low one - and that is the one the row has to name: told about
  // 80-90 % instead, the driver would set off thinking a stop below it would do.
  const holed = CURVE.map(b => b.from === 20 || b.from === 80 ? { ...b, kw: null } : b);
  const [row] = tripPlan({ ...TRIP, curve: holed, speeds: [FAST] });
  assert.equal(row.total, undefined);
  assert.equal(row.blocked.from, 20);
  assert.equal(row.blocked.to, 40);
});

test("a trip the pack finishes to the point is planned, not called unplannable", () => {
  // 114 km at 0.8 points a km is 91.2 points; the pack sets off with 90, so the one stop puts back 1.2 of
  // them and the car arrives on exactly the 10 % it was told to keep. The road left then costs exactly the
  // charge above the floor - which in binary is not exactly equal to it, and the loop ran one leg too far,
  // struck the speed out, and blamed a charging band that had nothing to do with it.
  const [row] = tripPlan({ ...TRIP, curve: FLAT, km: 114, speeds: [FAST] });
  assert.equal(row.blocked, undefined, "a plan, not an excuse");
  assert.equal(row.stops, 1);
  near(row.charging, 0.3, 1e-9);
  near(row.arrival, 10, 1e-9);
  near(row.total, 68.4 + 0.3 + 5, 1e-9);
  // 117 and 119 km land on the same edge from the other side of the rounding.
  for (const km of [117, 119]) assert.equal(tripPlan({ ...TRIP, curve: FLAT, km, speeds: [FAST] })[0].stops, 1);
});
