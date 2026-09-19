import { test } from "node:test";
import assert from "node:assert/strict";
import { UP_FIELDS, DOWN_FIELDS } from "../stats/episodes.js";
import { coach, speedUps, quantile, median, phases, pullStyles, compareStyles, liftEffect, MIN_STYLE } from "../stats/coach.js";
import { versusUsual, coldCause, direction, periodHistory, kmPerDay, forecast, tipWorth } from "../stats/coach.js";
import { weekStart, nextStart } from "../stats/periods.js";

const near = (actual, expected, tolerance) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

const pack = (list, fields) => Object.fromEntries(fields.map(k => [k, list.map(e => e[k] ?? null)]));
const drive = ({ up = [], down = [], km = 100, start = 0 }) =>
  ({ km, start, episodes: { up: pack(up, UP_FIELDS), down: pack(down, DOWN_FIELDS) } });
const pull = (accel, kwh, extra = {}) =>
  ({ v0: 0, v1: 50, seconds: 13.9 / accel, kwh, peakKw: 40, accel, holdSeconds: 30, ...extra });
const stop = (brakeKwh, liftSeconds, extra = {}) => ({
  v0: 80, v1: 0, toStop: 1, seconds: 20, braked: liftSeconds == null ? 0 : 1, liftSeconds,
  regenKwh: 0.1, brakeKwh, recoveredShare: 0.5, ...extra,
});
const times = (count, make) => Array.from({ length: count }, make);
// Nine stops from 80: two without a press, two short presses after 11 s of lift-off, five long ones after 4 s.
const stops = () => [...times(2, () => stop(0, null)), ...times(2, () => stop(0.02, 11)), ...times(5, () => stop(0.1, 4))];

test("quantile interpolates and ignores missing values", () => {
  assert.equal(quantile([], 0.5), null);
  assert.equal(median([3, null, 1, 2]), 2);
  near(quantile([30, 40, 50, 60], 0.25), 37.5, 1e-9);
  near(quantile([30, 40, 50, 60], 0.75), 52.5, 1e-9);
});

test("under nine episodes a situation has no verdict", () => {
  const c = coach([drive({ up: times(8, () => pull(1, 0.1)), down: stops().slice(1) })]);
  assert.equal(c.situations.length, 0);
  assert.equal(c.score, null);
  assert.deepEqual(c.tips, []);
  // Named all the same, so the page can say how many more each one needs.
  assert.deepEqual(c.small, [
    { kind: "up", from: 0, to: 50, count: 8, enough: false },
    { kind: "down", from: 70, to: 90, toStop: true, count: 8, enough: false },
  ]);
});

test("an episode near no situation is left out", () => {
  const c = coach([drive({ up: times(10, () => pull(1, 0.1, { v1: 100 })) })]);
  assert.equal(c.situations.length, 0);
});

test("styles are the driver's own thirds, and the cheaper outer one is recommended", () => {
  const gentleWins = speedUps([...times(5, () => pull(1, 0.08)), ...times(5, () => pull(2.5, 0.12))], 100);
  assert.equal(gentleWins.length, 1);
  const s = gentleWins[0];
  assert.equal(s.from, 0);
  assert.equal(s.to, 50);
  assert.equal(s.count, 10);
  // Ten by accel: the lowest three are gentle, the highest three brisk, the four between moderate.
  assert.deepEqual(s.styles.gentle, { count: 3, kwh: 0.08, seconds: 13.9, accel: 1 });
  assert.deepEqual(s.styles.brisk, { count: 3, kwh: 0.12, seconds: 13.9 / 2.5, accel: 2.5 });
  assert.equal(s.styles.moderate.count, 4);
  near(s.styles.moderate.kwh, 0.1, 1e-9);
  near(s.styles.moderate.accel, 1.75, 1e-9);
  assert.equal(s.best, "gentle");
  assert.equal(s.target, 0.08);
  near(s.median, 0.1, 1e-9);
  // Only the brisk third counts as waste: 3 × 0.04 kWh over 100 km.
  near(s.savingPer100, 0.12, 1e-9);
  near(s.ratio, 10 * 0.08 / (10 * 0.08 + 0.12), 1e-9);

  const briskWins = speedUps([...times(5, () => pull(1, 0.12)), ...times(5, () => pull(2.5, 0.08))], 100);
  assert.equal(briskWins[0].best, "brisk");
  near(briskWins[0].savingPer100, 0.12, 1e-9);
});

test("a speed-up's cost is scaled to its situation's speed change", () => {
  // 30→70: gentle pulls go 25→75, moderate 30→70, brisk 35→65, each at the same energy per unit of v².
  const per = (v0, v1) => 0.1 * (v1 ** 2 - v0 ** 2) / (70 ** 2 - 30 ** 2);
  const c = coach([drive({ up: [
    ...times(3, () => pull(1, per(25, 75), { v0: 25, v1: 75 })),
    ...times(3, () => pull(1.5, per(30, 70), { v0: 30, v1: 70 })),
    ...times(3, () => pull(2.5, per(35, 65), { v0: 35, v1: 65 })),
  ] })]);
  assert.equal(c.situations.length, 1);
  const s = c.situations[0];
  assert.equal(s.from, 30);
  for (const name of ["gentle", "moderate", "brisk"]) near(s.styles[name].kwh, 0.1, 1e-9);
  near(s.savingPer100, 0, 1e-9);
  assert.deepEqual(c.tips, []);
  assert.equal(c.score, 100);
});

