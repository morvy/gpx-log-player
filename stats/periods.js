// Weeks and months in the driver's own time zone: a drive at 23:30 on Sunday
// belongs to that week, wherever the file's UTC timestamps say.

export function weekStart(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (d.getDay() + 6) % 7);
  return d.getTime();
}

export function monthStart(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

export const periodStart = (kind, ms) => kind === "week" ? weekStart(ms) : kind === "month" ? monthStart(ms) : 0;

// Calendar steps, not fixed milliseconds: a week across the change of summer time is 7 days, not 168 h.
const shift = (kind, start, by) => {
  const d = new Date(start);
  if (kind === "week") d.setDate(d.getDate() + 7 * by); else d.setMonth(d.getMonth() + by);
  return d.getTime();
};
export const nextStart = (kind, start) => shift(kind, start, 1);
export const previousStart = (kind, start) => shift(kind, start, -1);

export function inPeriod(summaries, kind, start) {
  if (kind === "all") return summaries;
  const end = nextStart(kind, start);
  return summaries.filter(s => s.start >= start && s.start < end);
}

/** Rates come from the period's totals, never an average of drive rates - a 2 km trip must not swing them. */
export function totals(list) {
  let km = 0, seconds = 0, energy = 0, energyKm = 0, out = 0, regen = 0;
  for (const s of list) {
    km += s.km;
    seconds += s.moving;
    if (s.energy != null) { energy += s.energy; energyKm += s.km; }
    if (s.out != null && s.regen != null) { out += s.out; regen += s.regen; }
  }
  return { drives: list.length, km, seconds, energy, per100: energyKm > 0.05 ? energy / energyKm * 100 : null, regenShare: out > 0 ? regen / out : null };
}

/**
 * Up to [count] periods before [start], but none before the period of the first
 * drive - a week of history is not four: amounts averaged per period, rates
 * from their totals, and [periods] saying how many it spans.
 */
export function baseline(summaries, kind, start, count = 4) {
  if (kind === "all" || !summaries.length) return null;
  const earliest = periodStart(kind, Math.min(...summaries.map(s => s.start)));
  let from = start, periods = 0;
  while (periods < count && from > earliest) { from = shift(kind, from, -1); periods++; }
  if (!periods) return null;
  const t = totals(summaries.filter(s => s.start >= from && s.start < start));
  if (!t.drives) return null;
  return { ...t, periods, drives: t.drives / periods, km: t.km / periods, seconds: t.seconds / periods, energy: t.energy / periods };
}
