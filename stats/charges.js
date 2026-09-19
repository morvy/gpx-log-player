// Charging is not in the logs: the app closes a file when the car is plugged in.
// What the logs do hold is the charge a drive ended on and the charge the next
// one started with, so a charge is read out of the gap between two drives. As
// with the habits and the pack, nothing here judges - the limits are handed in,
// so moving one is a redraw and never a re-import.

import { haversineKm } from "./num.js";
import { SPEED_BANDS } from "./habits.js";

/**
 * What one point of charge is worth at the pack, until the driving says
 * otherwise. Wall losses are not visible from inside the car, so every kWh here
 * is pack-side and a charger's meter will read higher.
 */
export const KWH_PER_POINT = 0.244;
const LEARN_FALL = 5;        // points a drive must have used before it says anything about the size of a point
const LEARN_DRIVES = 3;      // fewer than this and one odd drive sets the size of every charge

/** Finer at the top, where a DC charge slows down and the difference is worth planning around. */
export const CHARGE_BANDS = [0, 20, 40, 60, 70, 80, 90, 100];

/**
 * How many kWh a point of charge is, summed over the drives that used enough of
 * the pack to say. A short trip loses a point to the BMS rounding as easily as
 * to the road, which is what LEARN_FALL keeps out.
 */
export function learnKwhPerPoint(summaries) {
  let energy = 0, points = 0, drives = 0;
  for (const s of summaries) {
    if (s.socStart == null || s.socEnd == null || s.energy == null) continue;
    const fall = s.socStart - s.socEnd;
    if (fall < LEARN_FALL) continue;
    energy += s.energy;
    points += fall;
    drives++;
  }
  return drives >= LEARN_DRIVES && points > 0 && energy > 0
    ? { kwh: energy / points, drives, learned: true }
    : { kwh: KWH_PER_POINT, drives, learned: false };
}

/** A drive with no charge reading at either end: a basic log (Extended data off) writes no charge at all. */
const noSoc = s => s.socStart == null && s.socEnd == null;

/** How many of [drives] carry no charge level at all - the ones a charge can never be found around. */
export const noSocCount = drives => drives.filter(noSoc).length;

/**
 * The charges between drives: the charge went up while the car was not
 * driving, so it was plugged in. A basic log in between is skipped rather
 * than breaking the pair - it says nothing about charging, but the drives
 * either side of it still do - and the distance it covered is added to the
 * move check, since driving it unlogged is exactly the case that check is for.
 * The kW is an average over the whole gap with the parking in it, which
 * makes it a floor and never a peak.
 */
export function findCharges(summaries, limits, perPoint) {
  const order = [...summaries].sort((a, b) => a.start - b.start);
  const found = [];
  let a = null;         // the latest earlier drive whose end carries a charge level
  let skippedM = 0;      // metres covered by basic logs skipped since [a]
  for (const b of order) {
    if (a && b.socStart != null) {
      const points = b.socStart - a.socEnd;
      if (points >= limits.chargeRise) {
        const hours = (b.start - a.end) / 3.6e6;
        const kwh = points * perPoint;
        const kw = hours > 0 ? kwh / hours : null;
        // The car came back to the road somewhere else: it was driven there unlogged, and the gap is
        // then partly driving. The charge is still real and still listed; it simply cannot time itself.
        const movedM = haversineKm(a.endLat, a.endLon, b.startLat, b.startLon) * 1000;
        found.push({
          at: a.end, until: b.start, hours, from: a.socEnd, to: b.socStart, points, kwh, kw,
          dc: kw != null && kw >= limits.dcKw,
          moved: movedM > limits.movedM || skippedM > limits.movedM, movedM,
          lat: a.endLat, lon: a.endLon, fileId: a.fileId,
        });
      }
    }
    if (b.socEnd != null) { a = b; skippedM = 0; }
    else if (noSoc(b)) skippedM += b.km * 1000;
    // socStart known, socEnd not: not a basic log and not a full anchor either, so it may have just
    // paired as the far end of a charge above, but it cannot carry the chain past itself - forgetting
    // the anchor here is what stops a later drive reaching back across it to a stale one.
    else { a = null; skippedM = 0; }
  }
  return found;
}

/** The charges the curve may be drawn from: DC, in one place, and over a gap short enough to be charging and not a night. */
export const curveCharges = (charges, limits) =>
  charges.filter(c => c.dc && !c.moved && c.hours <= limits.chargeGapHours);

/**
 * kW by band of charge over the charges curveCharges() allows: the mean of the
 * charges covering the band, each weighted by how much of the band it covered,
 * so a charge that ran across one band and clipped the next says most about the
 * one it ran across. The filtering is the caller's so the curve and the caption
 * counting the charges behind it can never come from two different sets.
 */