test("scatter inside a style is no tip when gentle and brisk cost the same", () => {
  const s = speedUps([
    pull(1, 0.06), pull(1, 0.1), pull(1, 0.14),
    ...times(3, () => pull(1.5, 0.1)),
    pull(2.5, 0.08), pull(2.5, 0.1), pull(2.5, 0.14),
  ], 100)[0];
  assert.equal(s.styles.gentle.kwh, s.styles.brisk.kwh);
  assert.equal(s.savingPer100, 0);
  assert.equal(s.ratio, 1);
});

test("episodes all alike score 100 and give no tip", () => {
  const c = coach([drive({ up: times(10, () => pull(1.5, 0.1)) })]);
  assert.equal(c.score, 100);
  assert.deepEqual(c.tips, []);
  assert.equal(c.hardShare, 0);
});

test("slow-downs are compared with their best quarter", () => {
  const c = coach([drive({ down: stops() })], { regenEfficiency: 0.85 });
  assert.equal(c.situations.length, 1);
  const s = c.situations[0];
  assert.equal(s.kind, "down");
  assert.equal(s.from, 70);
  assert.equal(s.to, 90);
  assert.equal(s.toStop, true);
  assert.equal(s.count, 9);
  // The best quarter is the three with the least brake loss: both without a press and the first short press.
  assert.deepEqual(s.best, { brakedShare: 1 / 3, liftSeconds: 11, brakeKwh: 0, regenKwh: 0.1 });
  assert.deepEqual(s.you, { brakedShare: 7 / 9, liftSeconds: 4, brakeKwh: 0.1, regenKwh: 0.1 });
  const wasted = (2 * 0.02 + 5 * 0.1) * 0.85;
  near(s.savingPer100, wasted, 1e-9);
  near(s.ratio, 1 - wasted / (9 * 0.1 + wasted), 1e-9);
  near(c.liftSeconds, 4, 1e-9);
});

test("the best quarter is ranked by brake loss per unit of speed shed", () => {
  // 0.03 kWh from 89 km/h is less loss per v² than 0.02 kWh from 70.
  const c = coach([drive({ down: [
    ...times(5, () => stop(0.1, 4, { v0: 70 })),
    ...times(2, () => stop(0.02, 6, { v0: 70 })),
    ...times(2, () => stop(0.03, 9, { v0: 89 })),
  ] })]);
  const s = c.situations[0];
  assert.equal(s.best.brakeKwh, 0.03);
  assert.equal(s.best.liftSeconds, 9);
  assert.equal(s.best.brakedShare, 1);
});

test("tips are the biggest savings first, and small ones are left out", () => {
  const c = coach([drive({
    up: [...times(5, () => pull(1, 0.08)), ...times(5, () => pull(2.5, 0.3))],   // 3 × 0.22 → 0.66 per 100 km
    down: stops(),                                                               // 0.54 × 0.85 → 0.459
  })], { regenEfficiency: 0.85 });
  assert.deepEqual(c.tips.map(t => t.kind), ["up", "down"]);
  const tiny = coach([drive({ km: 1000, up: [...times(5, () => pull(1, 0.08)), ...times(5, () => pull(2.5, 0.09))] })]);
  assert.deepEqual(tiny.tips, []);   // 3 × 0.01 per 1000 km → 0.003 per 100 km
});

test("a slow-down without pedal figures is not compared", () => {
  const c = coach([drive({ down: times(10, () => stop(null, null, { braked: null })) })]);
  assert.equal(c.situations.length, 0);
});

test("only drives with episodes count towards the distance", () => {
  const c = coach([drive({ up: times(10, () => pull(1.5, 0.1)) }), { km: 500, start: 0, episodes: null }]);
  assert.equal(c.km, 100);
  assert.equal(c.drives, 1);
});

test("a few wasteful pulls still make a tip", () => {
  // Nine by accel: the brisk third is one gentle-paced pull and the two hard ones.
  const c = coach([drive({ up: [...times(7, () => pull(1, 0.08)), ...times(2, () => pull(2.5, 0.2))] })]);
  assert.equal(c.situations.length, 1);
  const s = c.situations[0];
  assert.equal(s.best, "gentle");
  assert.equal(s.styles.brisk.kwh, 0.2);
  near(s.savingPer100, 2 * 0.12, 1e-9);
  near(s.ratio, 9 * 0.08 / (9 * 0.08 + 0.24), 1e-9);
  assert.equal(c.tips.length, 1);
});

