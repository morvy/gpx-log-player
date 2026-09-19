// The coach: a period's episodes put beside episodes like them, the driver's own
// best as the target, and what closing the gap is worth. Pure functions over
// stored summaries - the page does the drawing.

import { CALIBRATION, USABLE_KWH } from "./settings.js";
import { UP_FIELDS, DOWN_FIELDS } from "./episodes.js";
import { nextStart, previousStart, periodStart, inPeriod } from "./periods.js";

export const MIN_EPISODES = 9;   // fewer says more about one trip than about the driving; nine leave three in each outer third
export const HARD = 2.0;   // m/s² - only for the share of hard speed-ups; the styles come from the driver's own spread
export const NEAR_KMH = 10;
export const MIN_SAVING = 0.1;   // kWh per 100 km - below this a tip is not worth the driver's attention
export const UP_SITUATIONS = [[0, 30], [0, 50], [30, 70], [50, 90], [70, 110], [90, 130]];
export const DOWN_BANDS = [30, 50, 70, 90];   // the last band has no top

/** The [p] quantile of the finite values, interpolated; null when there are none. */
export function quantile(xs, p) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const at = (s.length - 1) * p, lo = Math.floor(at);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (at - lo);
}
export const median = xs => quantile(xs, 0.5);

const rows = (cols, fields) => cols[fields[0]].map((_, i) => Object.fromEntries(fields.map(k => [k, cols[k][i]])));

/** Every episode of [list], and the distance of the drives that had any to give - a log without power says nothing. */
export function episodesOf(list) {
  const up = [], down = [];
  let km = 0, drives = 0;
  for (const s of list) {
    if (!s.episodes) continue;
    drives++;
    km += s.km;
    for (const e of rows(s.episodes.up, UP_FIELDS)) up.push(e);
    for (const e of rows(s.episodes.down, DOWN_FIELDS)) down.push(e);
  }
  return { up, down, km, drives };
}

/**
 * Speed-ups by situation, split into the driver's own thirds by acceleration -
 * the gentlest third, the briskest, and the moderate rest - and set against the
 * cheaper of the two outer thirds. A pull's energy is scaled to the situation's
 * speed change (kinetic energy goes with v²), so a 0→40 is not flattered beside
 * a 0→60. Only the other outer third counts as waste: scatter inside the
 * cheaper style is not something a change of style would fix, and equal
 * medians mean the style makes no difference, so there is nothing to save.
 * Thirds are by rank, not fixed m/s²; a driver who only ever pulls
 * gently still gets a "brisk" third; the style medians' accel says how brisk.
 */
export function speedUps(up, km) {
  const groups = UP_SITUATIONS.map(() => []);
  for (const e of up) {
    if (e.kwh == null || !(e.v1 ** 2 - e.v0 ** 2 > 0)) continue;
    let into = -1, off = Infinity;
    UP_SITUATIONS.forEach(([a, b], i) => {
      const d = Math.abs(e.v0 - a) + Math.abs(e.v1 - b);
      if (Math.abs(e.v0 - a) <= NEAR_KMH && Math.abs(e.v1 - b) <= NEAR_KMH && d < off) { into = i; off = d; }
    });
    if (into >= 0) groups[into].push(e);
  }
  const out = [];
  groups.forEach((g, i) => {
    if (!g.length || !(km > 0)) return;
    const [a, b] = UP_SITUATIONS[i];
    // Too few to judge, but named all the same: the page says how many more it needs.
    if (g.length < MIN_EPISODES) return out.push({ kind: "up", from: a, to: b, count: g.length, enough: false });
    const cost = e => e.kwh * (b ** 2 - a ** 2) / (e.v1 ** 2 - e.v0 ** 2);
    const sorted = [...g].sort((x, y) => x.accel - y.accel);
    const third = Math.floor(g.length / 3);
    const figures = l => ({ count: l.length, kwh: median(l.map(cost)), seconds: median(l.map(e => e.seconds)), accel: median(l.map(e => e.accel)) });
    const thirds = { gentle: sorted.slice(0, third), moderate: sorted.slice(third, -third), brisk: sorted.slice(-third) };
    const styles = Object.fromEntries(Object.entries(thirds).map(([name, l]) => [name, figures(l)]));
    const best = styles.brisk.kwh < styles.gentle.kwh ? "brisk" : "gentle";
    const other = best === "brisk" ? "gentle" : "brisk";
    const target = styles[best].kwh;
    const excess = styles[other].kwh > target ? thirds[other].reduce((sum, e) => sum + Math.max(0, cost(e) - target), 0) : 0;
    const whole = g.length * target + excess;
    out.push({
      kind: "up", from: a, to: b, count: g.length, enough: true, styles, best,
      median: median(g.map(cost)), target, ratio: whole > 0 ? Math.min(1, Math.max(0, g.length * target / whole)) : 1,
      savingPer100: excess / km * 100,
      // Every pull, for the page's dot chart: how brisk, what it cost scaled to the situation, and its third.
      points: sorted.map((e, k) => ({
        accel: e.accel, cost: cost(e), style: k < third ? "gentle" : k >= g.length - third ? "brisk" : "moderate",
      })),
    });
  });
  return out;
}

