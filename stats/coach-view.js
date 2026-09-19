// The Coach tab: what stats/coach.js works out, as a dial, four phase bars, the
// tips and the evidence behind them. Every sentence the tab says is written here,
// in pure functions a test can read; drawCoach() is the only part that touches
// the page.

import {
  coach, phases, versusUsual, periodHistory, kmPerDay, forecast, tipWorth, median, quantile, episodesOf,
  pullStyles, compareStyles, liftEffect, MIN_EPISODES, MIN_USUAL, MIN_ANSWER, SPEED_CEILING,
} from "./coach.js";
import { totals } from "./periods.js";

/** Text made safe to put in HTML. Nothing from a file is drawn here today; this keeps it that way if it ever is. */
export const esc = text => String(text).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
// The page's own number format: the browser's locale, a fixed number of decimals, a dash for nothing.
export const fmt = (v, dec = 1) => !Number.isFinite(v) ? "–" : v.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
const count = (n, one, many) => `${fmt(n, 0)} ${n === 1 ? one : many}`;
export const share = v => {
  const pct = v * 100;
  const rounded = Math.round(pct);
  if (rounded === 0 && pct > 0) return "under 1 %";
  if (rounded === 100 && pct < 100) return "over 99 %";
  return `${fmt(pct, 0)} %`;
};
/** Display energy in Wh if under 0.1 kWh, otherwise kWh with 2 decimals. Under 0.5 Wh (non-zero) shows "under 1 Wh". */
export const energyWh = v => {
  if (v === 0) return "0 Wh";
  if (v > 0 && v < 0.1) {
    const wh = Math.round(v * 1000);
    return wh === 0 ? "under 1 Wh" : `${wh} Wh`;
  }
  return `${fmt(v, 2)} kWh`;
};
// A brake loss whose energyWh() reads "0 Wh" or "under 1 Wh" is not worth calling out on its own.
const NEGLIGIBLE = new Set(["0 Wh", "under 1 Wh"]);
const barelyLost = kwh => NEGLIGIBLE.has(energyWh(kwh));

/** The id a situation's evidence panel carries, so a tip can scroll to it. */
export const situationId = s => s.kind === "up" ? `coach-up-${s.from}-${s.to}` : `coach-down-${s.from}-${s.toStop ? "stop" : "on"}`;
const speeds = s => s.kind === "up" ? `${s.from}→${s.to} km/h` : s.to === null ? `${s.from}+ km/h` : `${s.from}–${s.to} km/h`;
/** "0→50 km/h", "From 30–50 km/h to a stop", "From 90+ km/h, not to a stop". */
const situationName = s => s.kind === "up" ? speeds(s) : `From ${speeds(s)}${s.toStop ? " to a stop" : ", not to a stop"}`;

// ---------- tips ----------

/** How much less the recommended third used than the other outer third, as a whole percentage. */
const styleGain = s => {
  const pct = 100 * (1 - s.target / s.styles[s.best === "brisk" ? "gentle" : "brisk"].kwh);
  const rounded = Math.round(pct);
  if (rounded === 0 && pct > 0) return "under 1";
  if (rounded === 100 && pct < 100) return "over 99";
  return rounded;
};