test("against the usual: inside half the spread is the same", () => {
  const usual = [10, 11, 9, 10, 10.5, 9.5];   // median 10, quartiles 9.625 and 10.375
  assert.deepEqual(versusUsual(10.2, usual, "lower"), { usual: 10, verdict: "same" });
  assert.equal(versusUsual(12, usual, "lower").verdict, "worse");
  assert.equal(versusUsual(8, usual, "lower").verdict, "better");
  assert.equal(versusUsual(12, usual, "higher").verdict, "better");
  assert.equal(versusUsual(12, [], "lower"), null);
  assert.equal(versusUsual(null, usual, "lower"), null);
});

test("against the usual needs three usual periods", () => {
  assert.equal(versusUsual(12, [10, 10], "lower"), null);
  assert.equal(versusUsual(12, [10, null, 10], "lower"), null);
  assert.deepEqual(versusUsual(12, [10, 10, 10], "lower"), { usual: 10, verdict: "worse" });
  assert.equal(versusUsual(8, [10, 10, 10], "lower").verdict, "better");
  assert.equal(versusUsual(10, [10, 10, 10], "lower").verdict, "same");
});

test("a worse period that was much colder is put down to the cold", () => {
  const worse = { usual: 15, verdict: "worse" };
  assert.equal(coldCause(worse, 2, [10, 12, 9]), "cold");
  assert.equal(coldCause(worse, 8, [10, 12, 9]), null);
  assert.equal(coldCause({ usual: 15, verdict: "better" }, 2, [10, 12, 9]), null);
  assert.equal(coldCause(worse, null, [10, 12, 9]), null);
  assert.equal(coldCause(worse, 2, []), null);
});

test("a direction needs four periods with data", () => {
  assert.equal(direction([10, 11, 12], "lower"), null);
  assert.equal(direction([10, 11, 12, 13], "lower"), "slipping");
  assert.equal(direction([10, 11, 12, 13], "higher"), "improving");
  assert.equal(direction([5, 6, 6, 5], "lower"), "steady");
  assert.equal(direction([13, null, 12, null, 11, 10], "lower"), "improving");
});

test("history is oldest first, empty periods null, nothing before the first drive", () => {
  const w0 = weekStart(new Date(2026, 7, 3).getTime());
  const w2 = nextStart("week", nextStart("week", w0)), w3 = nextStart("week", w2);
  const all = [{ start: w0 + 3600e3, km: 10 }, { start: w2 + 3600e3, km: 30 }];
  const sum = list => list.reduce((n, s) => n + s.km, 0);
  assert.deepEqual(periodHistory(all, "week", w3, sum), [10, null, 30]);
  assert.deepEqual(periodHistory(all, "week", w3, sum, 2), [null, 30]);
  assert.deepEqual(periodHistory(all, "all", w3, sum), []);
});

test("km a day is over the whole period", () => {
  const w = weekStart(new Date(2026, 8, 14).getTime());
  near(kmPerDay([{ km: 50 }, { km: 20 }], "week", w), 10, 1e-9);
});

test("a forecast for the week under way, with its range", () => {
  const start = weekStart(new Date(2026, 8, 14).getTime());
  const f = forecast({ kind: "week", start, now: start + 2 * 86400e3, km: 100, per100: 15, usualKmPerDay: [30, 40, 50, 60] });
  near(f.km, 350, 1e-9);
  near(f.low, 100 + 37.5 * 5, 1e-9);
  near(f.high, 100 + 52.5 * 5, 1e-9);
  near(f.kwh, 52.5, 1e-9);
  const noHistory = forecast({ kind: "week", start, now: start + 2 * 86400e3, km: 100, per100: null, usualKmPerDay: [] });
  assert.equal(noHistory.low, null);
  assert.equal(noHistory.kwh, null);
});

test("no forecast for a finished period, its first day, or all time", () => {
  const start = weekStart(new Date(2026, 8, 14).getTime());
  assert.equal(forecast({ kind: "week", start, now: nextStart("week", start), km: 100, per100: 15 }), null);
  assert.equal(forecast({ kind: "week", start, now: start + 3600e3, km: 10, per100: 15 }), null);
  assert.equal(forecast({ kind: "all", start: 0, now: 1e12, km: 100, per100: 15 }), null);
});

test("what a tip is worth over the projected distance and per charge", () => {
  const w = tipWorth({ savingPer100: 1 }, 1000, 15);
  near(w.kwh, 10, 1e-9);
  near(w.kmPerCharge, 28.5 / 14 * 100 - 28.5 / 15 * 100, 1e-9);
  assert.equal(tipWorth({ savingPer100: 1 }, 1000, 1), null);
  assert.equal(tipWorth({ savingPer100: 1 }, null, 15), null);
});

test("a week that changes the clocks is still seven days", () => {
  const start = weekStart(new Date(2026, 9, 19).getTime());
  near(kmPerDay([{ km: 70 }], "week", start), 10, 1e-9);
  const end = nextStart("week", start), now = start + 2 * 86400e3, share = (now - start) / (end - start);
  const f = forecast({ kind: "week", start, now, km: 100, per100: 15, usualKmPerDay: [30, 40, 50, 60] });
  near(f.km, 100 / share, 1e-9);
  near(f.low, 100 + 37.5 * (1 - share) * 7, 1e-9);
  near(f.high, 100 + 52.5 * (1 - share) * 7, 1e-9);
});

