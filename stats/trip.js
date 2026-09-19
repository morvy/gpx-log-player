// The trip planner's arithmetic: what the car uses at any speed, fitted to the
// driver's own speed bands, and the speed that gets a trip there soonest. The
// charging itself is stats/charges.js; this only decides which speeds to ask it about.

import { bandUse, tripPlan, TRIP_BAND_KM } from "./charges.js";
import { withCalibration } from "./settings.js";
import { fmt } from "./coach-view.js";

export const TEMP_NEAR = 5;                       // °C either side of the day being planned for
export const SPEED_MIN = 40, SPEED_MAX = 160;     // what a typed speed may be
export const SEARCH_MIN = 60, SEARCH_MAX = 150;   // where the recommendation is looked for
export const AUX_KW = 0.5;                        // heating and electronics, on top of the road
const MODEL_FROM = 50;       // bands below this are town driving: stop and go, not a cruise speed
export const ESTIMATE_AFTER = 15;   // km/h past the fastest band the driving still vouches for the line
const TIE_MINUTES = 1;       // a minute is not worth the energy it costs to win

/** The bands that say something about a speed: fast enough, driven enough, and costing something. */
const pointsOf = list => bandUse(list)
  .filter(b => b.from >= MODEL_FROM && b.km >= TRIP_BAND_KM && b.kmh != null && b.per100 > 0)
  .map(b => ({ kmh: b.kmh, per100: b.per100, km: b.km }));

/**
 * per100 = a + b·v², weighted by km, so a band driven 300 km outweighs one
 * driven 20. Rolling resistance is the constant and the air the square; a
 * line through two or more speeds is all the data can bear.
 */
function fit(points) {
  if (points.length < 2) return null;
  let w = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of points) {
    const x = p.kmh * p.kmh;
    w += p.km; sx += p.km * x; sy += p.km * p.per100; sxx += p.km * x * x; sxy += p.km * x * p.per100;
  }
  const det = w * sxx - sx * sx;
  // Every point at one speed: no slope to find. Relative to the sums, so rounding does not pass for a spread.
  if (!(det > 1e-9 * w * sxx)) return null;
  const b = (w * sxy - sx * sy) / det;
  const a = (sy - b * sx) / w;
  // Faster costing less, or a road that pays the car back at walking pace, is noise and not physics.
  return b > 0 && a >= 0 ? { a, b } : null;
}

/** The calibration's car on a flat road, per 100 km: what the planner says when the driving cannot. */
function physics(calibration) {
  const c = withCalibration(calibration);
  return v => {
    const u = v / 3.6;
    const kw = (0.5 * c.airDensity * c.cdaM2 * u ** 3 + c.massKg * 9.80665 * c.rolling * u) / 1000 / c.regenEfficiency + AUX_KW;
    return kw / v * 100;
  };
}

/**
 * kWh/100 km at any speed. Driving in weather like the day asked about is used
 * when at least two bands of it say something and fit; then all the driving;
 * then the physics settings. [points] are the ones shown, whichever answered.
 */
export function speedModel(list, { temp = null, calibration } = {}) {
  const all = pointsOf(list);
  const near = Number.isFinite(temp)
    ? pointsOf(list.filter(s => s.outsideTemp != null && Math.abs(s.outsideTemp - temp) <= TEMP_NEAR)) : [];
  const warm = near.length >= 2;
  const span = points => ({
    from: points.length ? Math.min(...points.map(p => p.kmh)) : null,
    to: points.length ? Math.max(...points.map(p => p.kmh)) : null,
    points,
  });
  for (const [points, atTemp] of warm ? [[near, true], [all, false]] : [[all, false]]) {
    const got = fit(points);
    if (got) return { per100: v => got.a + got.b * v * v, a: got.a, b: got.b, source: "fit", atTemp, ...span(points) };
  }
  return { per100: physics(calibration), a: null, b: null, source: "physics", atTemp: warm, ...span(warm ? near : all) };
}