export const MIN_STYLE = 3;          // fewer says nothing about a style, only about one or two pulls
export const MIN_ANSWER = 8;         // minimum episodes in both outer thirds for a compareStyles answer
export const ETA_MAX = 20;           // what a unit of kinetic energy may plausibly have cost
export const SPEED_CEILING = 160;    // the fastest speed the comparison will answer for

/** The kinetic energy in kWh gained going from [v0] to [v1] km/h, for a car of [massKg]. */
const kineticKwh = (v0, v1, massKg) => 0.5 * massKg * ((v1 / 3.6) ** 2 - (v0 / 3.6) ** 2) / 3.6e6;

/**
 * Every usable pull-away by how brisk it was and what a unit of kinetic energy
 * cost it - the pull's own energy over the kinetic energy it gained, so a 0→30
 * and a 50→100 can stand in the same picture. The cost carries the drag, the
 * rolling and the drivetrain of the pull itself, which is what makes the styles
 * comparable at all. The thirds are the driver's own, as speedUps() splits them.
 * A downhill pull can read under 1; the bounds only keep nonsense out.
 * One set of thirds covers all speeds, not each situation; that is
 * the point, a week rarely holds nine pulls in one narrow speed range.
 */
export function pullStyles(up, { massKg = CALIBRATION.massKg } = {}) {
  const used = [];
  let dropped = 0;
  for (const e of up) {
    if (e.kwh == null || !(e.seconds > 0) || !(e.v1 > e.v0)) continue;
    const dKe = kineticKwh(e.v0, e.v1, massKg);
    // Drop only if: dKe <= 0, non-finite accel/eta, eta > ETA_MAX, or dKe < 1 Wh quantization noise
    if (dKe <= 0 || !Number.isFinite(e.accel) || dKe < 0.001) { dropped++; continue; }
    const eta = e.kwh / dKe;
    if (!Number.isFinite(eta) || eta > ETA_MAX) { dropped++; continue; }
    // Keep everything else, including eta near 0 (a pull that cost nothing really did cost nothing)
    used.push({ accel: e.accel, eta, v0: e.v0, v1: e.v1, seconds: e.seconds });
  }
  used.sort((a, b) => a.accel < b.accel ? -1 : a.accel > b.accel ? 1 : 0);
  const third = Math.floor(used.length / 3);
  const parts = { gentle: used.slice(0, third), moderate: used.slice(third, used.length - third), brisk: used.slice(used.length - third) };
  const figures = l => l.length < MIN_STYLE ? null
    : { count: l.length, accel: median(l.map(e => e.accel)), eta: median(l.map(e => e.eta)), seconds: median(l.map(e => e.seconds)) };
  const nameOf = i => i < third ? "gentle" : i >= used.length - third ? "brisk" : "moderate";
  return {
    styles: Object.fromEntries(Object.entries(parts).map(([name, l]) => [name, figures(l)])),
    points: used.map((e, i) => ({ accel: e.accel, eta: e.eta, v0: e.v0, v1: e.v1, style: nameOf(i) })),
    count: used.length, dropped, used: used.length,
  };
}

