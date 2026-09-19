import { test } from "node:test";
import assert from "node:assert/strict";
import { weekStart, monthStart, nextStart, previousStart, inPeriod, totals, baseline } from "../stats/periods.js";

test("weeks start on Monday, months on the 1st, in local time", () => {
  const sunday = new Date(2026, 8, 20, 18, 30).getTime();
  assert.equal(weekStart(sunday), new Date(2026, 8, 14).getTime());
  assert.equal(monthStart(sunday), new Date(2026, 8, 1).getTime());
  // Summer time ends on 25 October 2026: a week is then 7 calendar days, not 7 × 24 h.
  assert.equal(nextStart("week", new Date(2026, 9, 19).getTime()), new Date(2026, 9, 26).getTime());
  assert.equal(previousStart("month", new Date(2026, 0, 1).getTime()), new Date(2025, 11, 1).getTime());
});

test("period totals take rates from the totals, skipping drives with no energy", () => {
  const t = totals([
    { start: 1, km: 10, moving: 600, energy: 2, out: 2.5, regen: 0.5 },
    { start: 2, km: 30, moving: 1800, energy: 4, out: 4.5, regen: 0.5 },
    { start: 3, km: 5, moving: 300, energy: null, out: null, regen: null },
  ]);
  assert.equal(t.drives, 3);
  assert.equal(t.km, 45);
  assert.equal(t.seconds, 2700);
  assert.equal(t.energy, 6);
  assert.equal(t.per100, 15, "6 kWh over the 40 km that have energy, not 45");
  assert.equal(t.regenShare, 1 / 7);
});

test("a week's drives, and the average of the four weeks before", () => {
  const at = (month, day, km) => ({ start: new Date(2026, month, day, 8).getTime(), km, moving: 60, energy: km / 5, out: km / 5, regen: 0 });
  const all = [at(7, 17, 10), at(7, 26, 30), at(8, 2, 20), at(8, 8, 40), at(8, 15, 50), at(8, 16, 10)];
  const week = weekStart(new Date(2026, 8, 15).getTime());
  assert.deepEqual(inPeriod(all, "week", week).map(s => s.km), [50, 10]);
  const before = baseline(all, "week", week);
  assert.equal(before.km, 25);
  assert.equal(before.drives, 1);
  assert.equal(before.per100, 20);
  assert.equal(baseline(all, "week", weekStart(new Date(2026, 7, 10).getTime())), null);
  assert.equal(baseline(all, "all", 0), null);
  assert.equal(inPeriod(all, "all", 0).length, 6);
});

test("the baseline counts only the periods since the first drive", () => {
  const at = (day, km) => ({ start: new Date(2026, 8, day, 8).getTime(), km, moving: 60, energy: km / 5, out: km / 5, regen: 0 });
  const all = [at(8, 40), at(15, 50)];
  const before = baseline(all, "week", weekStart(new Date(2026, 8, 15).getTime()));
  assert.equal(before.periods, 1);
  assert.equal(before.km, 40, "one week of history, not divided by four");
  assert.equal(baseline(all, "week", weekStart(new Date(2026, 8, 8).getTime())), null, "the first week has nothing before it");
  assert.equal(baseline(all, "month", monthStart(new Date(2026, 8, 15).getTime())), null);
});
