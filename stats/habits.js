// What one drive says about the driving. Nothing here judges: it measures, and
// the page compares the measurements with the limits of the moment, so lowering
// a limit re-judges every stored drive without reading a single file again.

import { ok, usable, speedOf, powerOf, haversineKm, integrate } from "./num.js";
import { withCalibration } from "./settings.js";

const G = 9.80665;

/**
 * Below both defaults (2.5 and 3.0 m/s²), so a lowered limit still finds its
 * events in a stored summary. It must stay above 10 km/h over the window
 * (0.93 m/s²): under that, creeping in a queue starts counting as driving, and
 * the rule that would have caught it is gone - see hardMoments() below.
 */
export const DETECT_FLOOR = 1.5;
const GLITCH = 5;            // m/s² - past what the car can do: a one-second speed spike, not driving
const WINDOW_MS = 3000;
const WINDOW_SLACK = 1500;   // a window stretched across a gap in the points measures nothing real
const MERGE_MS = 5000;       // one press of the pedal, written as several readings
const KEEP = 50;             // per habit per drive
const FULL_POWER_KW = 60;
const FALLING_MS = 3000;     // a stretch where the speed fell long enough to be braking, not noise
const MOTORWAY_KMH = 90, MOTORWAY_MS = 60000;
const SHORT_WINDOW_MS = 10000;   // how far under a minute a window may fall before it says too little
const STEP_MS = 10000;       // a longer gap between points is a pause, not a step to integrate over

export const SPEED_BANDS = [0, 30, 50, 70, 90, 110, 130];
const bandOf = kmh => { let b = 0; while (b + 1 < SPEED_BANDS.length && kmh >= SPEED_BANDS[b + 1]) b++; return b; };

/** Maximal runs of points where [holds] is true of the step into the point, at least [leastMs] long. */
function runs(t, n, holds, leastMs) {
  const out = [];
  let from = -1;
  for (let i = 1; i < n; i++) {
    if (t[i] - t[i - 1] <= STEP_MS && holds(i)) { if (from < 0) from = i - 1; continue; }
    if (from >= 0 && t[i - 1] - t[from] >= leastMs) out.push([from, i - 1]);
    from = -1;
  }
  if (from >= 0 && t[n - 1] - t[from] >= leastMs) out.push([from, n - 1]);
  return out;
}

/**
 * Speed changes of at least DETECT_FLOOR over a 3 s window, the worst of each
 * press kept. A window is measured between two points about 3 s apart rather
 * than over a fixed count, because a log's points are one to two seconds apart.
 * "Only above 10 km/h" needs no rule of its own: over three seconds a
 * change that stays under 10 km/h is under 1 m/s², well below the floor, so
 * creeping in a queue can never be reported however slowly the car crawls.
 */
export function hardMoments(log) {
  const { n, t, lat, lon, cols } = log;
  const speed = speedOf(cols);
  if (!speed) return { hardAccel: [], hardBrake: [] };
  const found = [];
  for (let i = 1, j = 0; i < n; i++) {
    if (!ok(speed[i])) continue;
    while (j + 1 < i && t[i] - t[j + 1] >= WINDOW_MS) j++;
    const span = t[i] - t[j];
    if (span < WINDOW_MS || span > WINDOW_MS + WINDOW_SLACK || !ok(speed[j])) continue;
    const value = (speed[i] - speed[j]) / 3.6 / (span / 1000);
    if (Math.abs(value) < DETECT_FLOOR || Math.abs(value) > GLITCH) continue;
    found.push({ at: t[i], value, speed: speed[i], lat: lat[i], lon: lon[i] });
  }
  // One press written as several windows. The gap is measured from the window before, not from the worst
  // one kept: a pull whose rate tapers off - the shape of every real launch - would otherwise start a new
  // event every 5 s and count one pull three times.
  const merged = [];
  let previous = null;
  for (const e of found) {
    const last = merged[merged.length - 1];
    if (previous && Math.sign(previous.value) === Math.sign(e.value) && e.at - previous.at < MERGE_MS) {
      if (Math.abs(e.value) > Math.abs(last.value)) merged[merged.length - 1] = e;
    } else merged.push(e);
    previous = e;
  }
  const worstFirst = sign => merged.filter(e => Math.sign(e.value) === sign)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, KEEP);
  return { hardAccel: worstFirst(1), hardBrake: worstFirst(-1) };
}

/**
 * The movement energy (J) a stretch of points gives up that a perfect car could
 * have taken back: what the speed and the height lost hold, less what the air
 * and the tyres took anyway.
 */