/**
 * Pulling away gently against pulling away briskly over the same stretch of
 * road: each style pulls at its own median rate to [to], then cruises at [to]
 * to where the gentle one ended - the longer of the two - so both are compared
 * as far as the road they cover, not only as far as the pull.
 * [per100] is what cruising at [to] costs, the Trip tab's own fitted curve.
 * Each style uses its median rate, not a simulation of one pull; a hill
 * or a headwind moves the dots more than it moves the answer.
 */
export function compareStyles({ styles, from, to, per100, massKg = CALIBRATION.massKg }) {
  const pair = [["gentle", styles?.gentle], ["brisk", styles?.brisk]];
  if (pair.some(([, s]) => !s || !(s.accel > 0) || s.count < MIN_ANSWER) || !(per100 > 0)) return null;
  if (!(to > from) || !(from >= 0) || !(to <= SPEED_CEILING)) return null;
  const dKe = kineticKwh(from, to, massKg);
  const legs = pair.map(([style, s]) => {
    const seconds = (to - from) / 3.6 / s.accel;
    return { style, accel: s.accel, eta: s.eta, seconds, distance: (from + to) / 2 / 3.6 * seconds };
  });
  const distanceM = Math.max(...legs.map(l => l.distance));
  const rows = legs.map(l => {
    const cruiseSeconds = (distanceM - l.distance) / (to / 3.6);
    return {
      style: l.style, accel: l.accel, seconds: l.seconds, cruiseSeconds,
      kwh: l.eta * dKe + per100 / 100 * (distanceM - l.distance) / 1000,
      totalSeconds: l.seconds + cruiseSeconds,
    };
  });
  const [gentle, brisk] = rows;
  return { from, to, distanceM, rows, saving: gentle.kwh - brisk.kwh, quicker: gentle.totalSeconds - brisk.totalSeconds };
}

/** The slow-downs worth judging, in the groups slowDowns() and liftEffect() both work from. */
function downGroups(down) {
  const groups = new Map();
  for (const e of down) {
    if (e.v0 < DOWN_BANDS[0] || e.braked == null || e.brakeKwh == null || !(e.v0 ** 2 - e.v1 ** 2 > 0)) continue;
    let band = 0;
    while (band + 1 < DOWN_BANDS.length && e.v0 >= DOWN_BANDS[band + 1]) band++;
    const key = `${band}:${e.toStop}`;
    if (!groups.has(key)) groups.set(key, { band, toStop: e.toStop === 1, list: [] });
    groups.get(key).list.push(e);
  }
  return [...groups.values()];
}

/**
 * What lifting off earlier was worth, group by group: the braked slow-downs
 * split at their own median lift-off time, and the brake loss of each half.
 * Half a group is what "earlier" means here - a fixed number of seconds would
 * mean something else at 40 km/h than at 100.
 */
