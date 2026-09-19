// What one drive says about the pack. As with the habits, nothing here judges:
// it measures, and the page compares the measurements with the limits of the
// moment. A basic log (Extended data off) has no charge, no cells and no
// temperatures - every figure it cannot know comes back null, never nought.

import { ok, usable, speedOf, powerOf, haversineKm, integrate } from "./num.js";

const STEP_MS = 10000;       // a longer gap between points is a pause, not a step to measure over
const KEEP = 50;             // moments per drive, as the habits keep them
const MERGE_MS = 5000;       // one pull written as several readings, as the habits merge one press of the pedal

/**
 * The player (index.html) owns this rule and these two constants: the BMS
 * charge moving further between two of its own readings than the energy through
 * the pack explains. They are repeated, not re-derived - a jump must read the
 * same on both pages, so a change to the player's findEvents belongs here too.
 */
export const SOC_STEP = 2;
export const POINTS_PER_KWH = 4.1;
const JUMP_MS = 120000;      // readings further apart than this are two states, not one jump

/**
 * The floors the two weak-pack measures are detected at, both wider than the
 * limits they feed (hardPullKw 40 kW, lowSocPercent 5 %), so a limit lowered
 * towards a floor still finds its stretches in a summary already stored - the
 * habits' DETECT_FLOOR, for the same reason.
 * A limit past its floor under-reports; the floors move together.
 * with a SUMMARY_VERSION bump, which rebuilds every stored drive.
 */
export const HARD_PULL_FLOOR_KW = 30, LOW_SOC_FLOOR = 10;

export const SOC_BANDS = [0, 20, 40, 60, 80];
const bandOf = soc => Math.min(SOC_BANDS.length - 1, Math.floor(soc / 20));
const LOW_CURRENT_A = 10;    // cells only sit at their resting spread when little is flowing

/**
 * The charge each point was driven at: the last reading at or before it, NaN
 * before the first. The BMS answers every fifteen seconds or so, so a step
 * almost never has a reading of its own.
 */
function carried(a, n) {
  if (!a) return null;
  const out = new Float64Array(n).fill(NaN);
  let last = NaN;
  for (let i = 0; i < n; i++) { if (ok(a[i])) last = a[i]; out[i] = last; }
  return out;
}

/** A reading a moment carries, or null where the log cannot know it. */
const reading = (a, i) => a && ok(a[i]) ? a[i] : null;

/**
 * The stretches driven under LOW_SOC_FLOOR, one per whole point of charge, each
 * with the seconds and kilometres of it: { at, seconds, km, soc, speed, lat,
 * lon }. Cut at the point of charge rather than merged across it, so summing the
 * stretches under any limit at or below the floor is exact - the same figures a
 * curve of all 101 points would give, and unlike a curve they say when and
 * where, which is what the card's moment table and its Open links are built on.
 *
 * Bucket b holds the charges from b up to b + 1, so "under 5 %" is the stretches
 * at 0 to 4 and nothing else.
 */
export function lowCharge(log) {
  const { n, t, lat, lon, cols } = log;
  const soc = carried(usable(cols.soc_percent), n);
  if (!soc) return null;
  const speed = speedOf(cols);
  const found = [];
  let open = null, pi = 0;
  for (let i = 1; i < n; i++) {
    const dt = (t[i] - t[pi]) / 1000, at = soc[pi];
    // Measured from the last step that counted, as the speed bands are: pairs of points share a timestamp,
    // and a step of no length still covered ground, which would otherwise be lost along with the step.
    if (!(dt > 0)) continue;
    // Standing about is not driving on an empty pack, and it ends the stretch: what the table shows is
    // then the second the driver was there, not one half an hour before it.
    const b = dt * 1000 <= STEP_MS && ok(at) && at < LOW_SOC_FLOOR ? Math.max(0, Math.floor(at)) : null;
    // A stretch runs while the whole point of charge holds. Any step that is not this point ends it -
    // a pause, a charge the BMS read back over the floor, or the next point down.
    if (open && b !== open.soc) open = null;
    if (b == null) { pi = i; continue; }
    if (!open) found.push(open = {
      at: t[pi], seconds: 0, km: 0, soc: b,
      speed: reading(speed, pi) ?? NaN, lat: lat[pi], lon: lon[pi],
    });
    open.seconds += dt;
    open.km += haversineKm(lat[pi], lon[pi], lat[i], lon[i]);
    pi = i;
  }
  return found.sort((a, b) => a.soc - b.soc || b.seconds - a.seconds).slice(0, KEEP);
}

