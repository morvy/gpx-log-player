import { test } from "node:test";
import assert from "node:assert/strict";
import { haversineKm } from "../stats/num.js";
import { weekStart } from "../stats/periods.js";
import { LIMITS } from "../stats/settings.js";
import { AC_BANDS, acBandOf, distancePerWeek, weekdayHours, places, tempScatter } from "../stats/patterns.js";

/** A stored summary with only the fields the patterns read. Times are local: weeks and hours are the driver's. */
const drive = (o = {}) => ({
  id: "f:0", fileId: "f", start: new Date(2026, 8, 14, 9).getTime(), end: new Date(2026, 8, 14, 10).getTime(),
  km: 10, per100: 15, outsideTemp: 18, acShare: 0.5, hourSeconds: new Array(24).fill(0),
  startLat: 48.1, startLon: 17.1, endLat: 48.2, endLon: 17.2, ...o,
});

/** A drive from [day] at [hour], as the page would store it. */
const on = (year, month, day, hour, o = {}) => drive({
  start: new Date(year, month, day, hour).getTime(), end: new Date(year, month, day, hour + 1).getTime(), ...o,
});

const seconds = (...pairs) => {
  const a = new Array(24).fill(0);
  for (const [hour, s] of pairs) a[hour] = s;
  return a;
};

// ---------- distance per week ----------

test("a week's kilometres are the week's, over the turn of a month", () => {
  // 30 September 2026 is a Wednesday: the week of Monday 28 September holds both days and both months.
  const weeks = distancePerWeek([
    on(2026, 8, 30, 9, { km: 12 }),
    on(2026, 9, 1, 9, { km: 8 }),
    on(2026, 9, 5, 9, { km: 40 }),
  ]);
  assert.deepEqual(weeks.map(w => [new Date(w.start).getDate(), w.km, w.drives]), [[28, 20, 2], [5, 40, 1]]);
  assert.equal(weeks[0].start, weekStart(new Date(2026, 8, 30).getTime()));
});

test("the week summer time ends is seven days, not 168 hours", () => {
  // The clocks go back on Sunday 25 October 2026, so that week is 169 hours long. A drive at half past
  // eleven that night is still the week of Monday the 19th; half past midnight is already the next week.
  const weeks = distancePerWeek([
    on(2026, 9, 19, 9, { km: 5 }),
    drive({ start: new Date(2026, 9, 25, 23, 30).getTime(), end: new Date(2026, 9, 25, 23, 50).getTime(), km: 7 }),
    drive({ start: new Date(2026, 9, 26, 0, 30).getTime(), end: new Date(2026, 9, 26, 0, 50).getTime(), km: 3 }),
  ]);
  assert.deepEqual(weeks.map(w => [new Date(w.start).getDate(), w.km]), [[19, 12], [26, 3]]);
  // Stepping by a fixed 7 × 24 h would land an hour into Monday and split the second week off on its own.
  assert.equal(weeks[1].start, weekStart(new Date(2026, 9, 26).getTime()));
  assert.equal(new Date(weeks[1].start).getHours(), 0);
});

test("a week nobody drove is a nought, and a drive with no distance is not counted", () => {
  const weeks = distancePerWeek([on(2026, 8, 7, 9, { km: 10 }), on(2026, 8, 28, 9, { km: 20 })]);
  assert.deepEqual(weeks.map(w => [w.km, w.drives]), [[10, 1], [0, 0], [0, 0], [20, 1]]);
  // Each on its own: a drive with no distance and a drive with no date have to be dropped separately,
  // or one of them covers for the other and the guard is only half tested.
  assert.deepEqual(distancePerWeek([drive({ km: NaN })]), []);
  assert.deepEqual(distancePerWeek([drive({ start: NaN })]), []);
  assert.deepEqual(distancePerWeek([]), []);
});

// ---------- the weekday × hour grid ----------

test("a drive over midnight gives its hours to the days they happened on", () => {
  // Sunday 13 September 2026, 22:30 to 00:30 on the Monday: 2 hours to the Sunday, one to the Monday.
  const grid = weekdayHours([drive({
    start: new Date(2026, 8, 13, 22, 30).getTime(), end: new Date(2026, 8, 14, 0, 30).getTime(),
    hourSeconds: seconds([22, 1800], [23, 3600], [0, 1800]),
  })]);
  assert.equal(grid[6][22], 1800, "Sunday is the last row, not the first");
  assert.equal(grid[6][23], 3600);
  assert.equal(grid[0][0], 1800, "half past midnight is Monday");
  assert.equal(grid[6][0], 0, "and not Sunday, where the hour of the day alone would have put it");
  assert.equal(grid.flat().reduce((a, b) => a + b, 0), 7200);
});

