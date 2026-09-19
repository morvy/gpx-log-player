import { test } from "node:test";
import assert from "node:assert/strict";
import { chargingCurve } from "../stats/charges.js";
import { fmt } from "../stats/coach-view.js";
import {
  WEEKDAYS, day, dayTime, range, thisPeriod, trendVs, trendClass, statRow, panel, plainKey, valueBars, thin,
  curveGaps, gapLabel, curveCover, efficiencyEnds, busiestTime,
} from "../stats/tabs-view.js";

const text = html => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
/** A charging curve whose bands, 0-20 … 90-100, have these kW (null for no data). */
const curveOf = kws => chargingCurve([]).map((b, i) => ({ ...b, kw: kws[i] }));

// ---------- dates and words ----------

test("a day is named in English from the local clock, Monday first", () => {
  assert.equal(day(new Date(2026, 8, 14, 9, 14).getTime()), "Mon 14 Sep");
  assert.equal(dayTime(new Date(2026, 8, 16, 8, 5).getTime()), "Wed 16 Sep 08:05");
  assert.equal(dayTime(new Date(2026, 8, 20, 23, 59).getTime()), "Sun 20 Sep 23:59");
  assert.deepEqual([WEEKDAYS[0], WEEKDAYS[6]], ["Mon", "Sun"]);
});

test("a range uses a dash, or words once an end is below nought", () => {
  assert.equal(range(7.46, 30.9, 1), "7.5–30.9");
  assert.equal(range(11, 25, 0), "11–25");
  assert.equal(range(-5, 10, 0), "−5 to 10");
  assert.equal(range(-2.5, -1, 1), "−2.5 to −1.0");
});

test("titles follow the chosen period", () => {
  assert.equal(thisPeriod("week"), "this week");
  assert.equal(thisPeriod("month"), "this month");
  assert.equal(thisPeriod("all"), "all drives");
});

// ---------- trends ----------

test("a trend compares with the mean of the periods before and knows which way is better", () => {
  const up = trendVs(4, [3], "week", undefined);
  assert.equal(up.text, `▲ ${fmt(33, 0)} % vs the week before`);
  assert.equal(up.better, null, "no direction is better: grey");
  assert.equal(trendClass(up), "trend muted");

  const down = trendVs(1, [5, null, 5, 5, 5], "week", "higher");
  assert.equal(down.text, "▼ 80 % vs the 4 weeks before", "a period with nothing is left out, not counted as nought");
  assert.equal(down.better, false);
  assert.equal(trendClass(down), "trend bad");

  const better = trendVs(1, [2, 2], "month", "lower");
  assert.equal(better.text, "▼ 50 % vs the 2 months before");
  assert.equal(trendClass(better), "trend good");
});

test("no trend without a value, without history, from nought or under 3 %", () => {
  assert.equal(trendVs(null, [3], "week"), null);
  assert.equal(trendVs(3, [], "week"), null);
  assert.equal(trendVs(3, [null, null], "week"), null);
  assert.equal(trendVs(3, [0], "week"), null);
  assert.equal(trendVs(102, [100], "week", "higher"), null);
  assert.ok(trendVs(104, [100], "week", "higher"));
});

// ---------- the stat row ----------

test("a stat shows its label, its value with the unit, and its note", () => {
  const html = statRow([{ label: "Energy added", value: "21.1", unit: "kWh", note: "into the pack, not from the wall" }]);
  assert.match(html, /^<div class="stat-row"><div class="stat">/);
  assert.equal(text(html), "Energy added 21.1 kWh into the pack, not from the wall");
  assert.match(html, /<b>21\.1 <small>kWh<\/small><\/b>/);
  assert.doesNotMatch(html, /stat-dot/, "no tone, no dot");
});

test("a tone puts a dot of its colour before the label, and only good and bad do", () => {
  const html = statRow([
    { label: "A", value: "1", tone: "good" }, { label: "B", value: "2", tone: "bad" }, { label: "C", value: "3", tone: "watch" },
  ]);
  assert.equal((html.match(/stat-dot/g) ?? []).length, 2);
  assert.match(html, /<i class="stat-dot good"><\/i>A/);
  assert.match(html, /<i class="stat-dot bad"><\/i>B/);
});