/** A tip as the coach says it: a one-line instruction and the evidence for it. */
export function tipSentence(tip) {
  if (tip.kind === "up") {
    const brisk = tip.best === "brisk";
    const other = brisk ? "gentle" : "brisk";
    return {
      title: `Pull away ${brisk ? "briskly" : "gently"} ${tip.from === 0 ? `up to ${tip.to} km/h` : `from ${tip.from} to ${tip.to} km/h`}.`,
      // The cheaper style first, matching the sentence above it.
      evidence: `${brisk ? "Brisk" : "Gentle"} pulls used ${styleGain(tip)} % less · ${tip.styles[tip.best].count} ${tip.best} vs ${tip.styles[other].count} ${other} pulls`,
    };
  }
  const where = tip.to === null ? `above ${tip.from} km/h` : `from ${tip.from}–${tip.to} km/h`;
  const braked = Math.round(tip.you.brakedShare * tip.count);
  // A group whose best and your own median both read as near-nothing still has a real, worth-mentioning
  // total (that is why there is a tip at all) — say so instead of repeating two "0 Wh" figures.
  const evidence = barelyLost(tip.best.brakeKwh) && barelyLost(tip.you.brakeKwh)
    ? `Small brake losses in ${braked} of ${tip.count} slow-downs add up.`
    : tip.best.brakedShare < tip.you.brakedShare
    ? `You braked in ${braked} of ${tip.count}; your best quarter ${tip.best.brakedShare === 0 ? "never did" : `in only ${share(tip.best.brakedShare)}`}.`
    : `Your best quarter lost ${energyWh(tip.best.brakeKwh)} a slow-down to the brakes; you lost ${energyWh(tip.you.brakeKwh)}.`;
  return { title: `Lift off earlier ${where}${tip.toStop ? " before stopping" : ""}.`, evidence };
}

/**
 * What a tip is worth: over the projected distance of the week or month under
 * way ([when] is "week" or "month"), or over the drives shown when there is no
 * projection ([when] null). The range a full pack gains is left out under 1 km.
 */
export function worthLine(tip, projectedKm, per100, when) {
  const w = tipWorth(tip, projectedKm, per100);
  if (!w) return "";
  const range = Math.round(w.kmPerCharge);
  return `≈ ${fmt(w.kwh, 1)} kWh ${when ? `this ${when}` : "over these drives"}` + (range >= 1 ? ` · +${range} km a charge` : "");
}

const tipKey = tip => tip.kind === "up" ? "pullingAway" : "slowingDown";

/** The "Coach says" panel; nothing at all while there is no situation to judge. */
export function tipsHtml(c, worth) {
  if (!c.situations.length) return "";
  const tips = c.tips.map(tip => {
    const { title, evidence } = tipSentence(tip);
    const line = worth(tip);
    return `<button type="button" class="tip" data-evidence="${tipKey(tip)}" data-situation="${situationId(tip)}"
      aria-expanded="false" aria-controls="coachEvidence"><b>${esc(title)}</b>
      <span class="muted">${esc(evidence)}</span>${line ? `<span class="worth">${esc(line)}</span>` : ""}</button>`;
  });
  return `<div class="coach-tips"><h2>Coach says</h2>${tips.length ? tips.join("")
    : `<p>No tip worth your attention right now.</p>`}</div>`;
}

// ---------- the dial ----------

const RING = 2 * Math.PI * 78;

/**
 * The score ring. [compared] is versusUsual() of the score; [total] the drives
 * of the period, so "Based on D of T" can say how many had episodes to give.
 */
export function dialHtml(c, compared, total) {
  const empty = c.score == null;
  const reason = total === 0 ? "no drives in this period"
    : c.drives === 0 ? "these logs have no power readings"
    : `needs ${MIN_EPISODES} similar pull-aways or slow-downs`;
  const ring = empty ? "" :
    `<circle class="ring" cx="95" cy="95" r="78" stroke-dasharray="${(RING * c.score / 100).toFixed(1)} ${RING.toFixed(1)}" transform="rotate(-90 95 95)"/>`;
  const figure = empty
    ? `<text class="score" x="95" y="100" text-anchor="middle">Not enough driving yet</text>`
    : `<text class="score" x="95" y="110" text-anchor="middle">${c.score}</text>`;
  const gap = compared && Math.round(Math.abs(c.score - compared.usual));
  const usual = !compared ? ""
    : compared.verdict === "same" ? `<span class="trend muted">as usual</span>`
    : `<span class="trend ${compared.verdict === "better" ? "good" : "bad"}">${compared.verdict === "better" ? "▲" : "▼"} ${gap} vs usual</span>`;
  return `<div class="dial${empty ? " empty" : ""}">
    <svg viewBox="0 0 190 190" role="img" aria-label="${empty ? "Driving score: not enough driving yet" : `Driving score ${c.score} of 100`}">
      <circle class="ring-back" cx="95" cy="95" r="78"/>${ring}${figure}
      <text class="label" x="95" y="134" text-anchor="middle">driving score</text></svg>
    ${empty ? `<span class="muted">${esc(reason)}</span>` : usual}
    ${c.drives > 0 && c.drives < total ? `<span class="muted">Based on ${c.drives} of ${total} drives</span>` : ""}</div>`;
}