// ---------- what the coach page reads ----------

test("a small group is judged nowhere, beside a group that is", () => {
  const c = coach([drive({
    up: [...times(5, () => pull(1, 0.08)), ...times(5, () => pull(2.5, 0.3))],
    down: stops().slice(0, 4),
  })], { regenEfficiency: 0.85 });
  assert.deepEqual(c.situations.map(s => [s.kind, s.enough]), [["up", true]]);
  assert.deepEqual(c.small, [{ kind: "down", from: 70, to: 90, toStop: true, count: 4, enough: false }]);
  assert.deepEqual(c.tips.map(t => t.kind), ["up"]);
  assert.equal(c.score, Math.round(100 * c.situations[0].ratio));
  const p = phases(c);
  assert.equal(p.slowingDown.value, null);
  assert.equal(p.slowingDown.count, 0);
  assert.equal(p.pullingAway.count, 10);
});

test("every pull of a situation is a point, in its third, at its scaled cost", () => {
  const s = speedUps([...times(5, () => pull(1, 0.08)), ...times(5, () => pull(2.5, 0.12))], 100)[0];
  assert.equal(s.points.length, 10);
  assert.deepEqual(s.points.map(p => p.style), [
    "gentle", "gentle", "gentle", "moderate", "moderate", "moderate", "moderate", "brisk", "brisk", "brisk"]);
  assert.deepEqual(s.points[0], { accel: 1, cost: 0.08, style: "gentle" });
  assert.deepEqual(s.points[9], { accel: 2.5, cost: 0.12, style: "brisk" });

  // 30→70 pulls that went 25→75: their cost is scaled to the situation's own speed change.
  const per = (v0, v1) => 0.1 * (v1 ** 2 - v0 ** 2) / (70 ** 2 - 30 ** 2);
  const scaled = speedUps(times(9, () => pull(1, per(25, 75), { v0: 25, v1: 75 })), 100)[0];
  for (const p of scaled.points) near(p.cost, 0.1, 1e-9);
});

test("phase bars are count-weighted over the situations", () => {
  const c = { situations: [
    { kind: "up", count: 10, ratio: 0.9 },
    { kind: "up", count: 30, ratio: 0.5 },
    { kind: "down", count: 9, ratio: 0.8, you: { liftSeconds: 3 }, best: { liftSeconds: 12 } },
    { kind: "down", count: 27, ratio: 1, you: { liftSeconds: 8 }, best: { liftSeconds: 6 } },
    // Neither of these has a lift-off to compare: the driver never braked, or the best quarter lifted off at 0 s.
    { kind: "down", count: 5, ratio: 0.2, you: { liftSeconds: null }, best: { liftSeconds: 10 } },
    { kind: "down", count: 4, ratio: 1, you: { liftSeconds: 2 }, best: { liftSeconds: 0 } },
  ] };
  const p = phases(c);
  assert.deepEqual(p.pullingAway, { value: 60, count: 40 });                                  // (9 + 15) / 40
  assert.deepEqual(p.slowingDown, { value: Math.round(100 * 39.2 / 45), count: 45 });        // 7.2 + 27 + 1 + 4
  // 9 × 3/12 and 27 × 1 (lifting off longer than the best is no better than matching it), over 36.
  assert.equal(p.anticipation.value, Math.round(100 * (9 * 0.25 + 27) / 36));
  assert.equal(p.anticipation.count, 36);
  near(p.anticipation.youSeconds, (9 * 3 + 27 * 8) / 36, 1e-9);
  near(p.anticipation.bestSeconds, (9 * 12 + 27 * 6) / 36, 1e-9);
});

test("a phase with nothing to go on has no value", () => {
  const p = phases({ situations: [] });
  assert.deepEqual(p.pullingAway, { value: null, count: 0 });
  assert.deepEqual(p.slowingDown, { value: null, count: 0 });
  assert.deepEqual(p.anticipation, { value: null, count: 0, youSeconds: null, bestSeconds: null });
  assert.deepEqual(p.consumption, { value: null, count: 0, per100: null, verdict: null, cause: null });
  // A best quarter that never braked has no lift-off time to match.
  const never = phases({ situations: [{ kind: "down", count: 9, ratio: 1, you: { liftSeconds: 3 }, best: { liftSeconds: null } }] });
  assert.equal(never.anticipation.value, null);
  assert.equal(never.slowingDown.value, 100);
});