function recoverable(log, speed, from, to, cal) {
  const { t, cols } = log, ele = usable(cols.ele);
  const ms = i => speed[i] / 3.6;
  let drag = 0;
  for (let i = from + 1; i <= to; i++) {
    const dt = (t[i] - t[i - 1]) / 1000;
    if (!(dt > 0) || dt * 1000 > STEP_MS || !ok(speed[i]) || !ok(speed[i - 1])) continue;
    const v = (ms(i) + ms(i - 1)) / 2;
    drag += (0.5 * cal.airDensity * cal.cdaM2 * v ** 3 + cal.massKg * G * cal.rolling * v) * dt;
  }
  const kinetic = 0.5 * cal.massKg * (ms(from) ** 2 - ms(to) ** 2);
  const potential = ok(ele?.[from]) && ok(ele?.[to]) ? cal.massKg * G * (ele[from] - ele[to]) : 0;
  return kinetic + potential - drag;
}

/**
 * One brake-pedal stretch: the energy a perfect car could have taken back, and
 * the part of it that went into the pads - what came back through the motor,
 * taken at the pack, is worth more at the wheels by the regen efficiency.
 */
export function pressLoss(log, speed, power, from, to, cal) {
  const could = Math.max(0, recoverable(log, speed, from, to, cal));
  const back = integrate(power, log.t, from, to).back * 3.6e6;   // kWh into the pack, as joules
  return { could, lost: Math.max(0, could - back / cal.regenEfficiency) };
}

/**
 * The share of the recoverable energy that went into the pads as heat: per
 * brake-pedal stretch, what the car gave up less what came back through the
 * motor, against the recoverable energy of every stretch where the speed fell
 * for 3 s or more, pedal or not. An estimate - the calibration is a guess at
 * this car, not a measurement of it.
 */
export function brakeLoss(log, cal) {
  const { n, t, lat, lon, cols } = log;
  const speed = speedOf(cols), power = powerOf(cols), pedal = usable(cols.brake_pedal);
  // Without the pedal there are no stretches to blame, and without power the regen taken back is unknown.
  if (!speed || !power || !pedal) return null;
  // A press is measured from the last point before the pedal went down - the speed it started from - to the
  // last point holding it; both readings are of the same instant, and the braking happened between them.
  const presses = runs(t, n, i => pedal[i] >= 1, 0).filter(([from, to]) => to > from && ok(speed[from]) && ok(speed[to]));
  let kwh = 0, denominator = 0;
  const moments = [];
  for (const [from, to] of presses) {
    const { could, lost } = pressLoss(log, speed, power, from, to, cal);
    denominator += could;
    if (!(lost > 0)) continue;
    kwh += lost / 3.6e6;
    moments.push({ at: t[from], value: speed[from] - speed[to], speed: speed[from], lat: lat[from], lon: lon[from], kwh: lost / 3.6e6 });
  }
  // Every press is in the denominator through itself, so a stab of the pedal shorter than three seconds
  // can no longer add heat the share has nothing to divide by, and the share cannot pass 100 %. Slowing
  // with no pedal - lifting off, letting the motor do it - is what the falling stretches add.
  // A falling stretch a press only touches is dropped whole rather than cut.
  // denominator a little small; cut it at the press if a log ever shows that mattering.
  for (const [from, to] of runs(t, n, i => ok(speed[i]) && ok(speed[i - 1]) && speed[i] < speed[i - 1], FALLING_MS)) {
    if (presses.some(([a, b]) => a <= to && from <= b)) continue;
    denominator += Math.max(0, recoverable(log, speed, from, to, cal));
  }
  return {
    kwh, recoverableKwh: denominator / 3.6e6,
    share: denominator > 0 ? kwh / (denominator / 3.6e6) : null,
    moments: moments.sort((a, b) => b.kwh - a.kwh).slice(0, KEEP),
  };
}

/**
 * Distance, time and net energy by speed band, so a period can add them up and
 * the trip calculator can read them.
 *
 * Measured from the last step that counted rather than from the point before,
 * as integrate() does: the app writes points faster than its clock of whole
 * seconds ticks, so pairs of points share a timestamp. A step of no length
 * covered real ground all the same, and dropping it would drop that ground
 * while the next step measured two seconds of clock against one of movement -
 * which took a tenth off every band's distance and put the 70-90 band's mean
 * speed at 64 km/h, under its own floor.
 *
 * energyKm is the distance of the steps the energy was measured over, so a band
 * whose power column is mostly blank says so instead of reading as a car that
 * got round for nothing.
 */
