import { test } from "node:test";
import assert from "node:assert/strict";
import { chargingCurve } from "../stats/charges.js";
import { recommendHtml, curveCaption, curveSvg, tripTable, formHtml, resultHtml, drawTrip, NO_CURVE } from "../stats/trip-view.js";

const BANDS = [0, 30, 50, 70, 90, 110, 130];
/** A stored drive whose speed bands are { from: [km, kmh, per100] }, as in tests/trip.test.mjs. */
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
const law = v => 8 + 0.001 * v * v;
const DRIVES = [drive({ 50: [40, 60, law(60)], 70: [40, 80, law(80)], 90: [40, 100, law(100)], 110: [40, 120, law(120)] }, 12)];
const CURVE = chargingCurve([]).map((b, i) => ({ ...b, kw: [60, 60, 60, 60, 60, 20, 10][i] }));
const TRIP = { km: 300, socStart: 100, socMin: 10, stopMinutes: 5, temp: 12 };
const args = (o = {}) => ({ drives: DRIVES, curve: CURVE, perPoint: 0.25, calibration: undefined, trip: TRIP, speedsText: "", ...o });

const text = html => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const planned = (kmh, extra = {}) => ({
  speed: { kmh }, total: 210, driving: 183, charging: 22, stops: 1, target: 70, arrival: 14.2, kwh: 57.9, estimated: false, ...extra,
});

// ---------- the Recommended panel ----------

test("the recommended speed says where it was found only when rounding moved it", () => {
  // 103 rounds to 105 (round5): the note is honest, so it shows. 103/105 shown.
  const rounded = text(recommendHtml({ found: 103, speed: 105, row: planned(105) }, "vs 130 km/h: 9 min sooner"));
  assert.match(rounded, /Recommended 105 km\/h/);
  assert.match(rounded, /fastest arrival · best found at 103, rounded to 105/);
  assert.match(rounded, /3 h 30 min · 1 stop to 70 % \(22 min\) · arrive with 14 %/);
  assert.match(rounded, /vs 130 km\/h: 9 min sooner$/);

  const exact = text(recommendHtml({ found: 105, speed: 105, row: planned(105, { stops: 2, charging: 30.4, target: 80 }) }, null));
  assert.match(exact, /fastest arrival 3 h 30 min · 2 stops to 80 % \(30 min\)/);
  assert.doesNotMatch(exact, /best found|vs /);

  const none = text(recommendHtml({ found: 150, speed: 150, row: planned(150, { stops: 0, charging: 0, total: 119.6 }) }, null));
  assert.match(none, /2 h 00 min · no stop · arrive with/);
  assert.doesNotMatch(none, /no stop to/, "no charge-to level when there are no stops");

  // found and speed differ, but round5(found) === speed: note present
  const nearRounding = text(recommendHtml({ found: 103, speed: 105, row: planned(105) }, null));
  assert.match(nearRounding, /best found at 103, rounded to 105/);

  // 103 rounds to 105, not 100: the note would be false, so it is hidden. 103/100 hidden.
  const falseRounding = text(recommendHtml({ found: 103, speed: 100, row: planned(100) }, null));
  assert.doesNotMatch(falseRounding, /best found/);

  // found and speed differ by far more than a rounding: no note. 89/135 hidden.
  const farApart = text(recommendHtml({ found: 89, speed: 135, row: planned(135) }, null));
  assert.doesNotMatch(farApart, /best found/);

  // found === speed: no rounding happened at all. equal hidden.
  assert.doesNotMatch(exact, /best found/);
});

// ---------- the table ----------

test("the table marks exactly the recommended row, in speed order, and says which are estimated", () => {
  const html = resultHtml(args({ speedsText: "150, 95 110" }));
  const rows = [...html.matchAll(/<tr( class="best")?><td>(\d+) km\/h( <span class="muted">estimated<\/span>)?/g)];
  const best = rows.filter(r => r[1]).map(r => Number(r[2]));
  assert.equal(best.length, 1);
  assert.deepEqual(rows.map(r => Number(r[2])), [95, 110, best[0], 150].sort((a, b) => a - b));
  assert.deepEqual(rows.filter(r => r[3]).map(r => Number(r[2])), [150], "only past 120 + 15 km/h");
  assert.match(text(html), new RegExp(`Recommended ${best[0]} km/h`));
});

test("with no speed typed, the table holds the recommended row alone", () => {
  const html = resultHtml(args());
  assert.equal((html.match(/<tr[ >]/g) ?? []).length, 2, "the heading and one row");
  assert.equal((html.match(/class="best"/g) ?? []).length, 1);
});

