// The Trip tab: the trip form, the recommended speed, the line the plan rests
// on and the table of speeds. Every sentence is written here in pure functions
// a test can read; drawTrip() is the only part that touches the page, and the
// page keeps only the typing and the remembering.

import { esc, fmt } from "./coach-view.js";
import {
  speedModel, parseSpeeds, planAt, recommendSpeed, tableSpeeds, compareLine, round5,
  TEMP_NEAR, SPEED_MIN, SPEED_MAX, SEARCH_MIN, SEARCH_MAX, ESTIMATE_AFTER,
} from "./trip.js";
import { noSocCount } from "./charges.js";

export const TRIP_FIELDS = [
  { key: "km", label: "Distance", unit: "km", step: 10, min: 0 },
  { key: "socStart", label: "Starting charge", unit: "%", step: 5, min: 0, max: 100 },
  { key: "socMin", label: "Arrive with at least", unit: "%", step: 1, min: 0, max: 100 },
  { key: "stopMinutes", label: "Lost at each stop", unit: "min", step: 1, min: 0 },
  { key: "temp", label: "Outside temperature", unit: "°C", step: 1 },
];

export const NO_CURVE = "Trips can be planned once a DC charge is on record.";

/** NO_CURVE, plus how many of the stored drives carry no charge level at all - the reason there may be nothing to plan on. */
const noCurveLine = drives => {
  const missing = noSocCount(drives);
  return missing ? `${NO_CURVE} ${missing} of ${drives.length} drives carry no charge level.` : NO_CURVE;
};

// Minutes rounded once, so 59.6 reads as 1 h 00 min and not as 0 h 59 min.
const clock = m => { const r = Math.round(m); return `${Math.floor(r / 60)} h ${String(r % 60).padStart(2, "0")} min`; };
const stopsText = (n, target) => n === 0 ? "no stop" : `${n} stop${n === 1 ? "" : "s"} to ${fmt(target, 0)} %`;
// fmt() uses the browser's hyphen; a temperature range reads better with a true minus sign.
const signed = v => fmt(v, 0).replace("-", "−");

/** The left panel. Drawn once per state: redrawing it would take the focus out of the field being typed in. */
export const formHtml = (trip, speedsText) => `<div class="trip-panel trip-form">
  <h2>Your trip</h2>
  <div class="trip-grid">${TRIP_FIELDS.map(f => `
    <label for="trip-${f.key}">${esc(f.label)}</label><input id="trip-${f.key}" type="number" step="${f.step}"${
      f.min == null ? "" : ` min="${f.min}"`}${f.max == null ? "" : ` max="${f.max}"`} data-trip="${f.key}" value="${esc(trip[f.key] ?? "")}"><span class="unit">${esc(f.unit)}</span>`).join("")}
  </div>
  <h2><label for="trip-speeds">Speeds to compare</label></h2>
  <div class="trip-grid"><input id="trip-speeds" class="trip-speeds" type="text" data-trip="speeds" placeholder="e.g. 95, 110, 130"
    value="${esc(speedsText)}"><span class="unit">km/h</span></div>
  <p class="muted">Cruise speeds. Times assume you hold them the whole way, so real trips take a little longer.</p>
</div>`;

/** The Recommended panel: the speed, why, what the trip then looks like, and what the tempting speed would change. */
export function recommendHtml(rec, compare) {
  const r = rec.row;
  return `<div class="trip-panel trip-recommend">
  <h2>Recommended</h2>
  <div class="trip-big">${rec.speed} km/h</div>
  <div class="muted">fastest arrival${rec.found !== rec.speed && round5(rec.found) === rec.speed ? ` · best found at ${rec.found}, rounded to ${rec.speed}` : ""}</div>
  <p>${clock(r.total)} · ${stopsText(r.stops, r.target)}${r.stops ? ` (${fmt(r.charging, 0)} min)` : ""} · arrive with ${fmt(r.arrival, 0)} %</p>
  ${compare ? `<p class="worth">${esc(compare)}</p>` : ""}
</div>`;
}

/** What the line under the chart says about where it came from. */
export function curveCaption(model, temp) {
  if (model.source === "physics") return "Based on the physics settings, not your driving.";
  const range = Number.isFinite(temp) ? `from ${signed(temp - TEMP_NEAR)} to ${signed(temp + TEMP_NEAR)} °C` : null;
  const whose = model.atTemp ? `Your driving ${range}`
    : `From all your driving${range ? `, too little of it ${range}` : ""}`;
  return `${whose} (dots, sized by km). Above ${fmt(model.to + ESTIMATE_AFTER, 0)} km/h the line is estimated.`;
}