// ---------- the phase bars ----------

const bar = (value, neutral) =>
  `<span class="bar${neutral ? " neutral" : ""}">${value == null ? "" : `<i style="width: ${value}%"></i>`}</span>`;

const phaseButton = (key, label, detail, value, neutral = false) =>
  `<button type="button" class="phase${value == null ? " empty" : ""}" data-evidence="${key}" aria-expanded="false"
    aria-controls="coachEvidence"><b>${label}</b> <span class="muted">· ${esc(detail)}</span>${bar(value, neutral)}</button>`;

const VERDICT = { better: "better than usual", same: "same as usual", worse: "worse than usual" };

/** One bar per phase; a phase with nothing to go on is drawn empty and says what it needs. */
export function phasesHtml(p, kind) {
  const { pullingAway: up, slowingDown: down, anticipation: lift, consumption: use } = p;
  const usual = use.verdict ? VERDICT[use.verdict] + (use.cause === "cold" ? ", mostly the cold" : "")
    : kind === "all" ? "nothing earlier to compare with" : `needs ${MIN_USUAL} earlier periods`;
  return `<div class="phases">` +
    phaseButton("pullingAway", "Pulling away", up.value == null ? `needs ${MIN_EPISODES} similar pull-aways`
      : `${up.value} · ${count(up.count, "pull-away", "pull-aways")}`, up.value) +
    phaseButton("slowingDown", "Slowing down", down.value == null ? `needs ${MIN_EPISODES} similar slow-downs`
      : `${down.value} · ${count(down.count, "slow-down", "slow-downs")}`, down.value) +
    phaseButton("anticipation", "Anticipation", lift.value == null ? "no slow-downs where both you and your best braked"
      : Math.round(lift.bestSeconds) > Math.round(lift.youSeconds) ? `lift-off ${fmt(lift.youSeconds, 0)} s before braking · your best ${fmt(lift.bestSeconds, 0)} s` : `lift-off ${fmt(lift.youSeconds, 0)} s before braking`, lift.value) +
    phaseButton("consumption", "Consumption", use.per100 == null ? "no energy readings in these logs"
      : `${fmt(use.per100, 1)} kWh/100 km · ${usual}`, use.value, true) +
    `</div>`;
}

// ---------- the evidence ----------

const small = s => `<section class="evidence-panel small" id="${situationId(s)}">
  <p>${situationName(s)} — not enough yet, ${s.count} of ${MIN_EPISODES} needed.</p></section>`;

/**
 * The pulls of one situation as dots: how brisk across, what each cost up, each
 * in the colour of its third. No chart library - a few dozen circles are SVG.
 */
export function dotChart(points, yLabel = "kWh") {
  const xs = points.map(p => p.accel), ys = points.map(p => p.cost);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const x = v => (20 + (x1 > x0 ? (v - x0) / (x1 - x0) : 0.5) * 270).toFixed(1);
  const y = v => (100 - (y1 > y0 ? (v - y0) / (y1 - y0) : 0.5) * 80).toFixed(1);
  return `<svg class="dots" viewBox="0 0 300 130" role="img" aria-label="${points.length} pull-aways by how brisk and what they cost">
    <line x1="20" y1="110" x2="290" y2="110"/><text x="20" y="12">${esc(yLabel)} ↑</text><text x="290" y="125" text-anchor="end">brisker →</text>` +
    points.map(p => `<circle class="${p.style}" cx="${x(p.accel)}" cy="${y(p.cost)}" r="4"/>`).join("") + `</svg>`;
}