test("the hour a drive ends in still counts, even ending on the stroke of it", () => {
  const ending = (end, hourSeconds) => weekdayHours([drive({ start: new Date(2026, 8, 13, 22, 30).getTime(), end, hourSeconds })]);
  // Ends exactly at midnight: the walk has to take the hour it ends in, or the last bucket is dropped.
  assert.equal(ending(new Date(2026, 8, 14, 0, 0, 0).getTime(), seconds([23, 600], [0, 5]))[0][0], 5);
  // A second before midnight never reaches the Monday at all.
  assert.equal(ending(new Date(2026, 8, 13, 23, 59, 59).getTime(), seconds([23, 600], [0, 5]))[0][0], 0);
});

test("a drive of over a day gives each hour to the first day it ran through", () => {
  // The summary holds 24 buckets and no more, so an hour driven on both days is one figure: it lands once.
  const grid = weekdayHours([drive({
    start: new Date(2026, 8, 13, 5).getTime(), end: new Date(2026, 8, 14, 11).getTime(),
    hourSeconds: seconds([5, 900], [10, 600], [23, 300]),
  })]);
  assert.equal(grid[6][5], 900);
  assert.equal(grid[6][10], 600);
  // Eighteen hours after it set off, so the walk has to still be stepping by whole hours to reach it.
  assert.equal(grid[6][23], 300);
  assert.equal(grid[0][5], 0);
  assert.equal(grid[0][10], 0);
});

test("the hour that happens twice when the clocks go back is still one hour of driving", () => {
  // 25 October 2026, 02:00 to 03:00 runs twice where summer time is kept. The summary holds one figure for
  // the hour, so the grid must take it once: counting every visit to an hour would double this drive.
  const grid = weekdayHours([drive({
    start: new Date(2026, 9, 25, 1, 30).getTime(), end: new Date(2026, 9, 25, 3, 30).getTime(),
    hourSeconds: seconds([2, 1200]),
  })]);
  assert.equal(grid.flat().reduce((a, b) => a + b, 0), 1200, "once, whatever the clocks did");
  assert.equal(grid[6][2], 1200);
});

test("a summary from before the hours were stored says nothing rather than nought o'clock", () => {
  // An hour the summary does not hold is no driving, not a second of it, and a drive with no time to
  // place is left out whole. The grid is seven days of twenty-four hours whatever it is given.
  const grid = weekdayHours([drive({ hourSeconds: null }), drive({ hourSeconds: [] }), drive({ start: NaN }), drive({ end: NaN })]);
  assert.deepEqual(grid.flat().filter(Boolean), []);
  assert.deepEqual(grid.map(row => row.length), new Array(7).fill(24));
});

// ---------- places ----------

// A metre of latitude on the player's 6371 km earth: haversineKm over a difference of latitude alone is
// exactly 12742 · π/360 · Δlat, so a distance can be asked for by the metre.
const METRE = 1 / (12742 * Math.PI / 360 * 1000);
const parked = (lat, o = {}) => drive({ startLat: lat, startLon: 17.1, endLat: lat, endLon: 17.1, ...o });

test("two parkings inside the radius are one place, and just outside they are two", () => {
  const radius = LIMITS.placeRadiusM;
  const pair = m => [parked(48.1), parked(48.1 + m * METRE, { start: new Date(2026, 8, 15, 9).getTime() })];
  assert.equal(places(pair(radius - 1), radius).length, 1);
  assert.equal(places(pair(radius + 1), radius).length, 2);

  // The comparison itself, at the metre the radius is: a place exactly that far away is the same place.
  // The distance is measured with the same haversine the clustering uses, so this is a boundary and not a guess.
  const exact = haversineKm(48.1, 17.1, 48.1 + radius * METRE, 17.1) * 1000;
  assert.equal(places(pair(radius), exact).length, 1, "at exactly the radius, one place");
  assert.equal(places(pair(radius), exact - 1e-9).length, 2, "a billionth of a metre further, two");
});