/**
 * Charge jumps: the player's findEvents over one drive, worst first. The
 * unexplained points are the moment's value; the charge either side is kept so
 * the page can say what the BMS did.
 *
 * The rule is the player's, and inside one drive the two pages find the same
 * jumps - but they will not always show the same list, and neither is wrong:
 *  - The player reads a whole file; splitDrives() cuts the charges and the lone
 *    points out of it. So the player draws a jump across a charge, and across a
 *    file join, that this page never shows.
 *  - Where the energy column exists but holds no reading, usable() drops it here
 *    and the power is integrated instead; the player's truthiness test keeps the
 *    column, gets NaN, and explains nothing. This page is the one that is right.
 */
export function chargeJumps(log) {
  const { n, t, lat, lon, cols } = log;
  const soc = usable(cols.soc_percent);
  if (!soc) return null;
  const speed = speedOf(cols), power = powerOf(cols), counter = usable(cols.energy_kwh);
  const found = [];
  let first = -1;
  for (let i = 0; i < n; i++) {
    if (!ok(soc[i])) continue;
    if (first < 0) { first = i; continue; }
    if (soc[i] === soc[first]) continue;
    const delta = soc[i] - soc[first], seconds = (t[i] - t[first]) / 1000;
    const flow = counter ? counter[i] - counter[first] : power ? (f => f.out - f.back)(integrate(power, t, first, i)) : NaN;
    const explained = ok(flow) ? -flow * POINTS_PER_KWH : 0;
    if (Math.abs(delta - explained) >= SOC_STEP && seconds <= JUMP_MS / 1000) {
      found.push({
        at: t[i], value: delta - explained, speed: speed ? speed[i] : NaN, lat: lat[i], lon: lon[i],
        before: soc[first], after: soc[i], delta, explained, seconds,
      });
    }
    first = i;
  }
  return found.sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, KEEP);
}

/**
 * The stretches pulled above HARD_PULL_FLOOR_KW, hardest first, each with the
 * pack it was pulled from: { at, seconds, kw, packC, soc, speed, lat, lon }.
 * Nothing is judged weak here - the page sums the stretches that pass the
 * limits of the moment, so all three thresholds move with no re-import.
 * Either half of "weak" is enough: a log with temperatures and no charge still
 * lets the page judge the cold half, and packC or soc comes back null where the
 * log cannot know it.
 * A stretch's kW is its mean, and its seconds count whole against a
 * limit that mean passes - the moment is the unit, as a hard pull is for the
 * habits. Cut a stretch at the limit if a drive ever sits astride one.
 */
export function hardPulls(log) {
  const { n, t, lat, lon, cols } = log;
  const power = powerOf(cols), speed = speedOf(cols);
  const temp = carried(usable(cols.battery_temp_c), n), soc = carried(usable(cols.soc_percent), n);
  if (!power || (!temp && !soc)) return null;
  const found = [];
  let open = null, openAt = -Infinity;
  for (let i = 1; i < n; i++) {
    const dt = (t[i] - t[i - 1]) / 1000;
    if (!(dt > 0) || dt * 1000 > STEP_MS || !ok(power[i]) || !ok(power[i - 1])) continue;
    const kw = (power[i] + power[i - 1]) / 2;
    if (kw <= HARD_PULL_FLOOR_KW) continue;
    // The power of one pull wobbles over the floor and back: stretches close together are that one pull.
    if (!open || t[i - 1] - openAt > MERGE_MS) found.push(open = {
      at: t[i - 1], seconds: 0, kwSeconds: 0,
      packC: reading(temp, i - 1), soc: reading(soc, i - 1),
      speed: reading(speed, i - 1) ?? NaN, lat: lat[i - 1], lon: lon[i - 1],
    });
    open.seconds += dt;
    open.kwSeconds += kw * dt;
    openAt = t[i];
  }
  return found
    .map(({ kwSeconds, ...m }) => ({ ...m, kw: kwSeconds / m.seconds }))
    .sort((a, b) => b.kw - a.kw).slice(0, KEEP);
}