test("a missing value prints a dash and the note says why; the unit goes with the value", () => {
  const html = statRow([{ label: "State of health", value: null, unit: "%", note: "not in these logs" }]);
  assert.equal(text(html), "State of health – not in these logs");
  assert.doesNotMatch(html, /<small>/);
});

test("a trend follows the note in its colour", () => {
  const html = statRow([
    { label: "Charges", value: "1", note: "0 DC · 1 AC", trend: { text: "▲ 33 % vs the 4 weeks before", better: null } },
    { label: "Energy", value: "2", trend: { text: "▼ 81 % vs the week before", better: true } },
    { label: "Worse", value: "3", trend: { text: "▲ 5 %", better: false } },
  ]);
  assert.match(html, /0 DC · 1 AC · <span class="trend muted">▲ 33 % vs the 4 weeks before<\/span>/);
  assert.match(html, /<span class="stat-note"><span class="trend good">▼ 81 % vs the week before<\/span><\/span>/);
  assert.match(html, /<span class="trend bad">▲ 5 %<\/span>/);
});

test("four stats make four boxes in one row", () => {
  const html = statRow([1, 2, 3, 4].map(n => ({ label: `L${n}`, value: String(n) })));
  assert.equal((html.match(/class="stat"/g) ?? []).length, 4);
});

// ---------- panels, keys and bars ----------

test("a panel is a titled white section", () => {
  assert.equal(panel("Where", "<p>x</p>"), `<section class="panel"><h2>Where</h2><p>x</p></section>`);
});