const X0 = 30, X1 = 350, Y0 = 122, Y1 = 14, V0 = 50, V1 = 150;

/**
 * The model from 50 to 150 km/h: solid up to the estimated boundary (the
 * caption's "above N km/h"), dashed past it, the bands it was fitted to as
 * dots whose area follows their km, and the recommended speed as a marker.
 */
export function curveSvg(model, speed) {
  const vs = [];
  for (let v = V0; v <= V1; v++) vs.push(v);
  const shown = model.points.filter(p => p.kmh >= V0 && p.kmh <= V1);
  const values = [...vs.map(model.per100), ...shown.map(p => p.per100)];
  const lo = Math.floor(Math.min(...values) / 5) * 5, hi = Math.max(Math.ceil(Math.max(...values) / 5) * 5, lo + 5);
  const x = v => (X0 + (v - V0) / (V1 - V0) * (X1 - X0)).toFixed(1);
  const y = p => (Y0 - (p - lo) / (hi - lo) * (Y0 - Y1)).toFixed(1);
  const line = (from, to, cls) => {
    const part = vs.filter(v => v >= from && v <= to);
    return part.length < 2 ? "" : `<polyline class="${cls}" points="${part.map(v => `${x(v)},${y(model.per100(v))}`).join(" ")}"/>`;
  };
  const solidTo = model.source === "fit" ? Math.ceil(model.to + ESTIMATE_AFTER) : -Infinity;
  const most = Math.max(...shown.map(p => p.km));
  return `<svg class="trip-curve" viewBox="0 0 360 140" role="img" aria-label="Consumption by speed">
  <line class="axis" x1="${X0}" y1="${Y0}" x2="${X1}" y2="${Y0}"/><line class="axis" x1="${X0}" y1="${Y1}" x2="${X0}" y2="${Y0}"/>
  <text x="${X0 - 4}" y="${Y1 + 4}" text-anchor="end">${hi}</text><text x="${X0 - 4}" y="${Y0}" text-anchor="end">${lo}</text>
  <text x="${X0 + 4}" y="${Y1 + 4}">kWh/100 km</text>
  ${[50, 100, 150].map(v => `<text x="${x(v)}" y="137" text-anchor="middle">${v}</text>`).join("")}<text x="${X1}" y="${Y0 - 4}" text-anchor="end">km/h</text>
  ${solidTo > V0 ? line(V0, solidTo, "solid") + line(solidTo, V1, "dashed") : line(V0, V1, "dashed")}
  ${shown.map(p => `<circle cx="${x(p.kmh)}" cy="${y(p.per100)}" r="${(8 * Math.sqrt(p.km / most)).toFixed(1)}"/>`).join("")}
  ${speed == null ? "" : `<line class="marker" x1="${x(speed)}" y1="${Y1}" x2="${x(speed)}" y2="${Y0}"/><text class="marker" x="${Number(x(speed)) + 4}" y="${Y1 + 16}">${speed}</text>`}
</svg>`;
}

/** Every speed asked about, the recommended one tinted; a row that cannot plan says why across the rest. */
export const tripTable = (rows, speed) => `<div class="trip-table"><table>
  <tr><th>Cruise</th><th>Driving</th><th>Stops</th><th>Charging</th><th>Total</th><th>kWh</th><th>Arrive with</th></tr>
  ${rows.map(r => {
    const cruise = `<td>${r.speed.kmh} km/h${r.estimated ? ` <span class="muted">estimated</span>` : ""}</td>`;
    if (r.total == null) {
      // plan() gives up without a band to name only at the stop cap, and naming one then would blame the curve.
      return `<tr>${cruise}<td colspan="6" class="muted">${r.blocked
        ? `not plannable past ${fmt(r.blocked.from, 0)} %: no charge on record has gone through that band`
        : "no plan at this speed: the trip would need more stops than the calculator will make"}</td></tr>`;
    }
    const stops = r.stops ? `${fmt(r.stops, 0)} · to ${fmt(r.target, 0)} %` : "0";
    return `<tr${r.speed.kmh === speed ? ` class="best"` : ""}>${cruise}<td>${clock(r.driving)}</td><td>${stops}</td>
    <td>${fmt(r.charging, 0)} min</td><td>${clock(r.total)}</td><td>${fmt(r.kwh, 1)}</td><td>${fmt(r.arrival, 0)} %</td></tr>`;
  }).join("")}
</table></div>`;