export function liftEffect(down) {
  return downGroups(down).map(({ band, toStop, list }) => {
    // One population: braked episodes with timing data and valid shed
    const points = list.filter(e => e.braked === 1 && e.liftSeconds != null && e.brakeKwh != null)
      .map(e => {
        const shed = e.v0 ** 2 - e.v1 ** 2;
        return { liftSeconds: e.liftSeconds, brakeKwh: e.brakeKwh, shed: shed > 0 ? shed : null };
      }).filter(p => p.shed != null);

    if (points.length === 0) return {
      kind: "down", from: DOWN_BANDS[band], to: DOWN_BANDS[band + 1] ?? null, toStop, count: list.length,
      points, split: null, early: null, late: null, saved: null,
    };

    // Reference shed: median over the same population P (braked with timing)
    const refShed = median(points.map(p => p.shed));

    // Normalize each episode: loss as if it had shed the reference amount - the same figure the
    // page's chart plots, so the dots and the verdict are never reading two different things.
    const pointsWithLoss = points.map(p => ({
      liftSeconds: p.liftSeconds,
      lossAtRef: p.brakeKwh * refShed / p.shed,
    }));

    // Split on timing: median liftSeconds
    const split = median(pointsWithLoss.map(p => p.liftSeconds));
    const half = pick => {
      const l = pointsWithLoss.filter(pick).map(p => p.lossAtRef);
      if (l.length < MIN_STYLE) return null;
      return median(l);
    };

    let early = split == null ? null : half(p => p.liftSeconds >= split);
    let late = split == null ? null : half(p => p.liftSeconds < split);

    // If split is duplicated and one half is empty, fall back to mean of liftSeconds
    if (split != null && (early == null) !== (late == null)) {
      const meanLiftSeconds = pointsWithLoss.reduce((s, p) => s + p.liftSeconds, 0) / pointsWithLoss.length;
      early = half(p => p.liftSeconds >= meanLiftSeconds);
      late = half(p => p.liftSeconds < meanLiftSeconds);
    }

    return {
      kind: "down", from: DOWN_BANDS[band], to: DOWN_BANDS[band + 1] ?? null, toStop, count: list.length,
      points: pointsWithLoss, split, early, late, saved: early != null && late != null ? late - early : null,
    };
  }).sort((a, b) => a.from - b.from || (a.toStop ? 1 : 0) - (b.toStop ? 1 : 0));
}

/**
 * Slow-downs by starting speed and whether they ended in a stop, each against
 * its best quarter: the episodes that lost least to the brakes for the speed
 * they shed. What the gap is worth is the brake loss beyond the best quarter's,
 * as the pack would have had it; savingPer100 sums it per episode, so a few
 * wasteful stops are not hidden by the median. The figures say how the best
 * quarter got there - how often it braked at all, and how long it lifted off
 * first when it did.
 */
export function slowDowns(down, km, regenEfficiency = CALIBRATION.regenEfficiency) {
  const norm = e => e.brakeKwh / (e.v0 ** 2 - e.v1 ** 2);
  const figures = l => ({
    brakedShare: l.reduce((n, e) => n + e.braked, 0) / l.length,
    liftSeconds: median(l.filter(e => e.braked === 1).map(e => e.liftSeconds)),
    brakeKwh: median(l.map(e => e.brakeKwh)), regenKwh: median(l.map(e => e.regenKwh)),
  });
  const out = [];
  for (const { band, toStop, list } of downGroups(down)) {
    if (!(km > 0)) continue;
    const head = { kind: "down", from: DOWN_BANDS[band], to: DOWN_BANDS[band + 1] ?? null, toStop, count: list.length };
    if (list.length < MIN_EPISODES) { out.push({ ...head, enough: false }); continue; }
    const top = [...list].sort((a, b) => norm(a) - norm(b)).slice(0, Math.ceil(list.length / 4));
    const you = figures(list), best = figures(top);
    const wasted = list.reduce((sum, e) => sum + Math.max(0, e.brakeKwh - best.brakeKwh) * regenEfficiency, 0);
    // Of everything the group could have put back in the pack, the share not lost beyond the best quarter.
    const could = list.reduce((sum, e) => sum + e.regenKwh + e.brakeKwh * regenEfficiency, 0);
    out.push({
      ...head, enough: true, you, best,
      ratio: could > 0 ? 1 - Math.min(1, wasted / could) : 1,
      savingPer100: wasted / km * 100,
    });
  }
  return out.sort((a, b) => a.from - b.from || a.toStop - b.toStop);
}