test("a row that cannot plan says why across the rest of the row", () => {
  const html = tripTable([
    planned(95),
    { speed: { kmh: 110 }, blocked: { from: 70 }, estimated: false },
    { speed: { kmh: 150 }, estimated: true },
  ], 95);
  assert.match(html, /<td colspan="6" class="muted">not plannable past 70 %: no charge on record has gone through that band<\/td>/);
  assert.match(html, /150 km\/h <span class="muted">estimated<\/span><\/td><td colspan="6" class="muted">no plan at this speed/);
  assert.match(text(html), /95 km\/h 3 h 03 min 1 · to 70 % 22 min 3 h 30 min 57[.,]9 14 %/);
});

test("the table's Stops cell names the charge-to level, or plainly zero", () => {
  const rows = [
    { speed: { kmh: 95 }, total: 228, driving: 183, charging: 45, stops: 3, target: 70, arrival: 14, kwh: 57.9, estimated: false },
    { speed: { kmh: 110 }, total: 120, driving: 120, charging: 0, stops: 0, target: 70, arrival: 20, kwh: 50, estimated: false },
  ];
  const html = text(tripTable(rows, null));
  assert.match(html, /95 km\/h 3 h 03 min 3 · to 70 % 45 min/);
  assert.match(html, /110 km\/h 2 h 00 min 0 0 min/);
});

// ---------- what the plan is based on ----------

test("the caption says whose driving the line comes from", () => {
  const fit = { source: "fit", atTemp: true, from: 60, to: 118.4 };
  assert.equal(curveCaption(fit, 12), "Your driving from 7 to 17 °C (dots, sized by km). Above 133 km/h the line is estimated.");
  assert.equal(curveCaption({ ...fit, atTemp: false }, 12),
    "From all your driving, too little of it from 7 to 17 °C (dots, sized by km). Above 133 km/h the line is estimated.");
  assert.equal(curveCaption({ ...fit, atTemp: false }, null),
    "From all your driving (dots, sized by km). Above 133 km/h the line is estimated.");
  assert.equal(curveCaption({ source: "physics", atTemp: false, from: null, to: null }, 12), "Based on the physics settings, not your driving.");
  // a range that dips below zero uses a true minus sign, not the hyphen fmt() gives -10.
  assert.equal(curveCaption(fit, -5), "Your driving from −10 to 0 °C (dots, sized by km). Above 133 km/h the line is estimated.");
});

test("the chart draws the line solid where the driving vouches for it, a dot per band and the marker", () => {
  const model = { source: "fit", per100: law, from: 60, to: 120, atTemp: false,
    points: [{ kmh: 60, per100: law(60), km: 40 }, { kmh: 120, per100: law(120), km: 10 }, { kmh: 155, per100: 30, km: 20 }] };
  const svg = curveSvg(model, 105);
  assert.equal((svg.match(/<polyline class="solid"/g) ?? []).length, 1);
  assert.equal((svg.match(/<polyline class="dashed"/g) ?? []).length, 1, "only past 135 km/h; solid down to 50 even below the slowest band");
  const radii = [...svg.matchAll(/<circle [^>]*r="([\d.]+)"/g)].map(m => Number(m[1]));
  assert.deepEqual(radii, [8, 4], "area follows km, and a band past the chart is left off");
  assert.match(svg, /<line class="marker" x1="(\d+\.\d)"[^>]*\/><text class="marker"[^>]*>105<\/text>/);

  const physics = curveSvg({ ...model, source: "physics", points: [] }, null);
  assert.equal((physics.match(/<polyline class="dashed"/g) ?? []).length, 1);
  assert.doesNotMatch(physics, /class="solid"|<circle|class="marker"/);
});

// ---------- the curve's ceiling ----------

test("a muted sentence names the curve's ceiling only when it stops short of 100 %", () => {
  const full = text(resultHtml(args()));   // CURVE has a kW figure through the 90-100 % band
  assert.doesNotMatch(full, /no data above/);

  const cappedAt70 = CURVE.map((b, i) => ({ ...b, kw: i < 4 ? b.kw : null }));   // data only through 60-70 %
  const capped = text(resultHtml(args({ curve: cappedAt70 })));
  assert.match(capped, /Your charging curve has no data above 70 %, so every stop charges to 70 % at most\./);
});

// ---------- states ----------