test("a place is where its endpoints average, so a row of parkings joins along itself", () => {
  // Three stops 60 m apart with a radius of 100: the third is 120 m from the first and 90 m from the
  // centre the first two make, so it belongs to the place - which is what a long car park looks like.
  const row = [0, 60, 120].map((m, k) => parked(48.1 + m * METRE, {
    start: new Date(2026, 8, 14 + k, 9).getTime(), end: new Date(2026, 8, 14 + k, 10).getTime(),
  }));
  const [place] = places(row, 100);
  assert.equal(places(row, 100).length, 1);
  assert.equal(place.visits, 6, "three drives, each with a start and an end");
  assert.ok(Math.abs(place.lat - (48.1 + 60 * METRE)) < 1e-9, "the centre is the mean of its endpoints");
});

test("which endpoint seeds a chained place decides the places, so the order in time is part of the answer", () => {
  // One endpoint each, at 0, 0, 95 and 190 m along the same street, in that order in time. Forwards the
  // 95 m stop is still within 100 m of the three at nought and joins them; backwards it is within 100 m of
  // the 190 m stop and joins that instead, and the same five parkings come out as a different map. The
  // The chain direction is intentionally pinned here.
  const along = (m, day) => drive({
    startLat: 48.1 + m * METRE, startLon: 17.1, endLat: NaN, endLon: NaN,
    start: new Date(2026, 8, 14 + day, 9).getTime(),
  });
  const row = [along(0, 0), along(0, 1), along(0, 2), along(95, 3), along(190, 4)];
  const out = places(row, 100);
  assert.deepEqual(out.map(p => p.visits), [4, 1], "the 95 m stop joins the three at nought, not the 190 m one");
  // Its centre is where those four average - 23.75 m along - which is only true if it took them in time order.
  assert.ok(Math.abs(out[0].lat - (48.1 + 23.75 * METRE)) < 1e-12);
  assert.equal(out[1].visits, 1);
});

test("a place counts how often it is used and how far the driving from it went", () => {
  const home = { startLat: 48.1, startLon: 17.1 };
  const away = { endLat: 49, endLon: 18 };
  const out = places([
    drive({ ...home, ...away, km: 30, start: new Date(2026, 8, 14, 8).getTime(), end: new Date(2026, 8, 14, 9).getTime() }),
    drive({ startLat: 49, startLon: 18, endLat: 48.1, endLon: 17.1, km: 40, start: new Date(2026, 8, 14, 17).getTime(), end: new Date(2026, 8, 14, 18).getTime() }),
    drive({ ...home, ...away, km: 32, start: new Date(2026, 8, 15, 8).getTime(), end: new Date(2026, 8, 15, 9).getTime() }),
  ], LIMITS.placeRadiusM);
  assert.equal(out.length, 2);
  const [first, second] = out;
  assert.equal(first.visits, 3, "busiest first");
  assert.equal(first.setOffs, 2);
  assert.equal(first.stops, 1);
  assert.equal(first.km, 62, "the kilometres driven away from it, not the ones driven back to it");
  assert.equal(second.visits, 3);
  assert.equal(second.km, 40);
  // Equal visits, so the place first used comes first - the order must not depend on the sort being stable.
  assert.ok(first.first < second.first);
  assert.equal(first.first, new Date(2026, 8, 14, 8).getTime());
  assert.equal(second.last, new Date(2026, 8, 15, 9).getTime());
});

test("the busiest place comes first, and the order does not follow the order the drives arrived in", () => {
  const spot = (lat, o) => drive({ startLat: lat, startLon: 17.1, endLat: lat, endLon: 17.1, ...o });
  const often = [0, 1, 2].map(k => spot(48.1, { start: new Date(2026, 8, 14 + k, 8).getTime(), end: new Date(2026, 8, 14 + k, 9).getTime() }));
  const once = spot(48.2, { start: new Date(2026, 8, 14, 12).getTime(), end: new Date(2026, 8, 14, 13).getTime() });
  const order = list => places(list, LIMITS.placeRadiusM).map(p => p.visits);
  assert.deepEqual(order([...often, once]), [6, 2]);
  // Summaries come out of the store in whatever order it holds them: the places must not.
  assert.deepEqual(order([once, ...often].reverse()), [6, 2]);
  assert.deepEqual(places([...often, once], LIMITS.placeRadiusM), places([once, ...often].reverse(), LIMITS.placeRadiusM));
});