test("consumption is set against the usual periods, and the cold takes the blame", () => {
  const worse = phases({ situations: [] }, { per100: 20, usualPer100: [15, 15, null, 15] });
  assert.deepEqual(worse.consumption, { value: 75, count: 3, per100: 20, verdict: "worse", cause: null });
  const cold = phases({ situations: [] }, { per100: 20, usualPer100: [15, 15, 15], temp: 2, usualTemps: [10, 12, 9] });
  assert.equal(cold.consumption.cause, "cold");
  const better = phases({ situations: [] }, { per100: 12, usualPer100: [15, 15, 15] });
  assert.equal(better.consumption.value, 100);
  assert.equal(better.consumption.verdict, "better");
  assert.equal(phases({ situations: [] }, { per100: -2, usualPer100: [15, 15, 15] }).consumption.value, 100);
  // Under three usual periods there is nothing to set it against.
  const early = phases({ situations: [] }, { per100: 20, usualPer100: [15, 15] });
  assert.equal(early.consumption.value, null);
  assert.equal(early.consumption.verdict, null);
  assert.equal(early.consumption.count, 2);
});

// ---------- pull-away styles ----------

// 0 → 72 km/h is 0 → 20 m/s: 0.5 · 1600 · 20² = 320 kJ, which is 320000 / 3.6e6 = 0.0889 kWh.
const up72 = (accel, kwh) => ({ v0: 0, v1: 72, seconds: 20 / accel, kwh, peakKw: 40, accel, holdSeconds: 10 });

test("a pull-away's cost is its energy over the kinetic energy it gained", () => {
  const { points, count, styles } = pullStyles([up72(1, 0.2)], { massKg: 1600 });
  assert.equal(count, 1);
  near(points[0].eta, 2.25, 1e-9);   // 0.2 / 0.0888…
  assert.deepEqual([points[0].accel, points[0].v0, points[0].v1, points[0].style], [1, 0, 72, "moderate"]);
  // One pull is not a style.
  assert.deepEqual(styles, { gentle: null, moderate: null, brisk: null });
});

test("the styles are the driver's own thirds, and a third under three is no style", () => {
  const nine = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].map(a => up72(a, 0.2));
  const { styles, points } = pullStyles(nine, { massKg: 1600 });
  assert.deepEqual([styles.gentle.count, styles.moderate.count, styles.brisk.count], [3, 3, 3]);
  near(styles.gentle.accel, 0.3, 1e-9);
  near(styles.brisk.accel, 0.9, 1e-9);
  near(styles.gentle.eta, 2.25, 1e-9);
  // Every pull carries the third it fell in, for the page's dots.
  assert.deepEqual(points.map(p => p.style), ["gentle", "gentle", "gentle", "moderate", "moderate", "moderate", "brisk", "brisk", "brisk"]);
  // Eight leave two in each outer third, which is under MIN_STYLE.
  const eight = pullStyles(nine.slice(1), { massKg: 1600 }).styles;
  assert.equal(MIN_STYLE, 3);
  assert.equal(eight.gentle, null);
  assert.equal(eight.brisk, null);
  assert.equal(eight.moderate.count, 4);
});

test("a pull-away with no energy, no time or a nonsense cost is not used", () => {
  const odd = [
    up72(1, null),                        // a log without power
    { ...up72(1, 0.2), seconds: 0 },      // no time to measure a rate over
    { ...up72(1, 0.2), v1: 0 },           // no speed gained
    up72(1, 3),                           // eta 33.75: over the ceiling
  ];
  assert.equal(pullStyles(odd, { massKg: 1600 }).count, 0);
});

// ---------- brisk against gentle ----------

const styleSet = (gentleEta, briskEta) => ({
  gentle: { count: 8, accel: 0.3, eta: gentleEta, seconds: 60 },
  moderate: { count: 5, accel: 0.6, eta: (gentleEta + briskEta) / 2, seconds: 30 },
  brisk: { count: 8, accel: 0.9, eta: briskEta, seconds: 20 },
});

test("over the same stretch of road, brisk can be the cheaper style", () => {
  // 0 → 72 km/h: gentle takes 20 / 0.3 = 66.7 s over 666.7 m, brisk 22.2 s over 222.2 m, then cruises 444.4 m.
  const c = compareStyles({ styles: styleSet(2.5, 1.2), from: 0, to: 72, per100: 8, massKg: 1600 });
  near(c.distanceM, 666.667, 0.01);
  const [gentle, brisk] = c.rows;
  assert.deepEqual([gentle.style, brisk.style], ["gentle", "brisk"]);
  near(gentle.kwh, 0.222222, 1e-5);     // 2.5 · 0.0889, no cruising to do
  near(brisk.kwh, 0.142222, 1e-5);      // 1.2 · 0.0889 + 8 / 100 · 0.4444
  near(c.saving, 0.08, 1e-5);           // positive: brisk uses less
  near(c.quicker, 22.222, 0.01);        // positive: brisk is there sooner
  near(brisk.totalSeconds, 44.444, 0.01);
  near(gentle.cruiseSeconds, 0, 1e-9);
});