/**
 * The braked slow-downs of one group as dots: how long the driver coasted
 * before braking across, what the brakes cost up, and a dashed line at the
 * group's median coast. Left of the line is the late half, right the early one.
 * Plots lossAtRef - each episode's brake loss rescaled to the group's own median
 * speed shed - the same figure the verdict sentence is built from, not the raw
 * brakeKwh: two episodes that shed different speed are not the same dot otherwise.
 */
export function liftChart(points, split) {
  const xs = points.map(p => p.liftSeconds), ys = points.map(p => p.lossAtRef * 1000);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const x = v => (20 + (x1 > x0 ? (v - x0) / (x1 - x0) : 0.5) * 270).toFixed(1);
  const y = v => (100 - (y1 > y0 ? (v - y0) / (y1 - y0) : 0.5) * 80).toFixed(1);
  const line = split == null ? ""
    : `<line class="split-line" x1="${x(split)}" y1="20" x2="${x(split)}" y2="110"/>`;
  return `<svg class="dots" viewBox="0 0 300 130" role="img"
    aria-label="${points.length} braked slow-downs by how long the driver coasted first and what the brakes cost">
    <line x1="20" y1="110" x2="290" y2="110"/>${line}<text x="20" y="12">brake loss at your usual speed shed (Wh) ↑</text>
    <text x="290" y="125" text-anchor="end">lifted off earlier →</text>` +
    points.map(p => `<circle class="${split != null && p.liftSeconds >= split ? "early" : "late"}" cx="${x(p.liftSeconds)}" cy="${y(p.lossAtRef * 1000)}" r="4"/>`).join("") +
    `</svg>`;
}

/** One panel per slow-down group with braked slow-downs to show; a group nobody braked in is dimmed. */
export function anticipationHtml(groups) {
  if (!groups.length) return `<p class="muted">No slow-downs from 30 km/h or more with brake-pedal readings here.</p>`;
  return groups.map(g => {
    // Nothing to chart without at least one braked episode.
    if (!g.points.length) return `<section class="evidence-panel small" id="${situationId(g)}">
  <p>${situationName(g)} — you never braked in these.</p></section>`;
    // A verdict needs MIN_ANSWER braked episodes and a real half each side of the split; short of that the
    // chart still draws (there is something to look at) but the sentence says only how far short it is.
    const enough = g.points.length >= MIN_ANSWER && g.saved != null;
    const sample = count(g.points.length, "braked slow-down", "braked slow-downs");
    const verdict = !enough
      ? `Too few braked slow-downs to compare yet (${g.points.length} of ${MIN_ANSWER}).`
      : Math.abs(g.saved) < 0.001 ? `It made little difference here, from ${sample}.`
      : g.saved >= 0.001 ? `Slow-downs where you lifted off ${fmt(g.split, 0)} s or more before braking cost ${energyWh(g.saved)} less, from ${sample}.`
      : `Slow-downs where you lifted off later cost ${energyWh(Math.abs(g.saved))} less here, from ${sample}.`;
    return `<section class="evidence-panel" id="${situationId(g)}">
  <h3>${situationName(g)} · ${g.count}</h3>${liftChart(g.points, g.split)}
  <p>${esc(verdict)}</p>
  <p class="muted">${g.points.length} of ${g.count} used the brake · the line is the middle of them, ${fmt(g.split, 0)} s</p></section>`;
  }).join("");
}

// ---------- brisk or gentle ----------

export const PULL_RANGE = { from: 0, to: 80 };   // the two speeds the block opens on
// The page always hands in the Trip tab's fitted curve; without one the dots are still drawn and the
// answer says it has no consumption figure to work from.
const NO_MODEL = { per100: () => null, source: "physics" };

const STYLE_KEY = `<div class="key"><span><i class="dot" style="background: var(--good)"></i>gentle</span>` +
  `<span><i class="dot" style="background: var(--muted)"></i>moderate</span>` +
  `<span><i class="dot" style="background: var(--accent)"></i>brisk</span>` +
  `<span>x: how brisk, m/s² · y: kWh used per kWh of speed gained</span></div>`;

