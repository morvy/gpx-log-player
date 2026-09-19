// Every speed-up and slow-down of one drive, measured so the coach can put like
// beside like - a 0→50 pull-away beside other 0→50 pull-aways. Nothing here
// judges: stats/coach.js does, when the page draws.

import { ok, usable, speedOf, powerOf, integrate } from "./num.js";
import { pressLoss } from "./habits.js";
import { withCalibration } from "./settings.js";

const STEP_MS = 10000;       // habits.js's gap rule: a longer gap between points is a pause, and ends an episode
const FLAT_KMH = 2;          // a change this small is wobble in the reading, not the pedal
const FLAT_MS = 3000;        // a speed held this long ends a rise or a fall
const LEAST_CHANGE = 10;     // km/h - under this it is creeping in a queue, not an episode
const LEAST_RISE_MS = 3000;
const HOLD_KMH = 5;
const STOPPED_KMH = 3;
const STOP_AHEAD_MS = 15000;  // a fall that ends in a creep still counts as a stop if the car is standing this soon after

export const UP_FIELDS = ["v0", "v1", "seconds", "kwh", "peakKw", "accel", "holdSeconds"];
export const DOWN_FIELDS = ["v0", "v1", "toStop", "seconds", "braked", "liftSeconds", "regenKwh", "brakeKwh", "recoveredShare"];

const round = (v, places) => v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** places) / 10 ** places;

/**
 * The rises and falls of the speed, as [direction, from, to]: a turn needs the
 * speed to go back more than FLAT_KMH, and a speed held for FLAT_MS ends a run
 * where it first got there. A rise starts at the latest low before it and a
 * fall at the latest high, so a wait at the lights does not count as pulling
 * away. A gap in the points ends whatever was running.
 */
export function turns(t, speed, n) {
  const out = [];
  let dir = 0, from = -1, ext = -1, lo = -1, hi = -1, prev = -1;
  const close = () => { if (dir && ext > from) out.push([dir, from, ext]); };
  for (let i = 0; i < n; i++) {
    if (!ok(speed[i])) continue;
    if (prev >= 0 && t[i] - t[prev] > STEP_MS) { close(); dir = 0; lo = hi = -1; }
    prev = i;
    const v = speed[i];
    if (dir === 0) {
      if (lo < 0) { lo = hi = i; continue; }
      if (v <= speed[lo]) lo = i;
      if (v >= speed[hi]) hi = i;
      if (v - speed[lo] > FLAT_KMH) { dir = 1; from = lo; ext = i; }
      else if (speed[hi] - v > FLAT_KMH) { dir = -1; from = hi; ext = i; }
      continue;
    }
    if (dir * (v - speed[ext]) > 0) { ext = i; continue; }
    if (dir * (speed[ext] - v) > FLAT_KMH) { close(); dir = -dir; from = ext; ext = i; continue; }
    if (t[i] - t[ext] >= FLAT_MS) { close(); dir = 0; lo = hi = ext; }
  }
  close();
  return out;
}

/**
 * Whether the fall ending at [to] ends in a stop: standing there, or standing within
 * STOP_AHEAD_MS without the speed picking up by more than FLAT_KMH first. A fall
 * ends once the speed is flat for FLAT_MS, so a stop that finishes in a slow creep
 * would otherwise end at walking pace and never count.
 * The track writes a point only once the car has moved a few metres, so a standing
 * car leaves a gap, or the log just ends. After a creep, that silence is a stop;
 * after anything faster it is lost signal.
 */
function endsInStop(t, speed, n, to) {
  if (speed[to] <= STOPPED_KMH) return true;
  let prev = to;
  for (let i = to + 1; i < n; i++) {
    if (!ok(speed[i])) continue;
    if (t[i] - t[prev] > STEP_MS) break;
    if (t[i] - t[to] > STOP_AHEAD_MS || speed[i] > speed[to] + FLAT_KMH) return false;
    if (speed[i] <= STOPPED_KMH) return true;
    prev = i;
  }
  return speed[prev] <= LEAST_CHANGE;
}

/**
 * One drive's episodes as columns of numbers - a drive has hundreds, and a
 * column of numbers stores far smaller than an object per episode. A log
 * without power cannot say what an episode cost, so it has none; a log without
 * the brake pedal keeps its slow-downs with the pedal figures unknown.
 */