test("a thirsty pull and a cheap cruise make gentle the cheaper style", () => {
  const c = compareStyles({ styles: styleSet(2.2, 1.5), from: 0, to: 72, per100: 18, massKg: 1600 });
  near(c.rows[0].kwh, 0.195556, 1e-5);
  near(c.rows[1].kwh, 0.213333, 1e-5);
  near(c.saving, -0.017778, 1e-5);      // negative: gentle uses less
  near(c.quicker, 22.222, 0.01);        // brisk is still there sooner
});

test("without both styles, without a rise in speed or without a cruise figure there is no answer", () => {
  const styles = styleSet(2.5, 1.2);
  assert.equal(compareStyles({ styles: { ...styles, brisk: null }, from: 0, to: 72, per100: 8, massKg: 1600 }), null);
  assert.equal(compareStyles({ styles: { ...styles, gentle: null }, from: 0, to: 72, per100: 8, massKg: 1600 }), null);
  assert.equal(compareStyles({ styles, from: 80, to: 80, per100: 8, massKg: 1600 }), null);
  assert.equal(compareStyles({ styles, from: 80, to: 50, per100: 8, massKg: 1600 }), null);
  assert.equal(compareStyles({ styles, from: -10, to: 50, per100: 8, massKg: 1600 }), null);
  assert.equal(compareStyles({ styles, from: 0, to: 200, per100: 8, massKg: 1600 }), null);
  assert.equal(compareStyles({ styles, from: 0, to: 72, per100: null, massKg: 1600 }), null);
});

// ---------- what lifting off earlier was worth ----------

test("a slow-down group is split at its own median lift-off, and the halves compared", () => {
  const down = [
    ...times(3, () => stop(0.02, 10)), ...times(3, () => stop(0.1, 2)), ...times(2, () => stop(0, null)),
    ...times(4, () => stop(0.05, 5, { v0: 40, toStop: 0, v1: 20 })),
  ];
  const [band40, band80] = liftEffect(down);
  assert.deepEqual([band80.from, band80.to, band80.toStop, band80.count], [70, 90, true, 8]);
  assert.equal(band80.points.length, 6);           // the two that never braked are not points
  assert.equal(band80.split, 6);                   // the median of 2, 2, 2, 10, 10, 10
  near(band80.early, 0.02, 1e-9);                  // at or above the split
  near(band80.late, 0.1, 1e-9);
  near(band80.saved, 0.08, 1e-9);                  // lifting off earlier cost 80 Wh less
  // Four slow-downs that all lifted off at the same moment leave nothing below the split: no saving to name.
  assert.deepEqual([band40.from, band40.toStop, band40.count, band40.points.length], [30, false, 4, 4]);
  near(band40.early, 0.05, 1e-9);
  assert.equal(band40.late, null);
  assert.equal(band40.saved, null);
});

test("a group where the driver never braked has no points and no verdict", () => {
  const [group] = liftEffect(times(5, () => stop(0, null)));
  assert.deepEqual(group.points, []);
  assert.deepEqual([group.split, group.early, group.late, group.saved], [null, null, null, null]);
  assert.equal(group.count, 5);
});

// ---------- fix round 1 ----------

test("an eta-0.05 episode is kept despite being below ETA_MIN", () => {
  const { used, dropped, points } = pullStyles([up72(1, 0.00445)], { massKg: 1600 });  // eta ≈ 0.05
  assert.equal(used, 1);
  assert.equal(dropped, 0);
  assert.equal(points.length, 1);
  near(points[0].eta, 0.05, 1e-2);
});

test("an eta-25 episode is dropped as it exceeds ETA_MAX", () => {
  const { used, dropped } = pullStyles([up72(1, 2.22)], { massKg: 1600 });  // eta ≈ 25
  assert.equal(used, 0);
  assert.equal(dropped, 1);
});

test("a non-finite accel is dropped", () => {
  const { used, dropped } = pullStyles([{ ...up72(1, 0.2), accel: NaN }], { massKg: 1600 });
  assert.equal(used, 0);
  assert.equal(dropped, 1);
});

test("dropped counts episodes that failed any filter", () => {
  const nine = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].map(a => up72(a, 0.2));
  const withBad = [
    ...nine,
    { ...up72(1, 2.22), accel: NaN },  // dropped
    up72(1, 3),                         // dropped (eta > ETA_MAX)
  ];
  const { used, dropped } = pullStyles(withBad, { massKg: 1600 });
  assert.equal(used, 9);
  assert.equal(dropped, 2);
});

test("two episodes with same brake loss but different speed shed no longer show as saving", () => {
  // Both have 0.1 kWh brake loss, but different speed sheds
  const down = [
    stop(0.1, 5, { v0: 70, v1: 0, toStop: 1 }),   // 70² = 4900
    stop(0.1, 5, { v0: 40, v1: 0, toStop: 1 }),   // 40² = 1600
  ];
  const result = liftEffect(down);
  // These should be in different bands
  assert.equal(result.length, 2);
});