/**
 * A period's coaching: its situations, the tips worth giving, and a score where
 * 100 is every situation driven like the driver's own best. Groups too small to
 * judge are handed back apart, in [small], so the page can say what is missing;
 * nothing is worked out from them.
 */
export function coach(list, { regenEfficiency } = {}) {
  const { up, down, km, drives } = episodesOf(list);
  const found = [...speedUps(up, km), ...slowDowns(down, km, regenEfficiency)];
  const situations = found.filter(s => s.enough);
  const weight = situations.reduce((n, s) => n + s.count, 0);
  return {
    drives, km, situations, small: found.filter(s => !s.enough),
    tips: situations.filter(s => s.savingPer100 > MIN_SAVING).sort((a, b) => b.savingPer100 - a.savingPer100).slice(0, 3),
    score: weight ? Math.round(100 * situations.reduce((n, s) => n + s.ratio * s.count, 0) / weight) : null,
    hardShare: up.length ? up.filter(e => e.accel > HARD).length / up.length : null,
    liftSeconds: median(down.filter(e => e.toStop === 1 && e.braked === 1).map(e => e.liftSeconds)),
  };
}

export const USUAL_PERIODS = 8, MIN_USUAL = 3, MIN_TREND = 4;
export const COLD_GAP = 5;   // °C colder than usual before the weather takes the blame
const DAY = 86400e3;

const daysIn = (kind, start) => Math.round((nextStart(kind, start) - start) / DAY);
const halfSpread = xs => (quantile(xs, 0.75) - quantile(xs, 0.25)) / 2;

/**
 * [value] against the median of [usual]: within half the spread of those periods is no change at all.
 * Under MIN_USUAL known periods there is no spread to speak of, and any difference would read as a verdict.
 */
export function versusUsual(value, usual, better) {
  const known = usual.filter(Number.isFinite);
  if (!Number.isFinite(value) || known.length < MIN_USUAL) return null;
  const mid = median(known);
  const verdict = Math.abs(value - mid) <= halfSpread(known) ? "same"
    : (value < mid) === (better === "lower") ? "better" : "worse";
  return { usual: mid, verdict };
}

/** "cold" when a worse figure came in a period well colder than usual - the weather, not the driving. */
export function coldCause(compared, temp, usualTemps) {
  const usual = median(usualTemps);
  return compared?.verdict === "worse" && Number.isFinite(temp) && usual != null && temp < usual - COLD_GAP ? "cold" : null;
}

/** Which way a figure is heading over the periods: a least-squares line, steady while it moves less than half the spread. */
export function direction(values, better) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => Number.isFinite(v));
  if (pts.length < MIN_TREND) return null;
  const mx = pts.reduce((s, [x]) => s + x, 0) / pts.length;
  const my = pts.reduce((s, [, y]) => s + y, 0) / pts.length;
  const slope = pts.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / pts.reduce((s, [x]) => s + (x - mx) ** 2, 0);
  const change = slope * (pts[pts.length - 1][0] - pts[0][0]);
  if (Math.abs(change) <= halfSpread(pts.map(([, y]) => y))) return "steady";
  return (change < 0) === (better === "lower") ? "improving" : "slipping";
}

/**
 * measure(list, periodStart) for up to [count] periods before [start], oldest
 * first; null for a period with no drives, and none before the period of the
 * first drive - as baseline() in periods.js counts them.
 */
export function periodHistory(summaries, kind, start, measure, count = USUAL_PERIODS) {
  if (kind === "all" || !summaries.length) return [];
  const earliest = periodStart(kind, Math.min(...summaries.map(s => s.start)));
  const out = [];
  for (let at = previousStart(kind, start); out.length < count && at >= earliest; at = previousStart(kind, at)) {
    const list = inPeriod(summaries, kind, at);
    out.unshift(list.length ? measure(list, at) : null);
  }
  return out;
}