export function chargingCurve(used) {
  return CHARGE_BANDS.slice(0, -1).map((from, i) => {
    const to = CHARGE_BANDS[i + 1];
    let weight = 0, sum = 0, covering = 0;
    for (const c of used) {
      const overlap = Math.min(to, c.to) - Math.max(from, c.from);
      if (!(overlap > 0)) continue;
      weight += overlap;
      sum += c.kw * overlap;
      covering++;
    }
    return { from, to, kw: weight ? sum / weight : null, charges: covering };
  });
}

/** Distance, time and energy by speed band over [list], with what each band says about driving at its speed. */
export function bandUse(list) {
  const bands = SPEED_BANDS.map((from, i) => ({ from, to: SPEED_BANDS[i + 1] ?? null, km: 0, seconds: 0, energy: 0, energyKm: 0 }));
  for (const s of list) s.habits?.bands?.forEach((b, i) => {
    const into = bands[i];
    if (!into) return;
    into.km += b.km;
    into.seconds += b.seconds;
    if (b.energy != null) { into.energy += b.energy; into.energyKm += b.energyKm; }
  });
  return bands.map(b => ({
    ...b,
    kmh: b.seconds > 0 ? b.km / (b.seconds / 3600) : null,
    per100: b.energyKm > 0.05 ? b.energy / b.energyKm * 100 : null,
  }));
}

export const TRIP_BAND_KM = 20;    // less driving than this in a band says more about one trip than about the speed

/**
 * The minutes the curve says a charge from [from] to [to] takes, or the band
 * that stopped it: a band no charge has ever covered cannot be charged through,
 * and guessing one would be inventing the very figure the driver came for.
 */
export function chargeMinutes(curve, from, to, perPoint) {
  let minutes = 0;
  for (const band of curve) {
    const points = Math.min(band.to, to) - Math.max(band.from, from);
    if (!(points > 0)) continue;
    if (!(band.kw > 0)) return { minutes: null, blocked: band };
    minutes += points * perPoint / band.kw * 60;
  }
  return { minutes, blocked: null };
}

const STOP_CAP = 200;   // More stops than this indicates invalid input.

/** One speed driven to one charge-to level, from end to end: drive to the floor, charge, repeat. */
function plan(speed, target, { km, socStart, socMin, stopMinutes, curve, perPoint }) {
  const pointsPerKm = speed.per100 / 100 / perPoint;
  if (!(pointsPerKm > 0) || !(socStart > socMin) || !(km > 0)) return null;
  let soc = socStart, left = km, stops = 0, charging = 0;
  // The last stop charges to exactly what the rest of the road needs, so the test that ends the loop is
  // socMin + x - socMin > x - false in arithmetic and sometimes true in binary. A billionth of a point
  // of charge is far under anything the BMS can read and far over the rounding, so the road ends here.
  while (left * pointsPerKm > soc - socMin + 1e-9) {
    if (stops >= STOP_CAP) return null;
    left -= (soc - socMin) / pointsPerKm;
    soc = socMin;
    // The last stop takes only what the rest of the road needs; every other one goes to the level being tried.
    const to = Math.min(target, socMin + left * pointsPerKm, 100);
    if (!(to > soc)) return null;   // a level at or under the floor never gets the car any further
    const step = chargeMinutes(curve, soc, to, perPoint);
    if (step.minutes == null) return { blocked: step.blocked };
    charging += step.minutes;
    stops++;
    soc = to;
  }
  const driving = km / speed.kmh * 60;
  return {
    target, stops, driving, charging, waiting: stops * stopMinutes,
    total: driving + charging + stops * stopMinutes,
    arrival: soc - left * pointsPerKm, kwh: km * speed.per100 / 100,
  };
}

export const CHARGE_TO = { from: 30, to: 100, step: 5 };

/**
 * The trip at each candidate speed. One charge-to level is chosen per speed -
 * every level from 30 to 100 % is tried and the fastest kept - because that is
 * the one thing a driver can actually follow on the road. It assumes a charger
 * wherever the plan wants one, which the page says out loud.
 */
export function tripPlan({ speeds, curve, km, socStart, socMin, stopMinutes, perPoint }) {
  return speeds.map(speed => {
    let best = null, blocked = null;
    for (let target = CHARGE_TO.from; target <= CHARGE_TO.to; target += CHARGE_TO.step) {
      const got = plan(speed, target, { km, socStart, socMin, stopMinutes, curve, perPoint });
      if (!got) continue;
      // Every stop charges from the floor, so whichever level is being tried, the band that stops it is
      // the lowest one above the floor with no data - the first level to be stopped names it as well as
      // the last. Kept as ??= because it is the first one that answers the question the row asks.
      if (got.blocked) { blocked ??= got.blocked; continue; }
      if (!best || got.total < best.total) best = got;
    }
    return { speed, ...(best ?? { blocked }) };
  });
}