/** Why there is no answer, in the driver's words. An answer always needs MIN_ANSWER in both outer thirds. */
function pullReason(styles, from, to) {
  if (!(styles.gentle?.count >= MIN_ANSWER) || !(styles.brisk?.count >= MIN_ANSWER))
    return `Needs at least ${MIN_ANSWER} gentle and ${MIN_ANSWER} brisk pull-aways.`;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return "Type both speeds.";
  if (!(from >= 0) || !(to <= SPEED_CEILING)) return `Both speeds have to be between 0 and ${SPEED_CEILING} km/h.`;
  if (!(to > from)) return "The second speed has to be the higher one.";
  return "No consumption figure for that speed.";
}

const styleLeg = row => `<b>${row.style}</b> (${fmt(row.accel, 1)} m/s², ${fmt(row.totalSeconds, 0)} s) ${energyWh(row.kwh)}`;

// The number energyWh() prints for [v], as a bare figure in whichever unit its string uses (kWh above
// 0.1, Wh below) - so "same" and the difference can be read off exactly what the sentence shows.
const printedKwh = v => v > 0 && v < 0.1 ? Math.round(v * 1000) / 1000 : Math.round(v * 100) / 100;
const energyDiffText = (pa, pb) =>
  pa < 0.1 && pb < 0.1 ? `${Math.round(Math.abs(pa - pb) * 1000)} Wh` : `${fmt(Math.abs(pa - pb), 2)} kWh`;

/**
 * The answer to "brisk or gentle?" for the two speeds typed, and the muted line
 * saying what it rests on. Redrawn on its own while the driver types, so it
 * takes the styles once and the speeds every time.
 */
export function pullAnswerHtml({ styles, used: pulls, dropped, from, to, per100At, source, massKg, points = [] }) {
  const per100 = Number.isFinite(to) ? per100At(to) : null;
  const c = compareStyles({ styles, from, to, per100, massKg });
  const basis = `From all your driving: ${count(pulls, "pull-away", "pull-aways")}` +
    (styles.gentle && styles.brisk ? `, gentle ${fmt(styles.gentle.accel, 1)} m/s², brisk ${fmt(styles.brisk.accel, 1)} m/s²` : "") +
    (c ? `. Cruising at ${fmt(to, 0)} km/h costs ${fmt(per100, 1)} kWh/100 km` +
      (source === "physics" ? ", from the physics settings, not your driving" : "") : "") + ".";
  const droppedLine = dropped ? ` ${count(dropped, "pull-away", "pull-aways")} left out as unusable.` : "";
  if (!c) return `<p>${esc(pullReason(styles, from, to))}</p><p class="muted">${esc(basis)}</p>${droppedLine ? `<p class="muted">${esc(droppedLine)}</p>` : ""}`;
  const [gentle, brisk] = c.rows;
  // Both clauses are derived from the printed figures, so they can never contradict them.
  const gentleP = printedKwh(gentle.kwh), briskP = printedKwh(brisk.kwh);
  const same = energyWh(gentle.kwh) === energyWh(brisk.kwh);
  const cheaper = gentleP <= briskP ? gentle : brisk;
  const order = cheaper === brisk ? [brisk, gentle] : [gentle, brisk];
  const gentleSec = Math.round(gentle.totalSeconds), briskSec = Math.round(brisk.totalSeconds);
  const quicker = gentleSec === briskSec ? null : gentleSec < briskSec ? gentle : brisk;
  const timeDiff = Math.abs(gentleSec - briskSec);
  const timing = quicker === null ? "they arrive together" : `${quicker.style} arrives ${fmt(timeDiff, 0)} s sooner`;
  const answer = `${fmt(c.from, 0)} → ${fmt(c.to, 0)} km/h, to the same point ${fmt(c.distanceM, 0)} m on: ` +
    order.map(styleLeg).join(" · ") + " — " +
    (same ? `the same energy either way, and ${timing}`
      : `${cheaper.style} uses ${energyDiffText(gentleP, briskP)} less and ${timing}`) + ".";
  const explanation = "Which style wins depends on the speed you end at: the faster you then cruise, the more the brisk pull-away's head start costs. The starting speed only changes how big the difference is.";
  // Where the pull-aways behind the medians were actually measured, and a flag when the typed target sits outside it.
  const v1s = points.map(p => p.v1);
  const q25 = quantile(v1s, 0.25), q75 = quantile(v1s, 0.75);
  const range = q25 != null && q75 != null ? `, measured mostly between ${fmt(q25, 0)} and ${fmt(q75, 0)} km/h` : "";
  const guess = q25 != null && q75 != null && (to < q25 || to > q75)
    ? " Your pull-aways rarely reach this speed, so this answer is a guess." : "";
  const hedge = `From your median gentle and brisk pull-aways${range}, so a hill or a headwind moves the dots more than the answer.${guess}`;
  return `<p class="pull-sentence">${answer}</p><p class="muted">${esc(basis)}</p>${droppedLine ? `<p class="muted">${esc(droppedLine)}</p>` : ""}<p class="muted">${esc(explanation)}</p><p class="muted">${esc(hedge)}</p>`;
}