test("a form that cannot be planned is said back, field by field", () => {
  assert.match(text(resultHtml(args({ trip: { ...TRIP, km: null, socMin: null } }))), /^Fill in distance, arrive with at least\.$/);
  assert.match(text(resultHtml(args({ trip: { ...TRIP, socStart: 150 } }))), /^starting charge: that is not a figure the car can have\.$/);
  assert.match(text(resultHtml(args({ trip: { ...TRIP, km: 0 } }))), /^A trip of no distance needs no plan\.$/);
  assert.match(text(resultHtml(args({ trip: { ...TRIP, socMin: 100 } }))), /set off with more charge/);
  const blind = CURVE.map((b, i) => ({ ...b, kw: i ? b.kw : null }));
  assert.match(text(resultHtml(args({ curve: blind, speedsText: "95" }))),
    /^No speed from 60 to 150 km\/h gets this trip there: it would have to charge past 0 %, and no charge on record has gone through that band\. Cruise .* 95 km\/h not plannable past 0 %/);
});

test("speeds that cannot be used are named back, and the rest still plan", () => {
  const html = text(resultHtml(args({ speedsText: "35, 110" })));
  assert.match(html, /^35 is not a speed the planner can use: 40 to 160 km\/h\. Recommended/);
  assert.match(html, /110 km\/h/);
  assert.match(text(resultHtml(args({ speedsText: "35 fast" }))), /^35, fast are not speeds the planner can use/);
});

test("without a charging curve the tab says so instead of the planner, and why when drives carry no charge level", () => {
  const el = { innerHTML: "", querySelector: () => null };
  // DRIVES' one drive has no socStart/socEnd at all: it is the "1 of 1" case.
  drawTrip(el, args({ curve: chargingCurve([]) }));
  assert.equal(el.innerHTML, `<p class="muted">${NO_CURVE} 1 of 1 drives carry no charge level.</p>`);

  const withSoc = [{ ...DRIVES[0], socStart: 80, socEnd: 60 }, DRIVES[0]];
  drawTrip(el, args({ curve: chargingCurve([]), drives: withSoc }));
  assert.equal(el.innerHTML, `<p class="muted">${NO_CURVE} 1 of 2 drives carry no charge level.</p>`);

  drawTrip(el, args({ curve: chargingCurve([]), drives: [withSoc[0]] }));
  assert.equal(el.innerHTML, `<p class="muted">${NO_CURVE}</p>`, "nothing to add when every drive carries a charge level");
});

test("the form is written once and typing redraws only the results", () => {
  const right = { innerHTML: "" };
  let form = null;
  const el = {
    set innerHTML(html) { form = html.includes("trip-form") ? {} : null; this.html = html; },
    get innerHTML() { return this.html; },
    querySelector: sel => sel === ".trip-form" ? form : sel === ".trip-right" && form ? right : null,
  };
  drawTrip(el, args());
  const first = el.innerHTML;
  assert.match(first, /data-trip="speeds"/);
  assert.match(right.innerHTML, /Recommended/);
  drawTrip(el, args({ speedsText: "95" }));
  assert.equal(el.innerHTML, first, "the form was left alone");
  assert.match(right.innerHTML, /95 km\/h/);
});

test("the form lays out every field with its unit, and keeps what was typed", () => {
  const html = formHtml({ ...TRIP, temp: null }, "95, 110");
  for (const label of ["Distance", "Starting charge", "Arrive with at least", "Lost at each stop", "Outside temperature"]) {
    assert.match(html, new RegExp(`<label for="trip-\\w+">${label}</label><input`));
  }
  assert.match(html, /data-trip="km" value="300"><span class="unit">km<\/span>/);
  assert.match(html, /data-trip="temp" value=""><span class="unit">°C<\/span>/);
  assert.match(html, /data-trip="speeds" placeholder="e.g. 95, 110, 130"\s+value="95, 110">/);
  assert.match(html, /Cruise speeds\. Times assume you hold them the whole way, so real trips take a little longer\./);
});

test("text typed into the speeds field is escaped wherever it is shown", () => {
  const hostile = `"><script>alert(1)</script>`;
  const form = formHtml(TRIP, hostile);
  assert.doesNotMatch(form, /<script>/);
  assert.match(form, /value="&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
  const result = resultHtml(args({ speedsText: `<b>fast</b>` }));
  assert.doesNotMatch(result, /<b>/);
  assert.match(result, /&lt;b&gt;fast&lt;\/b&gt; is not a speed/);
});