/** The top of the highest curve band with a kW value: what every stop is capped to when it is under 100. */
const curveCap = curve => curve.reduce((hi, b) => b.kw != null && b.to > hi ? b.to : hi, 0);

/**
 * The right-hand column for a trip: what is wrong with the form, or the
 * recommendation, the line it rests on and the table. [trip] is the form's
 * values, a field left empty being null.
 */
export function resultHtml({ drives, curve, perPoint, calibration, trip, speedsText }) {
  const { speeds, bad } = parseSpeeds(speedsText);
  const badLine = !bad.length ? "" : `<p class="trip-bad">${esc(bad.join(", "))} ${
    bad.length === 1 ? "is not a speed" : "are not speeds"} the planner can use: ${SPEED_MIN} to ${SPEED_MAX} km/h.</p>`;
  // min and max on the inputs are the browser's advice and not a gate: a typed 150 % arrives here all the same.
  const asked = TRIP_FIELDS.filter(f => f.key !== "temp");
  const missing = asked.filter(f => !Number.isFinite(trip[f.key]));
  const outside = asked.filter(f => trip[f.key] < 0 || (f.max != null && trip[f.key] > f.max));
  const trouble = missing.length ? `Fill in ${esc(missing.map(f => f.label.toLowerCase()).join(", "))}.`
    : outside.length ? `${esc(outside.map(f => f.label.toLowerCase()).join(", "))}: ${
        outside.length === 1 ? "that is not a figure" : "those are not figures"} the car can have.`
    : !(trip.km > 0) ? "A trip of no distance needs no plan."
    : !(trip.socStart > trip.socMin) ? "The car has to set off with more charge than it is allowed to arrive on."
    : null;
  if (trouble) return `${badLine}<div class="trip-panel"><p>${trouble}</p></div>`;

  const temp = Number.isFinite(trip.temp) ? trip.temp : null;
  const model = speedModel(drives, { temp, calibration });
  const plan = { curve, perPoint, km: trip.km, socStart: trip.socStart, socMin: trip.socMin, stopMinutes: trip.stopMinutes };
  const rec = recommendSpeed(model, plan);
  const rows = planAt(tableSpeeds(speeds, rec?.speed ?? null), model, plan);
  let top;
  if (rec) {
    top = `<div class="trip-pair">${recommendHtml(rec, compareLine(rec.row, rows))}
      <div class="trip-panel"><h2>What the plan is based on</h2>${curveSvg(model, rec.speed)}
      <p class="muted">${esc(curveCaption(model, temp))}</p></div></div>`;
  } else {
    // Whatever stops one speed stops them all here, so a speed in the middle names the reason.
    const [probe] = planAt([100], model, plan);
    top = `<div class="trip-panel"><p>No speed from ${SEARCH_MIN} to ${SEARCH_MAX} km/h gets this trip there: ${probe.blocked
      ? `it would have to charge past ${fmt(probe.blocked.from, 0)} %, and no charge on record has gone through that band.`
      : "it would need more stops than the planner will make."}</p></div>`;
  }
  const cap = curveCap(curve);
  return badLine + top + (rows.length ? tripTable(rows, rec?.speed ?? null) : "") +
    (cap < 100 ? `<p class="muted">Your charging curve has no data above ${fmt(cap, 0)} %, so every stop charges to ${fmt(cap, 0)} % at most.</p>` : "") +
    `<p class="muted">Every total includes ${fmt(trip.stopMinutes, 0)} min lost at each stop and assumes a charger wherever
      the plan stops. Charging times come from your charging curve, so they are as conservative as it is.</p>`;
}

/**
 * Draws the tab into [el]. The form is written only when it is not there yet,
 * so typing redraws the results alone; without a charging curve the tab says
 * so instead of offering a planner it cannot run.
 */
export function drawTrip(el, args) {
  if (!args.curve.some(b => b.kw != null)) {
    el.innerHTML = `<p class="muted">${noCurveLine(args.drives)}</p>`;
    return;
  }
  if (!el.querySelector(".trip-form")) {
    el.innerHTML = `<div class="trip">${formHtml(args.trip, args.speedsText)}<div class="trip-right"></div></div>`;
  }
  el.querySelector(".trip-right").innerHTML = resultHtml(args);
}