/**
 * The whole "Brisk or gentle?" block: the two speeds, the answer, and every
 * usable pull-away as a dot. The form is drawn once and left alone while the
 * driver types - only the answer is written again.
 */
export function pullHtml(args) {
  const { points, from, to } = args;
  const field = (key, label, value) => `<label>${label}
    <input type="number" data-pull="${key}" min="0" max="${SPEED_CEILING}" step="1" inputmode="numeric"
      value="${Number.isFinite(value) ? fmt(value, 0) : ""}" aria-label="${label} speed, km/h"> km/h</label>`;
  return `<section class="evidence-panel pull-compare" id="coachPull">
    <h3>Brisk or gentle?</h3>
    <p class="muted">All your driving, not just this period.</p>
    <div class="pull-fields">${field("from", "from", from)}${field("to", "to", to)}</div>
    <div class="pull-answer">${pullAnswerHtml(args)}</div>
    ${points.length ? dotChart(points.map(p => ({ accel: p.accel, cost: p.eta, style: p.style })), "kWh per kWh gained") + STYLE_KEY : ""}
  </section>`;
}

const upPanel = s => `<section class="evidence-panel" id="${situationId(s)}">
  <h3>${situationName(s)} · ${s.count}</h3>${dotChart(s.points)}
  <p>${s.from}→${s.to}: brisk ${energyWh(s.styles.brisk.kwh)} · gentle ${energyWh(s.styles.gentle.kwh)}</p>
  <p class="muted">gentle ${fmt(s.styles.gentle.accel, 1)} m/s² · brisk ${fmt(s.styles.brisk.accel, 1)} m/s²</p></section>`;

const brakedCell = v => v === 0 ? "never" : share(v);
const liftCell = v => v == null ? "never braked" : `${fmt(v, 0)} s before`;

const downPanel = s => {
  const pressed = Math.round(s.you.brakedShare * s.count);
  const negligible = barelyLost(s.you.brakeKwh) && barelyLost(s.best.brakeKwh);
  const strip = negligible
    ? `<span style="flex: ${s.count - pressed}; background: var(--line)"></span><span style="flex: ${pressed}; background: var(--neutral)"></span>`
    : `<span class="good" style="flex: ${s.count - pressed}"></span><span class="bad" style="flex: ${pressed}"></span>`;
  const caption = negligible
    ? "the brake cost almost nothing on each slow-down — regen did most of the work"
    : `${s.count - pressed} on regen alone · ${pressed} used the brake`;
  return `<section class="evidence-panel" id="${situationId(s)}">
  <h3>${situationName(s)} · ${s.count}</h3>
  <div class="split" aria-hidden="true">${strip}</div>
  <p class="muted">${caption}</p>
  <div class="scroll"><table><tr><th></th><th>you</th><th>your best quarter</th></tr>
    <tr><td>braked</td><td>${brakedCell(s.you.brakedShare)}</td><td>${brakedCell(s.best.brakedShare)}</td></tr>
    <tr><td>lift-off</td><td>${liftCell(s.you.liftSeconds)}</td><td>${liftCell(s.best.liftSeconds)}</td></tr>
    <tr><td>brake loss</td><td>${energyWh(s.you.brakeKwh)}</td><td>${energyWh(s.best.brakeKwh)}</td></tr></table></div>
  <p class="muted">Best quarter = the slow-downs that lost least to the brakes.</p></section>`;
};