test("compareStyles requires both outer thirds to have at least MIN_ANSWER episodes", () => {
  const styleSetSmall = (gentleEta, briskEta) => ({
    gentle: { count: 5, accel: 0.3, eta: gentleEta, seconds: 60 },
    moderate: { count: 5, accel: 0.6, eta: (gentleEta + briskEta) / 2, seconds: 30 },
    brisk: { count: 5, accel: 0.9, eta: briskEta, seconds: 20 },
  });
  const c = compareStyles({ styles: styleSetSmall(2.5, 1.2), from: 0, to: 72, per100: 8, massKg: 1600 });
  // Both gentle and brisk have count 5, which is less than MIN_ANSWER (8), so should return null
  assert.equal(c, null);
});

test("compareStyles returns answer when both outer thirds have at least MIN_ANSWER episodes", () => {
  const styleSetBig = (gentleEta, briskEta) => ({
    gentle: { count: 8, accel: 0.3, eta: gentleEta, seconds: 60 },
    moderate: { count: 4, accel: 0.6, eta: (gentleEta + briskEta) / 2, seconds: 30 },
    brisk: { count: 8, accel: 0.9, eta: briskEta, seconds: 20 },
  });
  const c = compareStyles({ styles: styleSetBig(2.5, 1.2), from: 0, to: 72, per100: 8, massKg: 1600 });
  assert.ok(c != null);
  assert.equal(c.from, 0);
  assert.equal(c.to, 72);
});

// ---------- fix round 2 ----------

test("anti-correlated data: earliest lift-offs cost the most, saved is negative", () => {
  // Early lift-offs (high liftSeconds) have high brake loss, late lift-offs (low liftSeconds) have low brake loss
  // This is anti-correlated: the pattern says lifting off earlier makes things worse
  const down = [
    ...times(3, () => stop(0.1, 10)),              // early lift-off, high loss
    ...times(3, () => stop(0.02, 2)),              // late lift-off, low loss
    ...times(3, () => stop(0.1, 10)),              // repeat early
    ...times(3, () => stop(0.02, 2)),              // repeat late
  ];
  const [group] = liftEffect(down);
  // split = median of 10, 10, 10, 2, 2, 2, 10, 10, 10, 2, 2, 2 = 6
  assert.equal(group.split, 6);
  // early (liftSeconds >= 6) = the 10s with brake loss 0.1
  near(group.early, 0.1, 1e-9);
  // late (liftSeconds < 6) = the 2s with brake loss 0.02
  near(group.late, 0.02, 1e-9);
  // saved = late - early = 0.02 - 0.1 = -0.08 (negative! early was worse)
  near(group.saved, -0.08, 1e-9);
});

test("correlated data: earliest lift-offs cost the least, saved is positive", () => {
  // Early lift-offs (high liftSeconds) have low brake loss, late lift-offs (low liftSeconds) have high brake loss
  // This matches the original test: lifting off earlier saves energy
  const down = [
    ...times(3, () => stop(0.02, 10)),              // early lift-off, low loss
    ...times(3, () => stop(0.1, 2)),                // late lift-off, high loss
    ...times(3, () => stop(0.02, 10)),              // repeat early
    ...times(3, () => stop(0.1, 2)),                // repeat late
  ];
  const [group] = liftEffect(down);
  assert.equal(group.split, 6);
  // early (liftSeconds >= 6) = the 10s with brake loss 0.02
  near(group.early, 0.02, 1e-9);
  // late (liftSeconds < 6) = the 2s with brake loss 0.1
  near(group.late, 0.1, 1e-9);
  // saved = late - early = 0.1 - 0.02 = 0.08 (positive! early was better)
  near(group.saved, 0.08, 1e-9);
});

test("same brake loss with very different speed shed still reads as no saving", () => {
  const down = [
    stop(0.1, 5, { v0: 70, v1: 0, toStop: 1 }),   // 70² = 4900
    stop(0.1, 5, { v0: 40, v1: 0, toStop: 1 }),   // 40² = 1600
  ];
  const result = liftEffect(down);
  // These should be in different bands
  assert.equal(result.length, 2);
});

test("a half with fewer than 3 episodes nulls that half", () => {
  // Create a group where one half ends up with fewer than MIN_STYLE (3) episodes
  const down = [
    stop(0.02, 10),
    stop(0.02, 10),
    stop(0.1, 2),
    stop(0.1, 2),
  ];
  const [group] = liftEffect(down);
  // split = median of 10, 10, 2, 2 = 6
  assert.equal(group.split, 6);
  // early (liftSeconds >= 6) = the 10s with 2 episodes (under MIN_STYLE) -> null
  assert.equal(group.early, null);
  // late (liftSeconds < 6) = the 2s with 2 episodes (under MIN_STYLE) -> null
  assert.equal(group.late, null);
  assert.equal(group.saved, null);
});

// ---------- fix round 3 ----------

