// The look the Battery, Charging, Patterns, Drives and Settings tabs share: a
// row of big numbers, white panels, a plain key under each chart, and a
// compact picture where a chart would have too few periods to draw. Every
// piece is a pure string builder or a small reading of figures the page
// already holds, so a test can read what the tabs say; the page keeps the
// charts, the maps and the wiring.

import { esc, fmt } from "./coach-view.js";

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = n => String(n).padStart(2, "0");
// fmt() writes the browser's hyphen; a figure below nought reads better with a true minus sign.
const minus = text => text.replace("-", "−");

/** "Mon 14 Sep", in the driver's own time zone and in English whatever the browser's language, as the rest of the page. */
export const day = ms => {
  const d = new Date(ms);
  return `${WEEKDAYS[(d.getDay() + 6) % 7]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
};
/** "Mon 14 Sep 09:14". */
export const dayTime = ms => {
  const d = new Date(ms);
  return `${day(ms)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** "7.5–30.9", or "−5 to 10" once an end is below nought, where a dash between them would read as a minus. */
export const range = (lo, hi, decimals) =>
  `${minus(fmt(lo, decimals))}${lo < 0 || hi < 0 ? " to " : "–"}${minus(fmt(hi, decimals))}`;

/** How a title names the period the bar has chosen. */
export const thisPeriod = kind => kind === "all" ? "all drives" : `this ${kind}`;

/**
 * How [value] sits against the periods before it ([before], oldest first, a
 * period with nothing to show as null): ▲/▼ and the change against their mean,
 * or null when there is nothing to compare or it moved under 3 %. [better] is
 * "higher", "lower" or nothing; the answer's [better] is true, false or null.
 */
export function trendVs(value, before, kind, better) {
  const known = before.filter(v => v != null && Number.isFinite(v));
  if (value == null || !Number.isFinite(value) || !known.length) return null;
  const mean = known.reduce((a, b) => a + b, 0) / known.length;
  if (!mean) return null;
  const change = (value - mean) / Math.abs(mean);
  if (Math.abs(change) < 0.03) return null;
  const up = change > 0;
  return {
    text: `${up ? "▲" : "▼"} ${fmt(Math.abs(change) * 100, 0)} % vs the ${known.length === 1 ? kind : `${known.length} ${kind}s`} before`,
    better: better ? up === (better === "higher") : null,
  };
}

/** The class a trend is drawn in: green when better, red when worse, grey when it is neither. */
export const trendClass = t => `trend ${t.better === true ? "good" : t.better === false ? "bad" : "muted"}`;

const TONES = new Set(["good", "bad"]);

/**
 * The big numbers a tab opens with, [items] of { label, value, unit, note,
 * tone, trend }. [value] comes formatted; null prints "–" and the note says
 * why. [tone] "good" or "bad" puts a dot before the label; [trend] is what
 * trendVs() gives, written after the note.
 */
export const statRow = items => `<div class="stat-row">${items.map(({ label, value, unit, note, tone, trend }) => {
  const dot = TONES.has(tone) ? `<i class="stat-dot ${tone}"></i>` : "";
  const figure = value == null ? "–" : `${esc(value)}${unit ? ` <small>${esc(unit)}</small>` : ""}`;
  const line = [note ? esc(note) : "", trend ? `<span class="${trendClass(trend)}">${esc(trend.text)}</span>` : ""]
    .filter(Boolean).join(" · ");
  return `<div class="stat"><span class="stat-label">${dot}${esc(label)}</span><b>${figure}</b><span class="stat-note">${line}</span></div>`;
}).join("")}</div>`;

/** A white panel with the muted uppercase title, as the Coach and Trip panels have. [body] is markup already made safe. */
export const panel = (title, body) => `<section class="panel"><h2>${esc(title)}</h2>${body}</section>`;

const SHAPES = new Set(["line", "dot", "bar"]);

/** What each colour on a chart is, in words, with an optional muted text at the end - the chart's hover legend is off. */
export const plainKey = (entries, text = "") => `<div class="key">${entries.map(e =>
  `<span><i class="${SHAPES.has(e.shape) ? e.shape : "line"}" style="background: ${esc(e.colour)}"></i>${esc(e.label)}</span>`).join("")}${
  text ? `<span>${esc(text)}</span>` : ""}</div>`;

/**
 * The period's own values as bars, for a chart that has too few periods to be
 * a line yet: label · bar · value, each bar as long as its value against the
 * largest one. A value below nought is measured by its size, so the cell
 * furthest under the pack average has the longest bar.
 */
export function valueBars(rows, { unit = "", decimals = 1 } = {}) {
  const known = v => v != null && Number.isFinite(v);
  const largest = Math.max(0, ...rows.filter(r => known(r.value)).map(r => Math.abs(r.value)));
  return `<div class="bars">${rows.map(r => `<span class="muted">${esc(r.label)}</span>` + (known(r.value)
    ? `<span class="bar"><i style="width: ${(largest ? Math.abs(r.value) / largest * 100 : 0).toFixed(1)}%"></i></span>` +
      `<span>${minus(fmt(r.value, decimals))}${unit ? ` ${esc(unit)}` : ""}</span>`
    : `<span class="bar"></span><span class="muted">no reading</span>`)).join("")}</div>`;
}

/** True while fewer than [minPeriods] periods have a value: a chart then shows the period's own figures instead of lines. */
export const thin = (history, minPeriods = 3) => history.filter(v => v != null && Number.isFinite(v)).length < minPeriods;

/** The runs of charging-curve bands with no kW, each run merged into one range. */
export const curveGaps = curve => curve.reduce((gaps, b) => {
  if (b.kw != null) return gaps;
  const last = gaps[gaps.length - 1];
  if (last && last.to === b.from) last.to = b.to;
  else gaps.push({ from: b.from, to: b.to });
  return gaps;
}, []);

/** The words shaded over a run of the curve with no data. */
export const gapLabel = g => g.to === 100 ? `no data above ${g.from} %` : `no data ${g.from}–${g.to} %`;

/** The "Curve covers" big number: the charge the curve knows from and to, and what it is missing. */
export function curveCover(curve) {
  const known = curve.filter(b => b.kw != null);
  if (!known.length) return { value: null, note: "no DC charge on record yet" };
  const lo = Math.min(...known.map(b => b.from)), hi = Math.max(...known.map(b => b.to));
  const missing = curveGaps(curve).map(g => g.to === 100 && g.from === hi
    ? `no charge on record above ${hi} %` : `no data ${g.from}–${g.to} %`);
  return { value: `${lo}–${hi} %`, note: missing.length ? missing.join(" · ") : null };
}

/**
 * The period's cheapest and dearest drives per kilometre. Only a drive of at
 * least 1 km with its own energy counts: a few hundred metres to the next
 * street says nothing about the driving, whatever it reads per 100 km.
 */
export function efficiencyEnds(list) {
  const counted = list.filter(s => s.km >= 1 && s.energy != null && Number.isFinite(s.per100))
    .sort((a, b) => a.per100 - b.per100 || a.start - b.start);
  return { most: counted[0] ?? null, least: counted[counted.length - 1] ?? null };
}

/** The busiest hour of the week in weekdayHours()'s grid, Monday first; the earliest of equals; null with no driving. */
export function busiestTime(grid) {
  let best = null;
  grid.forEach((row, d) => row.forEach((seconds, h) => {
    if (seconds > 0 && (!best || seconds > best.seconds)) best = { d, h, seconds, label: `${WEEKDAYS[d]} ${pad(h)}:00` };
  }));
  return best;
}
