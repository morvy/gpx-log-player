import { test } from "node:test";
import assert from "node:assert/strict";
import { UP_FIELDS, DOWN_FIELDS } from "../stats/episodes.js";
import { coach } from "../stats/coach.js";
import { weekStart, previousStart } from "../stats/periods.js";
import {
  esc, fmt, share, energyWh, tipSentence, worthLine, tipsHtml, dialHtml, phasesHtml, situationsHtml, forecastLine, coachHtml,
  pullAnswerHtml, pullHtml, anticipationHtml, liftChart, PULL_RANGE,
} from "../stats/coach-view.js";

// The same synthetic drives as tests/coach.test.mjs: episodes packed into columns as a summary stores them.
const pack = (list, fields) => Object.fromEntries(fields.map(k => [k, list.map(e => e[k] ?? null)]));
const drive = ({ up = [], down = [], km = 100, start = 0, ...rest }) =>
  ({ km, start, ...rest, episodes: { up: pack(up, UP_FIELDS), down: pack(down, DOWN_FIELDS) } });
const pull = (accel, kwh, extra = {}) =>
  ({ v0: 0, v1: 50, seconds: 13.9 / accel, kwh, peakKw: 40, accel, holdSeconds: 30, ...extra });
const stop = (brakeKwh, liftSeconds, extra = {}) => ({
  v0: 80, v1: 0, toStop: 1, seconds: 20, braked: liftSeconds == null ? 0 : 1, liftSeconds,
  regenKwh: 0.1, brakeKwh, recoveredShare: 0.5, ...extra,
});
const times = (count, make) => Array.from({ length: count }, make);
const stops = () => [...times(2, () => stop(0, null)), ...times(2, () => stop(0.02, 11)), ...times(5, () => stop(0.1, 4))];
// Decimals follow the browser's locale on the page, so the expected text is built with the same formatter.
const kwh = (v, dec = 1) => `${fmt(v, dec)} kWh`;

const upTip = (best, from, to, extra = {}) => ({
  kind: "up", from, to, count: 10, enough: true, best, target: best === "brisk" ? 0.18 : 0.08,
  styles: best === "brisk"
    ? { gentle: { count: 3, kwh: 0.25 }, moderate: { count: 4, kwh: 0.2 }, brisk: { count: 3, kwh: 0.18 } }
    : { gentle: { count: 3, kwh: 0.08 }, moderate: { count: 3, kwh: 0.1 }, brisk: { count: 4, kwh: 0.12 } },
  savingPer100: 1, ...extra,
});
const downTip = (from, to, toStop, bestShare, extra = {}) => ({
  kind: "down", from, to, toStop, count: 9, enough: true,
  you: { brakedShare: 7 / 9, liftSeconds: 4, brakeKwh: 0.1, regenKwh: 0.1 },
  best: { brakedShare: bestShare, liftSeconds: bestShare ? 11 : null, brakeKwh: 0.02, regenKwh: 0.1 },
  savingPer100: 1, ...extra,
});

// ---------- tip sentences ----------

test("a speed-up tip names the style, the speeds and what the style saved", () => {
  assert.deepEqual(tipSentence(upTip("brisk", 70, 110)), {
    title: "Pull away briskly from 70 to 110 km/h.",
    evidence: "Brisk pulls used 28 % less · 3 brisk vs 3 gentle pulls",   // 1 − 0.18 / 0.25
  });
  assert.deepEqual(tipSentence(upTip("gentle", 30, 70)), {
    title: "Pull away gently from 30 to 70 km/h.",
    evidence: "Gentle pulls used 33 % less · 3 gentle vs 4 brisk pulls",   // 1 − 0.08 / 0.12; the cheaper style first
  });
});

test("percentages that round to 0 or 100 read 'under 1 %' or 'over 99 %'", () => {
  assert.equal(share(0), "0 %");
  assert.equal(share(0.004), "under 1 %");  // 0.4 % rounds to 0
  assert.equal(share(0.005), "1 %");  // 0.5 % rounds to 1, not under 1 %
  assert.equal(share(1 / 100), "1 %");
  assert.equal(share(50 / 100), "50 %");
  assert.equal(share(99 / 100), "99 %");  // exactly 99 % does not round to 100
  assert.equal(share(0.996), "over 99 %");  // 99.6 % rounds to 100 but is less than 100
  assert.equal(share(1), "100 %");
});

test("per-episode energies under 0.1 kWh show as Wh, otherwise as kWh with 2 decimals", () => {
  assert.equal(energyWh(0), "0 Wh");
  assert.equal(energyWh(0.0002), "under 1 Wh");  // 0.2 Wh rounds to 0
  assert.equal(energyWh(0.001), "1 Wh");  // 1 Wh rounds to 1
  assert.equal(energyWh(0.003), "3 Wh");
  assert.equal(energyWh(0.0999), "100 Wh");  // rounds to 100 Wh
  assert.equal(energyWh(0.1), `${fmt(0.1, 2)} kWh`);
  assert.equal(energyWh(0.123), `${fmt(0.123, 2)} kWh`);
  assert.equal(energyWh(1), `${fmt(1, 2)} kWh`);
});

test("a pull-away from standing reads up to its speed", () => {
  assert.equal(tipSentence(upTip("gentle", 0, 50)).title, "Pull away gently up to 50 km/h.");
  assert.equal(tipSentence(upTip("brisk", 0, 30)).title, "Pull away briskly up to 30 km/h.");
});