test("lossAtRef values match hand-computed medians: braked episodes with different sheds", () => {
  // Create stops with clearly different sheds; all at v0=80 (band 70-90), toStop=1
  // shed values: 80² = 6400
  // But vary lift-off timing and brake loss. Need 3+ in each half for MIN_STYLE.
  const down = [
    stop(0.06, 10),  // brakeKwh=0.06, liftSeconds=10
    stop(0.09, 10),  // brakeKwh=0.09, liftSeconds=10
    stop(0.12, 10),  // brakeKwh=0.12, liftSeconds=10
    stop(0.03, 2),   // brakeKwh=0.03, liftSeconds=2
    stop(0.06, 2),   // brakeKwh=0.06, liftSeconds=2
    stop(0.09, 2),   // brakeKwh=0.09, liftSeconds=2
  ];
  // refShed = median of [6400, 6400, 6400, 6400, 6400, 6400] = 6400
  // lossAtRef for each: brakeKwh × 6400 / 6400 = brakeKwh
  // split = median of [10, 10, 10, 2, 2, 2] = 6
  // early (liftSeconds >= 6) = [0.06, 0.09, 0.12] with median 0.09
  // late (liftSeconds < 6) = [0.03, 0.06, 0.09] with median 0.06
  // saved = 0.06 - 0.09 = -0.03
  const [group] = liftEffect(down);
  assert.equal(group.split, 6);
  near(group.early, 0.09, 1e-9);
  near(group.late, 0.06, 1e-9);
  near(group.saved, -0.03, 1e-9);
});

test("un-braked episodes do not move refShed", () => {
  // Create a mix of braked and un-braked stops. Need 3+ in each half for MIN_STYLE.
  const down = [
    stop(0.02, 10),                                  // braked, liftSeconds=10
    stop(0.02, 10),                                  // braked, liftSeconds=10
    stop(0.02, 10),                                  // braked, liftSeconds=10
    stop(0.1, 2),                                    // braked, liftSeconds=2
    stop(0.1, 2),                                    // braked, liftSeconds=2
    stop(0.1, 2),                                    // braked, liftSeconds=2
    stop(null, null, { v0: 80, v1: 0, toStop: 1, braked: 0 }),  // un-braked, no lift-off
    // Add an un-braked with a huge shed (if it counted, it would move refShed)
    stop(null, null, { v0: 160, v1: 0, toStop: 1, braked: 0 }),  // v0² - v1² = 25600, but un-braked so ignored
  ];

  const [group] = liftEffect(down);

  // refShed should be median of the 6 braked episodes' sheds: [6400, 6400, 6400, 6400, 6400, 6400] = 6400
  // (the huge 25600 from the un-braked should not be included)
  // lossAtRef = brakeKwh × 6400 / 6400 = brakeKwh
  // split = median of [10, 10, 10, 2, 2, 2] = 6
  // early (>= 6) = [0.02, 0.02, 0.02] = 0.02
  // late (< 6) = [0.1, 0.1, 0.1] = 0.1
  // saved = 0.1 - 0.02 = 0.08
  assert.equal(group.split, 6);
  near(group.early, 0.02, 1e-9);
  near(group.late, 0.1, 1e-9);
  near(group.saved, 0.08, 1e-9);
});

// ---------- final fix wave ----------

test("lossAtRef divides out a real difference in speed shed: same loss-per-shed, different sheds, no saving", () => {
  // Six braked stops in the 70-90 band, but this time v0 itself varies a lot (so shed = v0² - v1² does
  // too), and brakeKwh is built as a fixed rate k per unit of shed - the true per-shed loss never
  // changes. lossAtRef should come out the same for every point regardless of its own shed, so early
  // and late medians should match and saved should be 0, even though the late half's raw brakeKwh is
  // bigger (its sheds are bigger) and the early half's is smaller.
  const k = 0.1 / 6400;   // kWh lost per unit of shed
  const pts = [
    { v0: 89, liftSeconds: 2 }, { v0: 85, liftSeconds: 2 }, { v0: 80, liftSeconds: 2 },     // late half
    { v0: 75, liftSeconds: 10 }, { v0: 72, liftSeconds: 10 }, { v0: 70, liftSeconds: 10 },  // early half
  ];
  const down = pts.map(p => stop(k * p.v0 ** 2, p.liftSeconds, { v0: p.v0, v1: 0 }));
  const refShed = median(pts.map(p => p.v0 ** 2));
  const [group] = liftEffect(down);
  assert.equal(group.split, 6);
  near(group.early, k * refShed, 1e-9);
  near(group.late, k * refShed, 1e-9);
  near(group.saved, 0, 1e-9);
  // Sanity: the raw brakeKwh actually does differ late vs early (proves this is real coverage, not a
  // no-op fixture) - late's raw loss is bigger only because its sheds are bigger, not because lifting
  // off later really cost more. Dropping the `* refShed / shed` scaling (using brakeKwh directly)
  // would show that raw difference as a fake ~32 Wh "saving" instead of the true 0.
  const rawLate = median(pts.slice(0, 3).map(p => k * p.v0 ** 2));
  const rawEarly = median(pts.slice(3).map(p => k * p.v0 ** 2));
  assert.ok(Math.abs(rawLate - rawEarly) > 0.03, "the raw brakeKwh medians must genuinely differ for this to be a real test");
});