/** A period's distance over all its calendar days, driven or not. A week that changes the clocks is still 7 days. A caller counts an empty period as 0, not null. */
export const kmPerDay = (list, kind, start) => list.reduce((n, s) => n + s.km, 0) / daysIn(kind, start);

/**
 * Where the week or month under way is heading: its pace so far carried to the
 * end, with a range from how far the usual periods went a day. Calendar days, so
 * a week that changes the clocks is still 7. Under a day in, the pace is one trip,
 * not a pace, so there is no forecast.
 * Straight-line pace has no weekday weighting.
 */
export function forecast({ kind, start, now, km, per100, usualKmPerDay = [] }) {
  if (kind === "all") return null;
  const end = nextStart(kind, start);
  if (now >= end || now < start + DAY) return null;
  const days = daysIn(kind, start);
  const share = (now - start) / (end - start);
  const projected = km / share;
  const leftDays = (1 - share) * days;
  const low = quantile(usualKmPerDay, 0.25), high = quantile(usualKmPerDay, 0.75);
  return {
    km: projected,
    low: low == null ? null : km + low * leftDays,
    high: high == null ? null : km + high * leftDays,
    kwh: Number.isFinite(per100) ? projected * per100 / 100 : null,
  };
}

/** A tip's saving over [projectedKm], and the range it adds to a full pack at [per100]. */
export function tipWorth(tip, projectedKm, per100) {
  if (!Number.isFinite(projectedKm) || !(per100 > tip.savingPer100)) return null;
  return {
    kwh: tip.savingPer100 * projectedKm / 100,
    kmPerCharge: USABLE_KWH / (per100 - tip.savingPer100) * 100 - USABLE_KWH / per100 * 100,
  };
}

/** The count-weighted mean of f over [list]; null when the list holds no episodes. */
const weighted = (list, f) => {
  const n = list.reduce((sum, s) => sum + s.count, 0);
  return n ? list.reduce((sum, s) => sum + f(s) * s.count, 0) / n : null;
};
const percent = v => v == null ? null : Math.round(v * 100);

/**
 * The coach result [c] as the four phases the page draws a bar for. Pulling away,
 * slowing down and anticipation come out of the situations the score is made of;
 * consumption is context beside them, never part of the score.
 * Anticipation reads only the slow-downs where both the driver and the best
 * quarter braked: a best quarter that never braked has no lift-off time to match.
 */
export function phases(c, { per100 = null, usualPer100 = [], temp = null, usualTemps = [] } = {}) {
  const of = kind => {
    const list = c.situations.filter(s => s.kind === kind);
    return { value: percent(weighted(list, s => s.ratio)), count: list.reduce((n, s) => n + s.count, 0) };
  };
  const lifted = c.situations.filter(s => s.kind === "down" &&
    s.you.liftSeconds != null && s.best.liftSeconds != null && s.best.liftSeconds > 0);
  const compared = versusUsual(per100, usualPer100, "lower");
  return {
    pullingAway: of("up"),
    slowingDown: of("down"),
    anticipation: {
      value: percent(weighted(lifted, s => Math.min(1, s.you.liftSeconds / s.best.liftSeconds))),
      count: lifted.reduce((n, s) => n + s.count, 0),
      youSeconds: weighted(lifted, s => s.you.liftSeconds),
      bestSeconds: weighted(lifted, s => s.best.liftSeconds),
    },
    consumption: {
      // A period at or under its usual is a full bar; one above it is short by as much as it used more.
      // A period that took back more than it used (per100 at or under 0) is as good as a bar gets.
      value: compared ? percent(per100 > 0 ? Math.min(1, compared.usual / per100) : 1) : null,
      count: usualPer100.filter(Number.isFinite).length,
      per100, verdict: compared?.verdict ?? null, cause: coldCause(compared, temp, usualTemps),
    },
  };
}