test("the radius and the count a place is judged by are the ones the logs asked for", () => {
  // Over the owner's logs every second visit to a spot lands within 60 m of the first and the nearest
  // distinct spot is 122 m away, so 100 m sits in the gap; once is where the car went, twice is a place.
  assert.equal(LIMITS.placeRadiusM, 100);
  assert.equal(LIMITS.placeVisits, 2);
});

test("an endpoint the log could not place is left out, not clustered at nought", () => {
  // Half a position is no position: a latitude with no longitude beside it would otherwise put the car
  // on the Greenwich meridian, which is a place in the sea and would take the whole map with it.
  const out = places([drive({ startLat: 48.1, startLon: NaN, endLat: 48.1, endLon: 17.1 })], LIMITS.placeRadiusM);
  assert.equal(out.length, 1);
  assert.equal(out[0].visits, 1);
  assert.equal(out[0].stops, 1);
  assert.equal(places([drive({ startLat: NaN, startLon: NaN })], LIMITS.placeRadiusM).length, 1);
  // A drive with no distance still happened at a place; it simply adds nothing to the kilometres from it.
  const [nowhere] = places([drive({ km: NaN, startLat: 48.1, startLon: 17.1, endLat: 48.1, endLon: 17.1 })], LIMITS.placeRadiusM);
  assert.equal(nowhere.km, 0);
});

// ---------- consumption against temperature ----------

test("a drive with no temperature or no consumption cannot be placed on the scatter", () => {
  const { points, skipped } = tempScatter([
    drive({ outsideTemp: 12, per100: 16 }),
    drive({ outsideTemp: null, per100: 16 }),
    drive({ outsideTemp: 12, per100: null }),
    drive({ outsideTemp: null, per100: null }),
  ]);
  assert.equal(points.length, 1);
  assert.equal(skipped, 3);
  // Nought degrees and nought consumption are readings, not missing ones.
  assert.equal(tempScatter([drive({ outsideTemp: 0, per100: 0 })]).points.length, 1);
  // A field a summary does not carry at all is missing too: the guard is [== null], not [=== null].
  assert.equal(tempScatter([drive({ outsideTemp: undefined })]).skipped, 1);
  assert.equal(tempScatter([drive({ per100: undefined })]).skipped, 1);
});

test("a log with no A/C column keeps its point and loses only its colour", () => {
  const { points, noAc } = tempScatter([
    drive({ outsideTemp: 20, per100: 15, acShare: null }),
    drive({ outsideTemp: 22, per100: 17, acShare: 0.8 }),
  ]);
  assert.equal(points.length, 2);
  assert.equal(noAc, 1);
  assert.equal(points[0].acShare, null);
  assert.equal(points[0].ac, null, "no colour to give it");
  assert.equal(points[1].ac, AC_BANDS.length - 1);
  // A newer log whose A/C was simply never on is the case the colours exist for: nought is a reading, and
  // it has to reach the chart as the "off" band, not fall in with the logs that carry no column at all.
  const never = tempScatter([drive({ outsideTemp: 19, per100: 14, acShare: 0 })]);
  assert.equal(never.noAc, 0);
  assert.equal(never.points[0].acShare, 0);
  assert.equal(never.points[0].ac, 0, "A/C off, not grey");
});

test("the scatter is drawn coldest first, which is what uPlot needs of its x", () => {
  const { points } = tempScatter([drive({ outsideTemp: 22 }), drive({ outsideTemp: -3 }), drive({ outsideTemp: 9 })]);
  assert.deepEqual(points.map(p => p.temp), [-3, 9, 22]);
});

test("the A/C bands are told apart at the share they are named for", () => {
  assert.deepEqual(AC_BANDS, [0, 0.25, 0.75]);
  assert.equal(acBandOf(0), 0);
  assert.equal(acBandOf(0.2499), 0);
  assert.equal(acBandOf(0.25), 1, "a quarter of the drive is already some of the time");
  assert.equal(acBandOf(0.7499), 1);
  assert.equal(acBandOf(0.75), 2, "three quarters is on");
  assert.equal(acBandOf(1), 2);
  assert.equal(acBandOf(null), null);
  // A summary from before the column was read has no field at all, which is no reading either - not "off".
  assert.equal(acBandOf(undefined), null);
});
