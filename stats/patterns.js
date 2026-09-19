// What the driving looks like from further away: which weeks were busy, when in
// the week the car is used, where it keeps being parked, and what the weather
// costs. All of it is read out of the stored summaries - no file is opened
// again - and as with the habits nothing here judges: the radius that says two
// parkings are one place is handed in, so moving it is a redraw.

import { haversineKm } from "./num.js";
import { weekStart, nextStart } from "./periods.js";

const HOUR_MS = 3600000;

/**
 * Kilometres per calendar week, every week from the first drive to the last -
 * a week nobody drove is a nought and not a missing bar, or the chart would
 * draw a fortnight off as two weeks side by side.
 */
export function distancePerWeek(list) {
  const weeks = new Map();
  for (const s of list) {
    if (!Number.isFinite(s.start) || !Number.isFinite(s.km)) continue;
    const at = weekStart(s.start);
    const week = weeks.get(at) ?? { start: at, km: 0, drives: 0 };
    week.km += s.km;
    week.drives++;
    weeks.set(at, week);
  }
  if (!weeks.size) return [];
  const out = [];
  const last = Math.max(...weeks.keys());
  // Calendar steps, so the week the clocks change is seven days and lands on the same Monday weekStart does.
  for (let at = Math.min(...weeks.keys()); at <= last; at = nextStart("week", at)) {
    out.push(weeks.get(at) ?? { start: at, km: 0, drives: 0 });
  }
  return out;
}

/**
 * Driving seconds by weekday (Monday first) and hour of the local day.
 *
 * A summary stores seconds per hour of the day, not per date, so a drive that
 * runs past midnight has to be walked back onto the calendar: its hours are
 * visited from the hour it started in until the hour it ended in, and each
 * bucket is given to the weekday of the first hour that carries it. Two hours
 * of the same number inside one drive - the hour repeated when summer time
 * ends, or a drive of over a day - share the bucket in the summary already, so
 * they land together on the first of the two days: every hour the drive runs
 * through twice lands on the first day, which is one cell for the repeated hour
 * and up to twenty-four for a drive of two days. Both are rare enough to leave
 * alone; splitting them would cost a field in every stored summary.
 */
export function weekdayHours(list) {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const s of list) {
    // No guard on [end]: a walk that cannot compare with it never takes a step, which is the same thing.
    if (!s.hourSeconds || !Number.isFinite(s.start)) continue;
    const seen = new Array(24).fill(false);
    const walk = new Date(s.start);
    walk.setMinutes(0, 0, 0);
    // At most the 24 buckets a summary holds: a longer drive has nothing left to place after them.
    for (let k = 0; k < 24 && walk.getTime() <= s.end; k++, walk.setTime(walk.getTime() + HOUR_MS)) {
      const hour = walk.getHours();
      if (seen[hour]) continue;
      seen[hour] = true;
      grid[(walk.getDay() + 6) % 7][hour] += s.hourSeconds[hour] ?? 0;
    }
  }
  return grid;
}

/**
 * The places the car sets off from and stops at, with the drives around them.
 * A driveway is written a few metres differently every time, so an endpoint
 * joins the first place already found within [radiusM] of its centre; the
 * centre is the mean of the endpoints in it, and the endpoints are taken in
 * time order so the same drives always give the same places - though which
 * endpoint seeds a chain, and so where the chain ends up, is that order's doing.
 * Use the first place within the radius of its running mean, not the
 * nearest and not the seed. Joining an endpoint drags the centre by r/(n+1), so
 * a row of parkings each just inside the radius of the last chains out to about
 * r·(1 + ln n) - 435 m at a 100 m radius over 44 endpoints. Cluster against the
 * seed instead of the mean if a stretch of street ever shows up as one circle.
 */
export function places(list, radiusM) {
  const ends = [];
  for (const s of list) {
    if (Number.isFinite(s.startLat) && Number.isFinite(s.startLon)) ends.push({ lat: s.startLat, lon: s.startLon, at: s.start, km: s.km, setOff: true });
    if (Number.isFinite(s.endLat) && Number.isFinite(s.endLon)) ends.push({ lat: s.endLat, lon: s.endLon, at: s.end, km: s.km, setOff: false });
  }
  ends.sort((a, b) => a.at - b.at || (b.setOff ? 1 : 0) - (a.setOff ? 1 : 0));
  const found = [];
  for (const e of ends) {
    let place = found.find(p => haversineKm(p.lat, p.lon, e.lat, e.lon) * 1000 <= radiusM);
    if (!place) {
      place = { lat: e.lat, lon: e.lon, latSum: 0, lonSum: 0, visits: 0, setOffs: 0, stops: 0, km: 0, first: e.at, last: e.at };
      found.push(place);
    }
    place.visits++;
    place.latSum += e.lat;
    place.lonSum += e.lon;
    place.lat = place.latSum / place.visits;
    place.lon = place.lonSum / place.visits;
    place.first = Math.min(place.first, e.at);
    place.last = Math.max(place.last, e.at);
    if (e.setOff) { place.setOffs++; place.km += Number.isFinite(e.km) ? e.km : 0; } else place.stops++;
  }
  // Busiest first, and the earliest of equals, so the map and the caption read the same way twice running.
  return found.map(({ latSum, lonSum, ...p }) => p).sort((a, b) => b.visits - a.visits || a.first - b.first);
}

/** Where a drive's A/C sits: off, some of the time, or on - the page's colours and its legend. */
export const AC_BANDS = [0, 0.25, 0.75];
export const acBandOf = share => {
  if (share == null) return null;
  let b = 0;
  while (b + 1 < AC_BANDS.length && share >= AC_BANDS[b + 1]) b++;
  return b;
};

/**
 * One point per drive: what it cost against the weather it was driven in.
 * A drive with no outside temperature, or none of its own energy to divide,
 * cannot be placed and is counted instead; a drive whose log carries no A/C
 * column keeps its point and loses only its colour - a basic log would
 * otherwise take the whole scatter with it.
 */
export function tempScatter(list) {
  const points = [];
  let skipped = 0, noAc = 0;
  for (const s of list) {
    if (s.outsideTemp == null || s.per100 == null) { skipped++; continue; }
    if (s.acShare == null) noAc++;
    points.push({ at: s.start, temp: s.outsideTemp, per100: s.per100, km: s.km, acShare: s.acShare ?? null, ac: acBandOf(s.acShare ?? null) });
  }
  // uPlot wants its x ascending, and the coldest drive first is how the chart is read anyway.
  points.sort((a, b) => a.temp - b.temp || a.at - b.at);
  return { points, skipped, noAc };
}