test("a plain key names each colour with its shape, then the trailing text", () => {
  const html = plainKey([
    { colour: "#fc4c02", label: "#6", shape: "line" },
    { colour: "#1f77b4", label: "A/C off", shape: "dot" },
    { colour: "#9a9aa2", label: "km", shape: "bar" },
    { colour: "#000", label: "odd", shape: "star" },
  ], "mV against the pack average");
  assert.match(html, /^<div class="key">/);
  assert.match(html, /<span><i class="line" style="background: #fc4c02"><\/i>#6<\/span>/);
  assert.match(html, /<i class="dot" style="background: #1f77b4"><\/i>A\/C off/);
  assert.match(html, /<i class="bar" style="background: #9a9aa2"><\/i>km/);
  assert.match(html, /<i class="line" style="background: #000"><\/i>odd/, "an unknown shape is a line");
  assert.match(html, /<span>mV against the pack average<\/span><\/div>$/);
  assert.equal(plainKey([{ colour: "#fff", label: "x" }]), `<div class="key"><span><i class="line" style="background: #fff"></i>x</span></div>`);
});

test("value bars scale to the largest value and print it with the unit", () => {
  const html = valueBars([{ label: "0–20 %", value: 18 }, { label: "20–40 %", value: 9 }], { unit: "mV", decimals: 1 });
  assert.match(html, /^<div class="bars">/);
  assert.match(html, /<span class="muted">0–20 %<\/span><span class="bar"><i style="width: 100\.0%"><\/i><\/span><span>18\.0 mV<\/span>/);
  assert.match(html, /<i style="width: 50\.0%"><\/i><\/span><span>9\.0 mV<\/span>/);
});

test("a bar with no value says so and draws nothing", () => {
  const html = valueBars([{ label: "a", value: 4 }, { label: "b", value: null }, { label: "c", value: NaN }], { unit: "mV" });
  assert.equal((html.match(/no reading/g) ?? []).length, 2);
  assert.equal((html.match(/<i /g) ?? []).length, 1);
  assert.match(html, /<span class="muted">b<\/span><span class="bar"><\/span><span class="muted">no reading<\/span>/);
});

test("bars below nought are as long as their size and keep a true minus sign", () => {
  const html = valueBars([{ label: "#6", value: -8.9 }, { label: "#53", value: -4.45 }], { unit: "mV", decimals: 1 });
  assert.match(html, /width: 100\.0%.*−8\.9 mV/);
  assert.match(html, /width: 50\.0%/);
  assert.equal(valueBars([{ label: "x", value: 0 }], { decimals: 0 }),
    `<div class="bars"><span class="muted">x</span><span class="bar"><i style="width: 0.0%"></i></span><span>0</span></div>`);
});

test("decimals default to one and the unit is optional", () => {
  assert.match(valueBars([{ label: "x", value: 2 }]), /<span>2\.0<\/span>/);
  assert.match(valueBars([{ label: "x", value: 2.346 }], { decimals: 2 }), /<span>2\.35<\/span>/);
});

test("a history is thin under three periods with a value", () => {
  assert.equal(thin([]), true);
  assert.equal(thin([null, null, null, null]), true);
  assert.equal(thin([null, 4, null, 5]), true, "two periods");
  assert.equal(thin([3, null, 4, 5]), false, "three periods");
  assert.equal(thin([3, NaN, 4, null]), true, "NaN is no value");
  assert.equal(thin([3, 4], 2), false);
});

test("every label is escaped", () => {
  const evil = `<img src=x onerror="1">`;
  for (const html of [
    statRow([{ label: evil, value: evil, unit: evil, note: evil, trend: { text: evil, better: true } }]),
    panel(evil, ""), plainKey([{ colour: evil, label: evil }], evil), valueBars([{ label: evil, value: 1 }], { unit: evil }),
  ]) {
    assert.doesNotMatch(html, /<img/);
    assert.doesNotMatch(html, /"1"/);
  }
});

// ---------- the charging curve ----------

test("gaps in the curve are merged into runs and named", () => {
  assert.deepEqual(curveGaps(curveOf([26, 26, 26, 25, null, null, null])), [{ from: 70, to: 100 }]);
  assert.equal(gapLabel({ from: 70, to: 100 }), "no data above 70 %");
  assert.equal(gapLabel({ from: 70, to: 80 }), "no data 70–80 %");
  assert.deepEqual(curveGaps(curveOf([null, 30, null, null, 20, 10, null])), [
    { from: 0, to: 20 }, { from: 40, to: 70 }, { from: 90, to: 100 }]);
  assert.deepEqual(curveGaps(curveOf([1, 1, 1, 1, 1, 1, 1])), []);
});

test("the curve covers what it knows and says what is missing", () => {
  assert.deepEqual(curveCover(curveOf([26, 26, 26, 25, null, null, null])),
    { value: "0–70 %", note: "no charge on record above 70 %" });
  assert.deepEqual(curveCover(curveOf([50, 50, 50, 50, 40, 20, 10])), { value: "0–100 %", note: null });
  assert.deepEqual(curveCover(curveOf([null, null, null, null, null, null, null])),
    { value: null, note: "no DC charge on record yet" });
  assert.deepEqual(curveCover(curveOf([30, 30, 30, null, 20, 10, 5])), { value: "0–100 %", note: "no data 60–70 %" });
  assert.deepEqual(curveCover(curveOf([null, 30, 30, 30, null, null, null])),
    { value: "20–70 %", note: "no data 0–20 % · no charge on record above 70 %" });
});

// ---------- the drives ----------

const run = (start, km, energy) => ({ start, km, energy, per100: energy == null ? null : energy / km * 100 });

test("the cheapest and dearest drive of at least 1 km with energy", () => {
  const list = [run(1, 7.5, 0.735), run(2, 1.2, 0.371), run(3, 0.4, 0.5), run(4, 20, null), run(5, 7.3, 1.02)];
  const { most, least } = efficiencyEnds(list);
  assert.equal(most.start, 1);
  assert.equal(least.start, 2, "the 0.4 km drive would be dearer, but it is too short to say");
});

test("no drives, or none with energy, give no ends; one drive is both", () => {
  assert.deepEqual(efficiencyEnds([]), { most: null, least: null });
  assert.deepEqual(efficiencyEnds([run(1, 5, null), run(2, 0.9, 0.2)]), { most: null, least: null });
  const one = efficiencyEnds([run(1, 5, 0.7)]);
  assert.equal(one.most, one.least);
  // Equal cost: the earlier drive is the most efficient, the later the least.
  const tie = efficiencyEnds([run(2, 5, 0.5), run(1, 5, 0.5)]);
  assert.deepEqual([tie.most.start, tie.least.start], [1, 2]);
});

// ---------- the patterns ----------

test("the busiest hour of the week, Monday first", () => {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  assert.equal(busiestTime(grid), null);
  grid[6][18] = 3420;
  grid[0][9] = 600;
  grid[3][7] = 3420;
  assert.deepEqual(busiestTime(grid), { d: 3, h: 7, seconds: 3420, label: "Thu 07:00" }, "the earlier of equals");
  grid[6][18] = 3421;
  assert.equal(busiestTime(grid).label, "Sun 18:00");
});
