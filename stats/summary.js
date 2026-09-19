import { ok, usable, speedOf, powerOf, firstValid, lastValid, haversineKm, integrate } from "./num.js";
import { measureHabits } from "./habits.js";
import { measureBattery } from "./battery.js";
import { measureEpisodes } from "./episodes.js";
import { calibrationKey } from "./settings.js";

/** Raise when a field is added or changes meaning: stored summaries are then rebuilt from their files. */
export const SUMMARY_VERSION = 6;

const nul = v => ok(v) ? v : null;

/** One drive's figures, from a drive (splitDrives) whose counters continueCounters() has carried over restarts. */
export function summarize(log, { id, fileId, file, calibration }) {
  const { n, lat, lon, t, cols } = log;
  const last = n - 1;
  const first = a => a ? nul(firstValid(a, 0, last)) : null;
  const final = a => a ? nul(lastValid(a, 0, last)) : null;
  const lowest = a => { let m = NaN; if (a) for (const v of a) if (ok(v) && !(v >= m)) m = v; return nul(m); };
  const mean = a => { let sum = 0, c = 0; if (a) for (const v of a) if (ok(v)) { sum += v; c++; } return c ? sum / c : null; };
  const share = a => { let on = 0, c = 0; if (a) for (const v of a) if (ok(v)) { c++; if (v >= 1) on++; } return c ? on / c : null; };

  const speed = speedOf(cols);
  const hourSeconds = new Array(24).fill(0);
  let km = 0, moving = 0;
  for (let i = 1; i < n; i++) {
    km += haversineKm(lat[i - 1], lon[i - 1], lat[i], lon[i]);
    const dt = t[i] - t[i - 1];
    // The player's rule for moving time: faster than 2 km/h, no gap of 30 s or more.
    if (speed && speed[i] > 2 && dt < 30000) {
      moving += dt / 1000;
      hourSeconds[new Date(t[i]).getHours()] += dt / 1000;
    }
  }

  // The same readings the habits are measured from, so one drive never reads two ways in one record.
  const power = powerOf(cols);
  const flow = power ? integrate(power, t, 0, last) : null;
  const e = usable(cols.energy_kwh), r = usable(cols.energy_regen_kwh);
  const span = a => lastValid(a, 0, last) - firstValid(a, 0, last);
  // The app's own counters where it wrote them, power over time otherwise - as the player does.
  const energy = e ? span(e) : flow ? flow.out - flow.back : NaN;
  const regen = r ? span(r) : flow ? flow.back : NaN;
  const out = e && r ? energy + regen : flow ? flow.out : NaN;
  const start = firstValid(t, 0, last), end = lastValid(t, 0, last);

  return {
    version: SUMMARY_VERSION, calibration: calibrationKey(calibration), id, fileId, file, vehicle: log.vehicle, points: n,
    start, end, seconds: (end - start) / 1000, moving, km,
    startLat: lat[0], startLon: lon[0], endLat: lat[last], endLon: lon[last],
    socStart: first(cols.soc_percent), socEnd: final(cols.soc_percent), socMin: lowest(cols.soc_percent),
    energy: nul(energy), out: nul(out), regen: nul(regen),
    per100: km > 0.05 && ok(energy) ? energy / km * 100 : null,
    outsideTemp: mean(cols.outside_temp_c), packTempStart: first(cols.battery_temp_c), packTempEnd: final(cols.battery_temp_c),
    acShare: share(cols.aircon), aux12vStart: first(cols.aux_12v_v), soh: final(cols.soh_percent), hourSeconds,
    habits: measureHabits(log, calibration),
    battery: measureBattery(log),
    episodes: measureEpisodes(log, calibration),
  };
}

/** Every stored drive [s] shares time with - the same driving written twice, often one long trip log over several live logs. */
export const overlapping = (summaries, s) => summaries.filter(o => o.id !== s.id && o.start < s.end && s.start < o.end);

/** Above 0 when [a] is the copy of a drive to keep over [b]: readings from the car beat GPS alone, then more points win. */
export const fuller = (a, b) =>
  (a.energy != null) - (b.energy != null) || (a.socStart != null) - (b.socStart != null) || a.points - b.points;

/**
 * The drives the statistics count: of copies of the same driving, the fullest.
 * Every copy stays stored, so the outcome never depends on the order files
 * were added in, and deleting a drive lets its next-best copy show.
 * O(n²) over drives; acceptable for a few thousand.
 */
export function visible(summaries) {
  const kept = [];
  const order = (a, b) => fuller(b, a) || a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const s of [...summaries].sort(order)) if (!overlapping(kept, s).length) kept.push(s);
  return kept;
}

/** A drive the statistics can place in time and on the road - a GPX without times or positions cannot be. */
export const readable = s => [s.start, s.end, s.km].every(Number.isFinite);