export function speedBands(log) {
  const { n, t, lat, lon, cols } = log;
  const speed = speedOf(cols), power = powerOf(cols);
  const bands = SPEED_BANDS.map(() => ({ seconds: 0, km: 0, energy: power ? 0 : null, energyKm: 0 }));
  if (!speed) return bands;
  let pi = 0;
  for (let i = 1; i < n; i++) {
    const dt = (t[i] - t[pi]) / 1000;
    // A step this cannot measure still covered ground, so it rolls into the next one. Only a gap long
    // enough to be a pause breaks the carry: nothing crossed during a pause belongs to a band.
    if (!(dt > 0) || dt * 1000 > STEP_MS || !ok(speed[i]) || !ok(speed[pi])) {
      if (t[i] - t[pi] >= STEP_MS) pi = i;
      continue;
    }
    const band = bands[bandOf((speed[i] + speed[pi]) / 2)];
    const km = haversineKm(lat[pi], lon[pi], lat[i], lon[i]);
    band.seconds += dt;
    band.km += km;
    if (power && ok(power[i]) && ok(power[pi])) {
      band.energy += (power[i] + power[pi]) / 2 * dt / 3600;
      band.energyKm += km;
    }
    pi = i;
  }
  return bands;
}

const spread = (a, from, to) => {
  let sum = 0, sq = 0, c = 0;
  for (let i = from; i <= to; i++) if (ok(a[i])) { sum += a[i]; sq += a[i] * a[i]; c++; }
  return c < 2 ? null : Math.sqrt(Math.max(0, sq / c - (sum / c) ** 2));
};

/**
 * The spread of [a] over each minute inside a stretch, averaged. Measured over
 * the whole stretch instead, the figure would grow with the length of the road:
 * on the logs of 2026-09-13 a half-hour motorway run scored 6.9 km/h and a
 * six-minute one 4.2, which says where the driver went, not how they drove.
 * Over a rolling minute the same two are 3.2 and 3.6.
 */
function rollingSpread(t, a, from, to) {
  let sum = 0, count = 0;
  for (let b = from, s = from; b <= to; b++) {
    while (t[b] - t[s] > MOTORWAY_MS) s++;
    if (t[b] - t[s] < MOTORWAY_MS - SHORT_WINDOW_MS) continue;   // the windows at the very start are not a minute yet
    const sd = spread(a, s, b);
    if (sd != null) { sum += sd; count++; }
  }
  return count ? sum / count : null;
}

/**
 * How steadily the car was held on the motorway: the spread of speed and of
 * power over each minute of a stretch above 90 km/h, weighted by their
 * length so a period can weight drives the same way.
 */
export function motorway(log) {
  const { n, t, cols } = log;
  const speed = speedOf(cols), power = powerOf(cols);
  if (!speed) return null;
  let seconds = 0, speedSum = 0, powerSum = 0, powerSeconds = 0;
  for (const [from, to] of runs(t, n, i => speed[i] > MOTORWAY_KMH && speed[i - 1] > MOTORWAY_KMH, MOTORWAY_MS)) {
    const length = (t[to] - t[from]) / 1000, sd = rollingSpread(t, speed, from, to);
    if (sd == null) continue;
    seconds += length;
    speedSum += sd * length;
    const ps = power && rollingSpread(t, power, from, to);
    if (ps != null) { powerSum += ps * length; powerSeconds += length; }
  }
  if (!seconds) return null;
  return {
    seconds, speedSpread: speedSum / seconds,
    powerSpread: powerSeconds ? powerSum / powerSeconds : null, powerSeconds,
  };
}

/** Seconds with more than 60 kW leaving the pack. */
export function fullPower(log) {
  const { n, t, cols } = log;
  const power = powerOf(cols);
  if (!power) return null;
  let seconds = 0;
  for (let i = 1; i < n; i++) {
    const dt = (t[i] - t[i - 1]) / 1000;
    if (!(dt > 0) || dt * 1000 > STEP_MS || !ok(power[i]) || !ok(power[i - 1])) continue;
    if ((power[i] + power[i - 1]) / 2 > FULL_POWER_KW) seconds += dt;
  }
  return seconds;
}

/**
 * Every habit of one drive, measured. A basic log (Extended data off) has no
 * power and no pedal: those habits come back null rather than nought, so the
 * page can say it does not know instead of saying the driving was perfect.
 * A habit records at most 50 moments per drive, so a period's count is exact.
 * only while no drive went past 50 - raise KEEP if a drive ever does.
 */
export function measureHabits(log, calibration) {
  const cal = withCalibration(calibration);
  return {
    ...hardMoments(log),
    brakeLoss: brakeLoss(log, cal),
    fullPowerSeconds: fullPower(log),
    bands: speedBands(log),
    motorway: motorway(log),
  };
}