test("a slow-down tip names the band, whether it ended in a stop, and how often the best quarter braked", () => {
  assert.deepEqual(tipSentence(downTip(70, 90, true, 0)), {
    title: "Lift off earlier from 70–90 km/h before stopping.",
    evidence: "You braked in 7 of 9; your best quarter never did.",
  });
  assert.deepEqual(tipSentence(downTip(50, 70, false, 1 / 3)), {
    title: "Lift off earlier from 50–70 km/h.",
    evidence: "You braked in 7 of 9; your best quarter in only 33 %.",
  });
  assert.equal(tipSentence(downTip(90, null, false, 0)).title, "Lift off earlier above 90 km/h.");
  assert.equal(tipSentence(downTip(90, null, true, 0)).title, "Lift off earlier above 90 km/h before stopping.");
});

test("a best quarter that braked as often is told by its brake loss, not by an 'only'", () => {
  const tip = downTip(70, 90, true, 1);
  assert.equal(tipSentence(tip).evidence,
    `Your best quarter lost ${energyWh(0.02)} a slow-down to the brakes; you lost ${energyWh(0.1)}.`);
});

test("brake loss too small to quote for either side reads as small losses adding up, not two '0 Wh' figures", () => {
  const tip = downTip(70, 90, true, 0, {
    count: 45,
    you: { brakedShare: 44 / 45, liftSeconds: 4, brakeKwh: 0.0002, regenKwh: 0.1 },   // "under 1 Wh"
    best: { brakedShare: 0, liftSeconds: null, brakeKwh: 0, regenKwh: 0.1 },          // "0 Wh"
  });
  assert.equal(tipSentence(tip).evidence, "Small brake losses in 44 of 45 slow-downs add up.");
});

test("the sentences read a tip coach() made", () => {
  const [tip] = coach([drive({ down: stops() })], { regenEfficiency: 0.85 }).tips;
  assert.deepEqual(tipSentence(tip), {
    title: "Lift off earlier from 70–90 km/h before stopping.",
    evidence: "You braked in 7 of 9; your best quarter in only 33 %.",
  });
});

// ---------- what a tip is worth ----------

test("a tip's worth over the week or month under way, and over the drives shown", () => {
  // 1 kWh/100 km over 1000 km; a full pack at 14 instead of 15 kWh/100 km goes 13.6 km further.
  const tip = { savingPer100: 1 };
  assert.equal(worthLine(tip, 1000, 15, "month"), `≈ ${kwh(10)} this month · +14 km a charge`);
  assert.equal(worthLine(tip, 1000, 15, "week"), `≈ ${kwh(10)} this week · +14 km a charge`);
  assert.equal(worthLine(tip, 1000, 15, null), `≈ ${kwh(10)} over these drives · +14 km a charge`);
});

test("the range a charge gains is shown only once it rounds to a kilometre", () => {
  assert.equal(worthLine({ savingPer100: 0.03 }, 1000, 15, "month"), `≈ ${kwh(0.3)} this month`);          // +0.38 km
  assert.equal(worthLine({ savingPer100: 0.04 }, 1000, 15, "month"), `≈ ${kwh(0.4)} this month · +1 km a charge`);   // +0.51 km
});

test("a tip with no worth to work out has no worth line", () => {
  assert.equal(worthLine({ savingPer100: 1 }, null, 15, "month"), "");
  assert.equal(worthLine({ savingPer100: 1 }, 1000, null, "month"), "");
});

// ---------- the tips panel ----------

test("no situation to judge hides the panel; situations without tips say so", () => {
  assert.equal(tipsHtml({ situations: [], tips: [] }, () => ""), "");
  const calm = tipsHtml({ situations: [upTip("gentle", 0, 50)], tips: [] }, () => "");
  assert.match(calm, /No tip worth your attention right now\./);
});

test("each tip is a button that opens its situation", () => {
  const html = tipsHtml({ situations: [downTip(70, 90, true, 0)], tips: [downTip(70, 90, true, 0), upTip("brisk", 70, 110)] },
    tip => tip.kind === "up" ? "≈ 0.8 kWh this month" : "");
  assert.match(html, /<h2>Coach says<\/h2>/);
  assert.match(html, /data-evidence="slowingDown" data-situation="coach-down-70-stop"/);
  assert.match(html, /data-evidence="pullingAway" data-situation="coach-up-70-110"/);
  assert.equal(html.match(/aria-expanded="false"/g).length, 2);
  assert.equal(html.match(/class="worth"/g).length, 1, "a tip with no worth line has no empty one");
  assert.match(html, /<span class="worth">≈ 0.8 kWh this month<\/span>/);
});

// ---------- the dial ----------

test("the dial shows the score, how it sits against the usual, and the drives behind it", () => {
  const html = dialHtml({ score: 87, drives: 22 }, { usual: 83, verdict: "better" }, 23);
  assert.match(html, />87</);
  assert.match(html, /stroke-dasharray="426\.4 490\.1"/);   // 87 % of a 78-radius ring
  assert.match(html, /class="trend good">▲ 4 vs usual/);
  assert.match(html, /Based on 22 of 23 drives/);
  assert.match(dialHtml({ score: 80, drives: 5 }, { usual: 84.4, verdict: "worse" }, 5), /class="trend bad">▼ 4 vs usual/);
  assert.match(dialHtml({ score: 80, drives: 5 }, { usual: 80, verdict: "same" }, 5), /as usual/);
});