/** A speed the driving does not vouch for: the physics answered, or it is well past the fastest band. */
export const estimated = (model, v) => model.source === "physics" || v > model.to + ESTIMATE_AFTER;

/**
 * The speeds typed, as whole km/h, once each and slowest first. Anything that
 * is not a plain number in range is handed back as typed, so the page can
 * name it rather than quietly drop it.
 */
export function parseSpeeds(text) {
  const speeds = new Set(), bad = [];
  for (const piece of String(text ?? "").split(/[\s,]+/).filter(Boolean)) {
    const v = /^\d+(\.\d+)?$/.test(piece) ? Number(piece) : NaN;
    if (v >= SPEED_MIN && v <= SPEED_MAX) speeds.add(Math.round(v));
    else bad.push(piece);
  }
  return { speeds: [...speeds].sort((a, b) => a - b), bad };
}

/** [trip] is { curve, perPoint, km, socStart, socMin, stopMinutes }; each row is tripPlan()'s, marked when estimated. */
export const planAt = (speeds, model, trip) =>
  tripPlan({ ...trip, speeds: speeds.map(v => ({ kmh: v, per100: model.per100(v) })) })
    .map(row => ({ ...row, estimated: estimated(model, row.speed.kmh) }));

/** Nobody holds 103 km/h on purpose; 97 → 95, 99 → 100, 102.5 → 105. */
export const round5 = v => Math.round(v / 5) * 5;

/**
 * The speed with the soonest arrival, searched a km/h at a time and then
 * rounded to one a driver can hold. Among totals within a minute of the best
 * the slowest wins: it uses less and arrives as good as together.
 * Search only multiples of 5; do not round after the search.
 * rounding before checking other speeds could cross a charging-stop threshold.
 */
export function recommendSpeed(model, trip) {
  const speeds = [];
  for (let v = SEARCH_MIN; v <= SEARCH_MAX; v++) speeds.push(v);
  const rows = planAt(speeds, model, trip).filter(r => r.total != null);
  if (!rows.length) return null;
  const least = Math.min(...rows.map(r => r.total));
  const found = rows.find(r => r.total <= least + TIE_MINUTES).speed.kmh;
  // speed: among multiples of 5, the one with smallest total; within 1 minute of smallest, slowest wins
  const roundSpeeds = rows.filter(r => r.speed.kmh % 5 === 0);
  if (!roundSpeeds.length) return null;
  const leastRound = Math.min(...roundSpeeds.map(r => r.total));
  const speed = roundSpeeds.filter(r => r.total <= leastRound + TIE_MINUTES)
    .reduce((min, r) => r.speed.kmh < min.speed.kmh ? r : min).speed.kmh;
  const row = rows.find(r => r.speed.kmh === speed);
  return { found, speed, row };
}

/** The table's speeds: the typed ones, and the recommended one when it was not typed, slowest first. */
export const tableSpeeds = (typed, speed) => [...new Set(speed == null ? typed : [...typed, speed])].sort((a, b) => a - b);

/**
 * The recommended row against the fastest other row that plans, which is the
 * speed a driver is most tempted by: "vs 130 km/h: 9 min sooner, 1 stop fewer, 14.2 kWh less".
 */
export function compareLine(best, rows) {
  const other = best && rows
    .filter(r => r.total != null && r.speed.kmh !== best.speed.kmh)
    .reduce((x, r) => !x || r.speed.kmh > x.speed.kmh ? r : x, null);
  if (!other) return null;
  const minutes = Math.round(other.total - best.total);
  const stops = best.stops - other.stops;
  const kwh = best.kwh - other.kwh;
  const n = Math.abs(stops);
  return `vs ${other.speed.kmh} km/h: ` +
    (minutes ? `${Math.abs(minutes)} min ${minutes > 0 ? "sooner" : "later"}` : "the same time") + ", " +
    (stops ? `${n} stop${n === 1 ? "" : "s"} ${stops < 0 ? "fewer" : "more"}` : "the same number of stops") + ", " +
    `${fmt(Math.abs(kwh), 1)} kWh ${kwh > 0 ? "more" : "less"}`;
}