const byBand = (a, b) => a.from - b.from || a.toStop - b.toStop;

/** The panels behind a phase bar: every situation of its kind, the ones too small to judge dimmed. */
export function situationsHtml(c, kind) {
  const found = [...c.situations, ...c.small].filter(s => s.kind === kind);
  if (!found.length) return kind === "up"
    ? `<p class="muted">No pull-aways close to 0→30, 0→50, 30→70, 50→90, 70→110 or 90→130 km/h here.</p>`
    : `<p class="muted">No slow-downs from 30 km/h or more with brake-pedal readings here.</p>`;
  const panels = kind === "up" ? found.sort((a, b) => a.from - b.from || a.to - b.to) : found.sort(byBand);
  return panels.map(s => !s.enough ? small(s) : kind === "up" ? upPanel(s) : downPanel(s)).join("");
}

const meanTemp = list => {
  const known = list.map(s => s.outsideTemp).filter(Number.isFinite);
  return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
};

/**
 * The period against its usual periods: the median of each figure over the ones
 * with drives. [usual] is { km, energy, per100, regenShare, temp }, each a list.
 * A week away from the car is excluded from the usual km, not counted as 0.
 */
export function consumptionHtml(now, usual) {
  const mid = key => median(usual[key] ?? []);
  const row = (label, key, show) => `<tr><td>${label}</td><td>${show(now[key])}</td><td>${show(mid(key))}</td></tr>`;
  const km = v => v == null ? "–" : `${fmt(v, 0)} km`;
  return `<section class="evidence-panel"><h3>This period and your usual</h3>
    <div class="scroll"><table><tr><th></th><th>now</th><th>usual</th></tr>` +
    row("distance", "km", km) +
    row("energy", "energy", v => v == null ? "–" : `${fmt(v, 1)} kWh`) +
    row("consumption", "per100", v => v == null ? "–" : `${fmt(v, 1)} kWh/100 km`) +
    row("regen back", "regenShare", v => v == null ? "–" : share(v)) +
    row("outside", "temp", v => v == null ? "–" : `${fmt(v, 0)} °C`) +
    `</table></div></section>`;
}

/**
 * "This week: heading for ~77 km · usually 77–156 km"; outside the usual range it says so instead of
 * widening the range. A range whose ends print the same (a single earlier period to compare with)
 * collapses to one figure - "usually 170 km" - rather than the duplicate-looking "170–170 km".
 */
export function forecastLine(f, kind) {
  if (!f) return "";
  const base = `${kind === "month" ? "This month" : "This week"}: heading for ~${fmt(f.km, 0)} km`;
  if (f.low == null || f.high == null) return base;
  const low = fmt(f.low, 0), high = fmt(f.high, 0);
  const range = low === high ? `${low} km` : `${low}–${high} km`;
  const outside = f.km < f.low ? "below" : f.km > f.high ? "above" : null;
  return `${base} · ${outside ? `${outside} your usual ${range}` : `usually ${range}`}`;
}

// ---------- the whole tab ----------

/**
 * The Coach tab for one period, as HTML, and the evidence each bar or tip opens.
 * [list] is the period's drives and [all] every drive, both already past visible().
 */