test("vs-usual and 'based on' are left out when there is nothing to say", () => {
  const html = dialHtml({ score: 87, drives: 5 }, null, 5);
  assert.doesNotMatch(html, /usual/);
  assert.doesNotMatch(html, /Based on/);
});

test("without a score the ring is empty and says what is missing", () => {
  const few = dialHtml({ score: null, drives: 3 }, null, 3);
  assert.match(few, /class="dial empty"/);
  assert.doesNotMatch(few, /class="ring"/);
  assert.match(few, /Not enough driving yet/);
  assert.match(few, /needs 9 similar pull-aways or slow-downs/);
  assert.match(dialHtml({ score: null, drives: 0 }, null, 4), /these logs have no power readings/);
  assert.match(dialHtml({ score: null, drives: 0 }, null, 0), /no drives in this period/);
  assert.match(dialHtml({ score: null, drives: 2 }, null, 4), /Based on 2 of 4 drives/);
});

// ---------- the phase bars ----------

const full = {
  pullingAway: { value: 93, count: 64 },
  slowingDown: { value: 82, count: 45 },
  anticipation: { value: 30, count: 20, youSeconds: 3.2, bestSeconds: 10.4 },
  consumption: { value: 100, count: 8, per100: 15.2, verdict: "same", cause: null },
};

test("each phase bar carries its figure and what it rests on", () => {
  const html = phasesHtml(full, "month");
  assert.match(html, /Pulling away<\/b> <span class="muted">· 93 · 64 pull-aways/);
  assert.match(html, /Slowing down<\/b> <span class="muted">· 82 · 45 slow-downs/);
  assert.match(html, /lift-off 3 s before braking · your best 10 s/);
  assert.match(html, new RegExp(`${fmt(15.2, 1)} kWh/100 km · same as usual`));
  assert.match(html, /<i style="width: 93%">/);
  assert.match(html, /class="bar neutral"><i style="width: 100%">/, "consumption is context, drawn in grey");
  assert.equal(html.match(/data-evidence=/g).length, 4);
  const one = phasesHtml({ ...full, pullingAway: { value: 50, count: 1 } }, "month");
  assert.match(one, /· 50 · 1 pull-away</);
});

test("consumption says whether it was worse, and when the cold is why", () => {
  const worse = { ...full, consumption: { ...full.consumption, value: 80, verdict: "worse" } };
  assert.match(phasesHtml(worse, "week"), /· worse than usual</);
  const cold = { ...full, consumption: { ...full.consumption, value: 80, verdict: "worse", cause: "cold" } };
  assert.match(phasesHtml(cold, "week"), /· worse than usual, mostly the cold</);
  const better = { ...full, consumption: { ...full.consumption, verdict: "better" } };
  assert.match(phasesHtml(better, "week"), /· better than usual</);
});

test("a phase with no value is drawn empty with the reason", () => {
  const none = {
    pullingAway: { value: null, count: 0 },
    slowingDown: { value: null, count: 0 },
    anticipation: { value: null, count: 0, youSeconds: null, bestSeconds: null },
    consumption: { value: null, count: 1, per100: 15.2, verdict: null, cause: null },
  };
  const html = phasesHtml(none, "week");
  assert.match(html, /needs 9 similar pull-aways/);
  assert.match(html, /needs 9 similar slow-downs/);
  assert.match(html, /no slow-downs where both you and your best braked/);
  assert.match(html, /needs 3 earlier periods/);
  assert.doesNotMatch(html, /<i /, "no bar is filled");
  assert.equal(html.match(/class="phase empty"/g).length, 4);
  assert.match(phasesHtml(none, "all"), /nothing earlier to compare with/);
  const noEnergy = { ...none, consumption: { ...none.consumption, per100: null } };
  assert.match(phasesHtml(noEnergy, "week"), /no energy readings in these logs/);
});

test("anticipation bar shows 'your best' only when bestSeconds > youSeconds", () => {
  const phases_best_better = {
    pullingAway: { value: 50, count: 1 },
    slowingDown: { value: 50, count: 1 },
    anticipation: { value: 50, count: 1, youSeconds: 4, bestSeconds: 10 },
    consumption: { value: 50, count: 1, per100: 15.2, verdict: "same", cause: null },
  };
  const html_better = phasesHtml(phases_best_better, "week");
  assert.match(html_better, /lift-off 4 s before braking · your best 10 s/);

  const phases_best_worse = {
    pullingAway: { value: 50, count: 1 },
    slowingDown: { value: 50, count: 1 },
    anticipation: { value: 50, count: 1, youSeconds: 4, bestSeconds: 2 },
    consumption: { value: 50, count: 1, per100: 15.2, verdict: "same", cause: null },
  };
  const html_worse = phasesHtml(phases_best_worse, "week");
  assert.match(html_worse, /lift-off 4 s before braking/);
  assert.doesNotMatch(html_worse, /· your best/);

  // Both round to same printed value: youSeconds 3.6 s prints "4 s", bestSeconds 4.4 s also prints "4 s"
  const phases_same_print = {
    pullingAway: { value: 50, count: 1 },
    slowingDown: { value: 50, count: 1 },
    anticipation: { value: 50, count: 1, youSeconds: 3.6, bestSeconds: 4.4 },
    consumption: { value: 50, count: 1, per100: 15.2, verdict: "same", cause: null },
  };
  const html_same = phasesHtml(phases_same_print, "week");
  assert.match(html_same, /lift-off 4 s before braking(?!.*your best)/);  // "lift-off 4 s" but NOT "your best"
});