export function measureEpisodes(log, calibration) {
  const { n, t, cols } = log;
  const speed = speedOf(cols), power = powerOf(cols);
  if (!speed || !power) return null;
  const pedal = usable(cols.brake_pedal);
  const cal = withCalibration(calibration);
  const up = Object.fromEntries(UP_FIELDS.map(k => [k, []]));
  const down = Object.fromEntries(DOWN_FIELDS.map(k => [k, []]));
  const push = (into, row) => { for (const k in into) into[k].push(row[k]); };
  const net = (a, b) => { const f = integrate(power, t, a, b); return f.out - f.back; };

  for (const [dir, from, to] of turns(t, speed, n)) {
    if (dir > 0) {
      const seconds = (t[to] - t[from]) / 1000;
      if (speed[to] - speed[from] < LEAST_CHANGE || seconds * 1000 < LEAST_RISE_MS) continue;
      let peak = -Infinity;
      for (let i = from; i <= to; i++) if (ok(power[i]) && power[i] > peak) peak = power[i];
      // The hold: as long as the speed stays near where the pull ended. Only timed, not costed - most holds
      // are a few seconds, and their energy runs into whatever comes next (often the next slow-down's regen).
      let end = to;
      for (let i = to + 1; i < n; i++) {
        if (!ok(speed[i])) continue;
        if (t[i] - t[end] > STEP_MS || Math.abs(speed[i] - speed[to]) > HOLD_KMH) break;
        end = i;
      }
      push(up, {
        v0: round(speed[from], 0), v1: round(speed[to], 0), seconds: round(seconds, 1),
        kwh: round(net(from, to), 3), peakKw: round(peak, 0),
        accel: round((speed[to] - speed[from]) / 3.6 / seconds, 2),
        holdSeconds: round((t[end] - t[to]) / 1000, 1),
      });
      continue;
    }
    let brake = -1;
    if (pedal) for (let i = from; i <= to; i++) if (pedal[i] >= 1) { brake = i; break; }
    // Lift-off is the end of the leading run of positive power starting at from, not the last such
    // moment anywhere in the fall - a throttle burst once the car is already coasting or braking does
    // not move it forward. Walk from from to last (the pedal press, or the trough), skipping readings
    // that are missing; the first readable reading at or below zero ends the run, and lift stays at
    // from if nothing positive turns up before then. A fall that stays under power the whole way down
    // (a hill, say) ends with lift near the trough and is excluded below just the same - that's intended.
    const last = brake >= 0 ? brake : to;
    let lift = from;
    for (let i = from; i <= last; i++) {
      if (!ok(power[i])) continue;
      if (power[i] <= 0) break;
      lift = i;
    }
    if (speed[lift] - speed[to] < LEAST_CHANGE) continue;
    const regen = integrate(power, t, lift, to).back;
    let brakeKwh = null;
    if (pedal) {
      // Presses as brakeLoss() reads them: from the last point before the pedal went down to the last holding it.
      let joules = 0;
      for (let i = lift + 1, a = -1; i <= to + 1; i++) {
        const on = i <= to && pedal[i] >= 1 && t[i] - t[i - 1] <= STEP_MS;
        if (on && a < 0) a = i - 1;
        if (!on && a >= 0) {
          if (ok(speed[a]) && ok(speed[i - 1])) joules += pressLoss(log, speed, power, a, i - 1, cal).lost;
          a = -1;
        }
      }
      brakeKwh = joules / 3.6e6;
    }
    // Brake loss is energy at the wheels; the pack could have had it only through the motor's efficiency.
    const could = brakeKwh == null ? 0 : regen + brakeKwh * cal.regenEfficiency;
    push(down, {
      v0: round(speed[lift], 0), v1: round(speed[to], 0), toStop: endsInStop(t, speed, n, to) ? 1 : 0,
      seconds: round((t[to] - t[lift]) / 1000, 1),
      // Lift-off time is to the first press; a slow-down without one has none, rather than its whole length.
      braked: pedal ? (brake >= 0 ? 1 : 0) : null,
      liftSeconds: pedal && brake >= 0 ? round((t[brake] - t[lift]) / 1000, 1) : null,
      regenKwh: round(regen, 3), brakeKwh: round(brakeKwh, 3),
      recoveredShare: could > 0 ? round(regen / could, 3) : null,
    });
  }
  return { up, down };
}