const median = a => {
  const v = Array.from(a).sort((x, y) => x - y), m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/**
 * One run per cell reply: the points carrying the same 96 values one after
 * another, as the player's derive() groups them, with each cell's distance from
 * that reply's median in mV. The same voltages read again later are a reading of
 * their own, not a run carried across the points between. A reply of another
 * length is a different pack and is left out - measured against the commonest
 * length, not the first reply's: a truncated CAN response or an empty
 * <ev:cells_v></ev:cells_v> (one cell, from gpx.js) at the head of a drive would
 * otherwise throw away all 96-cell replies behind it and leave a one-cell pack.
 */
function cellRuns(log) {
  const { n, cells } = log, runs = [];
  if (!cells) return runs;
  for (let i = 0; i < n; i++) {
    const c = cells[i];
    if (!c) continue;
    const last = runs[runs.length - 1];
    if (last && last.cells === c && last.end === i - 1) { last.end = i; continue; }
    const med = median(c);
    runs.push({ i, end: i, cells: c, dev: Array.from(c, v => (v - med) * 1000) });
  }
  const counts = new Map();
  for (const r of runs) counts.set(r.cells.length, (counts.get(r.cells.length) ?? 0) + 1);
  // As many replies as possible, and the longer pack where two lengths came equally often.
  const [commonest] = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0] ?? [];
  return runs.filter(r => r.cells.length === commonest);
}

/**
 * The mean mV each cell sat from the pack median over the drive, cell 1 first,
 * as a plain array so any one of the 96 can be followed over the months. Every
 * reply weighs the same, however long the car repeated it.
 */
export function cellMeans(log) {
  const runs = cellRuns(log);
  if (!runs.length) return null;
  const sum = new Array(runs[0].cells.length).fill(0);
  for (const r of runs) r.dev.forEach((v, k) => { sum[k] += v; });
  return { mv: sum.map(v => v / runs.length), readings: runs.length };
}

/**
 * The spread between the highest and lowest cell, in mV, by charge band. Only
 * readings taken at low current count, and only against their own band: a pack
 * under load and a pack at 20 % both spread wider, which says nothing about a
 * cell going bad.
 */
export function cellSpread(log) {
  const { cols } = log;
  const current = usable(cols.current_a), soc = carried(usable(cols.soc_percent), log.n);
  const runs = cellRuns(log);
  if (!runs.length || !current || !soc) return null;
  const bands = SOC_BANDS.map(() => ({ mv: null, readings: 0 }));
  const sum = SOC_BANDS.map(() => 0);
  for (const r of runs) {
    if (!ok(current[r.i]) || Math.abs(current[r.i]) >= LOW_CURRENT_A || !ok(soc[r.i])) continue;
    const b = bandOf(Math.max(0, Math.min(100, soc[r.i])));
    sum[b] += Math.max(...r.cells) - Math.min(...r.cells);
    bands[b].readings++;
  }
  bands.forEach((band, b) => { if (band.readings) band.mv = sum[b] / band.readings * 1000; });
  return bands;
}

/**
 * The car's own events, counted by the type it wrote on them. The type comes out
 * of somebody's file, so the counts have no prototype: an event of type
 * __proto__ would otherwise set no own property and go uncounted.
 */
export function eventCounts(log) {
  const counts = Object.create(null);
  for (const e of log.carEvents ?? []) if (e.type) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return counts;
}

/**
 * Everything one drive says about the pack.
 * A measure records at most 50 moments per drive, matching the habits cap.
 * raise KEEP if a drive ever reaches it.
 */
export function measureBattery(log) {
  return {
    lowCharge: lowCharge(log),
    jumps: chargeJumps(log),
    hardPulls: hardPulls(log),
    cells: cellMeans(log),
    cellSpread: cellSpread(log),
    carEvents: eventCounts(log),
  };
}