// ---------- the evidence ----------

test("a slow-down panel splits regen from brake and sets you beside your best quarter", () => {
  const c = coach([drive({ down: [...stops(), ...times(4, () => stop(0, null, { v0: 100, v1: 60, toStop: 0 }))] })]);
  const html = situationsHtml(c, "down");
  assert.match(html, /<h3>From 70–90 km\/h to a stop · 9<\/h3>/);
  assert.match(html, /flex: 2"><\/span><span class="bad" style="flex: 7"/);
  assert.match(html, /2 on regen alone · 7 used the brake/);
  assert.match(html, /<td>braked<\/td><td>78 %<\/td><td>33 %<\/td>/);
  assert.match(html, /<td>lift-off<\/td><td>4 s before<\/td><td>11 s before<\/td>/);
  assert.match(html, new RegExp(`<td>brake loss</td><td>${kwh(0.1, 2)}</td><td>0 Wh<\/td>`));
  // Too few to judge, and listed after the lower band.
  assert.match(html, /class="evidence-panel small"[^>]*>\s*<p>From 90\+ km\/h, not to a stop — not enough yet, 4 of 9 needed\.<\/p>/);
  assert.ok(html.indexOf("From 70–90") < html.indexOf("From 90+"));
});

test("brake loss under 1 Wh for both you and your best draws the strip in neutral grey with a calmer caption", () => {
  const tip = downTip(70, 90, true, 0, {
    you: { brakedShare: 7 / 9, liftSeconds: 4, brakeKwh: 0.0002, regenKwh: 0.1 },   // "under 1 Wh"
    best: { brakedShare: 0, liftSeconds: null, brakeKwh: 0, regenKwh: 0.1 },        // "0 Wh"
  });
  const html = situationsHtml({ situations: [tip], small: [] }, "down");
  assert.match(html, /<div class="split" aria-hidden="true"><span style="flex: 2; background: var\(--line\)"><\/span><span style="flex: 7; background: var\(--neutral\)"><\/span><\/div>/);
  assert.match(html, /<p class="muted">the brake cost almost nothing on each slow-down — regen did most of the work<\/p>/);
  assert.doesNotMatch(html, /class="good"|class="bad"/);
  assert.doesNotMatch(html, /used the brake/);
});

test("a brake loss that is not negligible on either side keeps the usual red\/green strip", () => {
  const tip = downTip(70, 90, true, 0);   // you 0.10 kWh, best 20 Wh — neither reads as negligible
  const html = situationsHtml({ situations: [tip], small: [] }, "down");
  assert.match(html, /<span class="good" style="flex: 2"><\/span><span class="bad" style="flex: 7"><\/span>/);
  assert.match(html, /2 on regen alone · 7 used the brake/);
});

test("a best quarter that never braked reads 'never'", () => {
  const html = situationsHtml({ situations: [downTip(30, 50, true, 0)], small: [] }, "down");
  assert.match(html, /<td>braked<\/td><td>78 %<\/td><td>never<\/td>/);
  assert.match(html, /<td>lift-off<\/td><td>4 s before<\/td><td>never braked<\/td>/);
  assert.match(html, /id="coach-down-30-stop"/);
});

test("a slow-down evidence panel includes the 'best quarter' explanation note", () => {
  const html = situationsHtml({ situations: [downTip(30, 50, true, 0)], small: [] }, "down");
  assert.match(html, /<p class="muted">Best quarter = the slow-downs that lost least to the brakes\.<\/p>/);
});

test("a speed-up panel draws a dot per pull in its third's colour", () => {
  const c = coach([drive({ up: [...times(5, () => pull(1, 0.08)), ...times(5, () => pull(2.5, 0.12))] })]);
  const html = situationsHtml(c, "up");
  assert.match(html, /<h3>0→50 km\/h · 10<\/h3>/);
  assert.equal(html.match(/<circle class="gentle"/g).length, 3);
  assert.equal(html.match(/<circle class="moderate"/g).length, 4);
  assert.equal(html.match(/<circle class="brisk"/g).length, 3);
  assert.match(html, new RegExp(`0→50: brisk ${kwh(0.12, 2)} · gentle 80 Wh`));
  assert.match(html, /id="coach-up-0-50"/);
});

test("a kind with no groups at all says so", () => {
  const none = { situations: [], small: [] };
  assert.match(situationsHtml(none, "up"), /No pull-aways close to/);
  assert.match(situationsHtml(none, "down"), /No slow-downs from 30 km\/h or more/);
});

// ---------- the forecast ----------

test("the forecast line names the usual range, or says the forecast sits outside it", () => {
  assert.equal(forecastLine({ km: 780, low: 650, high: 900 }, "week"),
    `This week: heading for ~${fmt(780, 0)} km · usually ${fmt(650, 0)}–${fmt(900, 0)} km`);
  assert.equal(forecastLine({ km: 950, low: 650, high: 900 }, "month"),
    `This month: heading for ~${fmt(950, 0)} km · above your usual ${fmt(650, 0)}–${fmt(900, 0)} km`);
  assert.equal(forecastLine({ km: 600, low: 650, high: 900 }, "week"),
    `This week: heading for ~${fmt(600, 0)} km · below your usual ${fmt(650, 0)}–${fmt(900, 0)} km`);
  // On the boundary itself, it is still "usual", not below/above.
  assert.equal(forecastLine({ km: 650, low: 650, high: 900 }, "week"),
    `This week: heading for ~${fmt(650, 0)} km · usually ${fmt(650, 0)}–${fmt(900, 0)} km`);
  assert.equal(forecastLine({ km: 780, low: null, high: null }, "week"), `This week: heading for ~${fmt(780, 0)} km`);
  assert.equal(forecastLine(null, "week"), "");
});

test("a range whose ends print the same collapses to one figure, not a duplicate-looking dash", () => {
  assert.equal(forecastLine({ km: 105, low: 170, high: 170 }, "week"),
    `This week: heading for ~${fmt(105, 0)} km · below your usual ${fmt(170, 0)} km`);
  assert.equal(forecastLine({ km: 250, low: 170, high: 170 }, "week"),
    `This week: heading for ~${fmt(250, 0)} km · above your usual ${fmt(170, 0)} km`);
  assert.equal(forecastLine({ km: 170, low: 170, high: 170 }, "week"),
    `This week: heading for ~${fmt(170, 0)} km · usually ${fmt(170, 0)} km`);
  // Distinct raw values that round to the same printed figure still collapse.
  assert.equal(forecastLine({ km: 105, low: 169.6, high: 170.4 }, "week"),
    `This week: heading for ~${fmt(105, 0)} km · below your usual ${fmt(170, 0)} km`);
  // The unequal case still shows a range.
  assert.equal(forecastLine({ km: 77, low: 90, high: 156 }, "week"),
    `This week: heading for ~${fmt(77, 0)} km · below your usual ${fmt(90, 0)}–${fmt(156, 0)} km`);
});

// ---------- the whole tab ----------

const DAY = 86400e3;
const weekly = (at, extra = {}) => ({
  ...drive({ up: times(10, () => pull(1.5, 0.1)), start: at + 3600e3 }),
  end: at + 7200e3, moving: 3600, energy: 15, out: 17, regen: 2, outsideTemp: 15, ...extra,
});

test("the tab for a week under way: forecast, score against the usual, bars and evidence", () => {
  const start = weekStart(new Date(2026, 8, 14).getTime());
  const all = [weekly(start)];
  for (let at = start, k = 0; k < 4; k++) all.unshift(weekly(at = previousStart("week", at)));
  const { html, evidence } = coachHtml({ list: [all[4]], all, kind: "week", start, now: start + 2 * DAY, regenEfficiency: 0.85 });
  assert.match(html, /<p class="forecast">This week: heading for ~/);
  assert.ok(html.indexOf("forecast") < html.indexOf("class=\"dial"), "the forecast sits above the dial");
  assert.match(html, />100</);
  assert.match(html, /as usual/);
  assert.match(html, /· 100 · 10 pull-aways/);
  assert.match(html, /same as usual/);
  assert.match(html, /No tip worth your attention right now/);
  assert.match(html, /<div class="evidence" id="coachEvidence" hidden><\/div>/);
  assert.deepEqual(Object.keys(evidence), ["pullingAway", "slowingDown", "anticipation", "consumption"]);
  // Anticipation has evidence of its own: lift-off charts, not the slow-down panels.
  assert.match(evidence.pullingAway, /Brisk or gentle\?/);
  assert.match(evidence.consumption, /<td>distance<\/td><td>100 km<\/td><td>100 km<\/td>/);
  assert.match(evidence.consumption, /<td>outside<\/td><td>15 °C<\/td><td>15 °C<\/td>/);
});

test("all drives: no forecast and no usual, and the worth is over these drives", () => {
  const list = [drive({ up: [...times(5, () => pull(1, 0.08)), ...times(5, () => pull(2.5, 0.3))], start: 1 })]
    .map(s => ({ ...s, end: 2, moving: 60, energy: 15, out: 17, regen: 2 }));
  const { html } = coachHtml({ list, all: list, kind: "all", start: 0, now: Date.now(), regenEfficiency: 0.85 });
  assert.doesNotMatch(html, /heading for/);
  assert.doesNotMatch(html, /vs usual|as usual/);
  assert.match(html, /nothing earlier to compare with/);
  assert.match(html, /Pull away gently up to 50 km\/h\./);
  assert.match(html, /kWh over these drives/);
});

test("nothing taken from a file reaches the tab as markup", () => {
  const nasty = '<img src=x onerror="alert(1)">';
  const list = [{ ...weekly(0), file: nasty, vehicle: nasty, id: nasty, fileId: nasty }];
  const { html, evidence } = coachHtml({ list, all: list, kind: "all", start: 0, now: 1, regenEfficiency: 0.85 });
  for (const text of [html, ...Object.values(evidence)]) assert.doesNotMatch(text, /<img/);
  assert.equal(esc(nasty), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
});

// ---------- the anticipation evidence ----------

const liftGroup = (over = {}) => ({
  kind: "down", from: 70, to: 90, toStop: true, count: 20, split: 6,
  points: [...times(4, () => ({ liftSeconds: 10, lossAtRef: 0.02 })), ...times(4, () => ({ liftSeconds: 2, lossAtRef: 0.1 }))],
  early: 0.02, late: 0.1, saved: 0.08, ...over,
});

test("a group says what lifting off earlier was worth, in its own words", () => {
  const html = anticipationHtml([liftGroup()]);
  assert.match(html, /<h3>From 70–90 km\/h to a stop · 20<\/h3>/);
  assert.match(html, /Slow-downs where you lifted off 6 s or more before braking cost 80 Wh less, from 8 braked slow-downs\./);
  assert.match(html, /8 of 20 used the brake · the line is the middle of them, 6 s/);
  // The early half is drawn apart from the late one, and the split is a line.
  assert.equal((html.match(/class="early"/g) ?? []).length, 4);
  assert.equal((html.match(/class="late"/g) ?? []).length, 4);
  assert.match(html, /<line class="split-line"/);
});

test("lifting off later (negative saved) says so explicitly", () => {
  const html = anticipationHtml([liftGroup({ early: 0.05, late: 0.15, saved: -0.10 })]);
  assert.match(html, /Slow-downs where you lifted off later cost 0.10 kWh less here, from 8 braked slow-downs\./);
});

test("under 1 Wh saved means little difference regardless of sign", () => {
  assert.match(anticipationHtml([liftGroup({ saved: 0.0005 })]), /It made little difference here, from 8 braked slow-downs\./);
  assert.match(anticipationHtml([liftGroup({ saved: -0.0005 })]), /It made little difference here, from 8 braked slow-downs\./);
});

test("under a watt-hour a slow-down, and with no braking at all, the panel says so", () => {
  assert.match(anticipationHtml([liftGroup({ early: 0.02, late: 0.0205, saved: 0.0005 })]), /It made little difference here, from 8 braked slow-downs\./);
  assert.match(anticipationHtml([liftGroup({ early: 0.1, late: 0.02, saved: -0.0008 })]), /It made little difference here, from 8 braked slow-downs\./);
  assert.match(anticipationHtml([liftGroup({ points: [], split: null, early: null, late: null, saved: null })]),
    /evidence-panel small[^]*From 70–90 km\/h to a stop — you never braked in these\./);
  assert.match(anticipationHtml([]), /No slow-downs from 30 km\/h or more with brake-pedal readings here\./);
});

test("under MIN_ANSWER braked slow-downs, the chart still draws but the verdict says how short it is", () => {
  // 7 points: under MIN_ANSWER (8), even though a real early/late split exists.
  const points = [...times(4, () => ({ liftSeconds: 10, lossAtRef: 0.02 })), ...times(3, () => ({ liftSeconds: 2, lossAtRef: 0.1 }))];
  const html = anticipationHtml([liftGroup({ points, count: 7 })]);
  assert.doesNotMatch(html, /evidence-panel small/);
  assert.match(html, /<circle /);   // the chart is still drawn
  assert.match(html, /Too few braked slow-downs to compare yet \(7 of 8\)\./);
  assert.doesNotMatch(html, /cost .* less/);

  // A single braked slow-down: same "too few" wording, still charted (not dimmed).
  const one = anticipationHtml([liftGroup({ points: [{ liftSeconds: 3, lossAtRef: 0.1 }], split: 3, early: null, late: null, saved: null })]);
  assert.doesNotMatch(one, /evidence-panel small/);
  assert.match(one, /<circle /);
  assert.match(one, /Too few braked slow-downs to compare yet \(1 of 8\)\./);
});

test("at MIN_ANSWER braked slow-downs with a real split, the verdict prints and carries its sample", () => {
  const html = anticipationHtml([liftGroup({ count: 8 })]);   // 8 points already meets MIN_ANSWER
  assert.match(html, /Slow-downs where you lifted off 6 s or more before braking cost 80 Wh less, from 8 braked slow-downs\./);
});

test("the lift-off dots are scaled inside the picture and the split line stands among them", () => {
  const svg = liftChart([{ liftSeconds: 2, lossAtRef: 0 }, { liftSeconds: 10, lossAtRef: 0.05 }], 6);
  assert.match(svg, /<circle class="late" cx="20.0" cy="100.0"/);     // the earliest x, the lowest y
  assert.match(svg, /<circle class="early" cx="290.0" cy="20.0"/);    // the latest x, the highest y
  assert.match(svg, /<line class="split-line" x1="155.0" y1="20" x2="155.0" y2="110"\/>/);
  assert.match(svg, /aria-label="2 braked slow-downs by how long the driver coasted first and what the brakes cost"/);
  assert.match(svg, /brake loss at your usual speed shed \(Wh\)/);
});

test("liftChart plots the normalised loss (lossAtRef), not the raw brake energy", () => {
  // brakeKwh is deliberately the inverse of lossAtRef here: if the chart read brakeKwh, the dots would flip.
  const points = [{ liftSeconds: 2, brakeKwh: 0.5, lossAtRef: 0 }, { liftSeconds: 10, brakeKwh: 0, lossAtRef: 0.05 }];
  const svg = liftChart(points, 6);
  assert.match(svg, /<circle class="late" cx="20.0" cy="100.0"/);
  assert.match(svg, /<circle class="early" cx="290.0" cy="20.0"/);
});

// ---------- brisk or gentle ----------

const styles = (gentleEta, briskEta) => ({
  gentle: { count: 8, accel: 0.3, eta: gentleEta, seconds: 60 },
  moderate: { count: 8, accel: 0.6, eta: (gentleEta + briskEta) / 2, seconds: 30 },
  brisk: { count: 8, accel: 0.9, eta: briskEta, seconds: 20 },
});
// 0 → 72 km/h with a car of 1600 kg, and a cruise figure the test hands in rather than fits.
const answer = (gentleEta, briskEta, per100, over = {}) => pullAnswerHtml({
  styles: styles(gentleEta, briskEta), used: 15, dropped: 0, from: 0, to: 72, massKg: 1600,
  per100At: () => per100, source: "fit", ...over,
});

test("when brisk is faster and cheaper, it arrives sooner", () => {
  const html = answer(2.5, 1.2, 8);
  // brisk: 0.9 m/s² is faster, eta 1.2 is lower cost. Legs print 0.14 and 0.22 kWh, so the
  // difference is the difference of those printed figures (0.08 kWh), not a re-bucketed Wh figure.
  assert.match(html, /brisk uses 0.08 kWh less and brisk arrives 23 s sooner\./);
});

test("when gentle is cheaper but brisk is faster, brisk arrives sooner", () => {
  const html = answer(2.2, 1.5, 18);
  // brisk: eta 1.5 lower raw, but the legs print 0.20 and 0.21 kWh - the difference a reader sees is 0.01 kWh.
  assert.match(html, /gentle uses 0.01 kWh less and brisk arrives 23 s sooner\./);
});

test("a difference under 5 Wh is no difference at all", () => {
  // Gentle 2.5 · 0.0889 = 0.2222 kWh; brisk 2.1 · 0.0889 + 8 / 100 · 0.4444 km = 0.1867 + 0.0356 = the same.
  const html = answer(2.5, 2.1, 8);
  assert.match(html, /the same energy either way, and brisk arrives 23 s sooner\./);
  assert.doesNotMatch(html, /uses .* less/);
  assert.doesNotMatch(html, /gentle arrives .* later/);
});

test("energy clause names the style with lower kWh printed", () => {
  const html = answer(2.5, 1.2, 8);
  // brisk: 1.2 eta, gentle: 2.5 eta => brisk has lower kWh
  assert.match(html, /<b>brisk<\/b>.*0.14 kWh · <b>gentle<\/b>.*0.22 kWh/);
  assert.match(html, /brisk uses 0.08 kWh less/);
});

test("the energy and time clauses can never contradict the printed figures beside them", () => {
  // Real-log-shaped case: raw saving is under the old 0.005 threshold (would have read "the same"),
  // but the two legs print 0.24 and 0.25 kWh - visibly different - so the clause must say so.
  const near5Rounding = pullAnswerHtml({
    styles: { gentle: { count: 8, accel: 0.2815, eta: 2.232, seconds: 60 },
      moderate: { count: 8, accel: 0.5, eta: 2, seconds: 30 }, brisk: { count: 8, accel: 0.8, eta: 1.86, seconds: 20 } },
    used: 15, dropped: 0, from: 0, to: 80, massKg: 1600, per100At: () => 8, source: "fit",
  });
  // Gentle prints the lower figure (0.24 < 0.25 kWh), so gentle is genuinely the cheaper style here -
  // brisk only wins on time. Naming brisk as cheaper would itself contradict the printed 0.24/0.25.
  assert.match(near5Rounding, /<b>gentle<\/b> \(0\.3 m\/s², 79 s\) 0\.24 kWh · <b>brisk<\/b> \(0\.8 m\/s², 53 s\) 0\.25 kWh/);
  assert.match(near5Rounding, /gentle uses 0\.01 kWh less and brisk arrives 26 s sooner\./);

  // A truly equal case (both legs print, and are, the same kWh): "the same energy either way".
  const trulyEqual = pullAnswerHtml({
    styles: { gentle: { count: 8, accel: 0.2815, eta: 2.232, seconds: 60 },
      moderate: { count: 8, accel: 0.5, eta: 2, seconds: 30 }, brisk: { count: 8, accel: 0.8, eta: 1.8175683836589698, seconds: 20 } },
    used: 15, dropped: 0, from: 0, to: 80, massKg: 1600, per100At: () => 8, source: "fit",
  });
  assert.match(trulyEqual, /the same energy either way, and brisk arrives 26 s sooner\./);
});

test("a sub-second time gap reads 'they arrive together', not '0 s sooner'", () => {
  // gentle totals exactly 60 s; brisk totals 59.7 s - 0.3 s sooner raw, but both round to 60 s.
  // Rounding the diff first (old code) would have printed "brisk arrives 0 s sooner".
  const accelG = 72 / (3.6 * 60), accelB = 1 / (1 / accelG - 0.03);
  const html = pullAnswerHtml({
    styles: { gentle: { count: 8, accel: accelG, eta: 2.5, seconds: 60 },
      moderate: { count: 8, accel: (accelG + accelB) / 2, eta: 1.85, seconds: 30 }, brisk: { count: 8, accel: accelB, eta: 1.2, seconds: 20 } },
    used: 15, dropped: 0, from: 0, to: 72, massKg: 1600, per100At: () => 8, source: "fit",
  });
  assert.match(html, /and they arrive together\./);
  assert.doesNotMatch(html, /0 s sooner/);
});

test("the muted line says what the answer rests on, and where the cruise figure came from", () => {
  assert.match(answer(2.5, 1.2, 8), /From all your driving: 15 pull-aways, gentle 0.3 m\/s², brisk 0.9 m\/s²\. Cruising at 72 km\/h costs 8.0 kWh\/100 km\./);
  assert.match(answer(2.5, 1.2, 8, { source: "physics" }),
    /Cruising at 72 km\/h costs 8.0 kWh\/100 km, from the physics settings, not your driving\./);
});

test("without two styles, or with the speeds the wrong way round, the block says why", () => {
  // Fewer than MIN_STYLE in a tercile is still short of MIN_ANSWER: the shortfall line always names
  // the figure that actually gates an answer, never the smaller MIN_STYLE threshold.
  assert.match(answer(2.5, 1.2, 8, { styles: { gentle: null, moderate: null, brisk: null } }),
    /Needs at least 8 gentle and 8 brisk pull-aways\./);
  assert.match(answer(2.5, 1.2, 8, { from: 90, to: 50 }), /The second speed has to be the higher one\./);
  assert.match(answer(2.5, 1.2, 8, { from: 0, to: 200 }), /Both speeds have to be between 0 and 160 km\/h\./);
  assert.match(answer(2.5, 1.2, 8, { to: null }), /Type both speeds\./);
  // The reason replaces the answer, not the line under it.
  assert.match(answer(2.5, 1.2, 8, { from: 90, to: 50 }), /From all your driving: 15 pull-aways/);
});

test("the block opens on 0 and 80 km/h and draws every usable pull-away", () => {
  const points = [0.2, 0.5, 0.9].map((accel, i) => ({ accel, eta: 2 - i * 0.3, v0: 0, v1: 50, style: ["gentle", "moderate", "brisk"][i] }));
  const html = pullHtml({
    styles: styles(2.5, 1.2), points, used: 3, dropped: 0, ...PULL_RANGE, massKg: 1600, per100At: () => 14, source: "fit",
  });
  assert.deepEqual(PULL_RANGE, { from: 0, to: 80 });
  assert.match(html, /<input type="number" data-pull="from" min="0" max="160" step="1" inputmode="numeric"\s+value="0"/);
  assert.match(html, /data-pull="to"[^>]*\s+value="80"/);
  assert.match(html, /All your driving, not just this period\./);
  assert.equal((html.match(/<circle /g) ?? []).length, 3);
  assert.match(html, /kWh per kWh gained ↑/);
});

test("the answer includes an explanation that which style wins depends on end speed only", () => {
  const html = answer(2.5, 1.2, 8);
  assert.match(html, /Which style wins depends on the speed you end at: the faster you then cruise, the more the brisk pull-away's head start costs\. The starting speed only changes how big the difference is\./);
});

test("the explanation line is absent when the block shows a reason instead of an answer", () => {
  assert.doesNotMatch(answer(2.5, 1.2, 8, { styles: { gentle: null, moderate: null, brisk: null } }), /Which style wins depends/);
  assert.doesNotMatch(answer(2.5, 1.2, 8, { from: 90, to: 50 }), /Which style wins depends/);
});

test("dropped pull-aways are named in their own sentence", () => {
  assert.match(answer(2.5, 1.2, 8, { dropped: 3 }), /3 pull-aways left out as unusable\./);
  assert.match(answer(2.5, 1.2, 8, { dropped: 1 }), /1 pull-away left out as unusable\./);
  assert.doesNotMatch(answer(2.5, 1.2, 8, { dropped: 0 }), /left out as unusable/);
});

test("the hedge line appears with an answer and is absent with a reason", () => {
  assert.match(answer(2.5, 1.2, 8), /From your median gentle and brisk pull-aways, so a hill or a headwind moves the dots more than the answer\./);
  assert.doesNotMatch(answer(2.5, 1.2, 8, { styles: { gentle: null, moderate: null, brisk: null } }), /From your median gentle and brisk/);
  assert.doesNotMatch(answer(2.5, 1.2, 8, { from: 90, to: 50 }), /From your median gentle and brisk/);
});

test("the hedge names where the pull-aways were measured, and flags a target speed outside that range", () => {
  const points = [30, 50, 70, 90, 110].map(v1 => ({ v1 }));
  const inside = answer(2.5, 1.2, 8, { points });   // to: 72, well within 50-90
  assert.match(inside, /From your median gentle and brisk pull-aways, measured mostly between 50 and 90 km\/h, so a hill or a headwind moves the dots more than the answer\./);
  assert.doesNotMatch(inside, /rarely reach this speed/);

  const outside = answer(2.5, 1.2, 8, { points, to: 120 });   // 120 is above the 50-90 range
  assert.match(outside, /measured mostly between 50 and 90 km\/h/);
  assert.match(outside, /Your pull-aways rarely reach this speed, so this answer is a guess\./);
});

test("needs at least MIN_ANSWER episodes in each outer third", () => {
  const styleWith = (count) => ({
    gentle: { count, accel: 0.3, eta: 2.5, seconds: 60 },
    moderate: { count, accel: 0.6, eta: 1.85, seconds: 30 },
    brisk: { count, accel: 0.9, eta: 1.2, seconds: 20 },
  });
  assert.match(answer(2.5, 1.2, 8, { styles: styleWith(7) }),
    /Needs at least 8 gentle and 8 brisk pull-aways\./);
  // With 8 episodes it should work (unless per100 is missing)
  const htmlWith8 = answer(2.5, 1.2, 8, { styles: styleWith(8) });
  assert.doesNotMatch(htmlWith8, /Needs at least 8/);
});