export function coachHtml({ list, all, kind, start, now, regenEfficiency, model = NO_MODEL, massKg, pull = PULL_RANGE }) {
  const opts = { regenEfficiency };
  const c = coach(list, opts);
  const t = totals(list);
  const history = measure => periodHistory(all, kind, start, measure);
  const past = history(l => ({ ...totals(l), temp: meanTemp(l), score: coach(l, opts).score }));
  const usual = key => past.map(v => v?.[key] ?? null);
  const temp = meanTemp(list);
  const p = phases(c, { per100: t.per100, usualPer100: usual("per100"), temp, usualTemps: usual("temp") });
  const f = forecast({ kind, start, now, km: t.km, per100: t.per100,
    usualKmPerDay: history((l, at) => kmPerDay(l, kind, at)).map(v => v ?? 0) });
  const worth = tip => worthLine(tip, f ? f.km : t.km, t.per100, f ? kind : null);
  const ahead = forecastLine(f, kind);
  const html = (ahead ? `<p class="forecast">${esc(ahead)}</p>` : "") +
    `<div class="coach-row">${dialHtml(c, versusUsual(c.score, usual("score"), "higher"), list.length)}` +
    phasesHtml(p, kind) + tipsHtml(c, worth) + `</div>` +
    `<div class="evidence" id="coachEvidence" hidden></div>`;
  // The pull styles read every stored drive and the anticipation panels the period's - neither is in
  // coach() means both paths call episodesOf() again.
  // hand the episodes out of coach() if a big enough library ever makes the draw drag.
  const style = pullStyles(episodesOf(all).up, { massKg });
  const pullArgs = { ...style, ...pull, per100At: model.per100, source: model.source, massKg };
  return {
    html, pullArgs,
    evidence: {
      pullingAway: pullHtml(pullArgs) + situationsHtml(c, "up"),
      slowingDown: situationsHtml(c, "down"),
      anticipation: anticipationHtml(liftEffect(episodesOf(list).down)),
      consumption: consumptionHtml({ ...t, temp }, {
        km: usual("km"), energy: usual("energy"), per100: usual("per100"), regenShare: usual("regenShare"), temp: usual("temp"),
      }),
    },
  };
}

// One Esc listener for the page, closing whatever the latest drawing has open.
let closeOpen = null, listening = false;

/**
 * Draws the tab into [el] and wires it: a bar or a tip opens its evidence under
 * the dial row, one at a time; a second click or Esc closes it. While stored
 * drives are being measured again, the figures would be the old ones, so the
 * tab says so instead.
 */
export function drawCoach(el, { measuring = false, onPull = () => {}, ...args }) {
  closeOpen = null;
  if (measuring) {
    el.innerHTML = `<p class="coach-busy">Working out your driving…</p>`;
    return;
  }
  const { html, evidence, pullArgs } = coachHtml(args);
  el.innerHTML = html;
  const area = el.querySelector("#coachEvidence");
  const buttons = [...el.querySelectorAll("[data-evidence]")];
  let open = null;
  const show = (button, on) => button.setAttribute("aria-expanded", String(on));
  closeOpen = () => {
    open = null;
    area.hidden = true;
    area.replaceChildren();
    buttons.forEach(b => show(b, false));
  };
  // Assigned, not added: the tab is drawn again on every render, and the old listener goes with the old HTML.
  el.onclick = e => {
    const button = e.target.closest("[data-evidence]");
    if (!button) return;
    const key = `${button.dataset.evidence}|${button.dataset.situation ?? ""}`;
    if (open === key) return closeOpen();
    closeOpen();
    open = key;
    area.innerHTML = evidence[button.dataset.evidence];
    area.hidden = false;
    show(button, true);
    const panel = button.dataset.situation && document.getElementById(button.dataset.situation);
    (panel || area).scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  // Typing a speed writes the answer again and nothing else: redrawing the two fields would take the
  // caret with them, and the dots and the situation panels below have not changed.
  let range = { from: pullArgs.from, to: pullArgs.to };
  el.oninput = e => {
    const key = e.target.dataset.pull;
    if (!key) return;
    const typed = Number(e.target.value);
    range = { ...range, [key]: e.target.value !== "" && Number.isFinite(typed) ? typed : null };
    onPull(range);
    const answer = el.querySelector(".pull-answer");
    if (answer) answer.innerHTML = pullAnswerHtml({ ...pullArgs, ...range });
  };
  if (!listening) {
    listening = true;
    document.addEventListener("keydown", e => { if (e.key === "Escape") closeOpen?.(); });
  }
}
