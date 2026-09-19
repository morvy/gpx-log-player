// The statistics page in a real browser, fed real logs through its own file input:
//   node scripts/coach-browser-check.mjs [logs dir] [screenshots dir]
// A dev check, not a test - real logs are somebody's movements, so they are read where they lie
// and the screenshots go wherever the second argument says, never into the repository.
// Needs Playwright installed globally (npm i -g playwright) and a Chromium it can start: CHROME
// names the browser binary when the one Playwright expects is not the one installed.
import { createServer } from "node:http";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { join, resolve, extname } from "node:path";
import { homedir, tmpdir } from "node:os";

const root = resolve(import.meta.dirname, "..");
const logs = resolve(process.argv[2] ?? join(root, "../android-auto-honda-e/logs/gpx"));
const shots = resolve(process.argv[3] ?? join(tmpdir(), "coach-browser-check"));
await mkdir(shots, { recursive: true });

const require = createRequire(import.meta.url);
const { chromium } = require(join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "playwright"));
const chrome = process.env.CHROME ?? join(homedir(), ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome");

// A static server over the repository: the page's modules and its worker need http, not file://.
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm", ".xsd": "application/xml" };
const server = createServer(async (req, res) => {
  const path = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!path.startsWith(root)) return res.writeHead(403).end();
  try {
    const body = await readFile(path);
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0, "127.0.0.1");
await new Promise(ok => server.once("listening", ok));
const base = `http://127.0.0.1:${server.address().port}/statistics.html`;

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failures++;
};

const browser = await chromium.launch(existsSync(chrome) ? { executablePath: chrome } : {});
// The service worker would answer later loads from its cache; this check wants the files on disk.
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
const page = await context.newPage();
const errors = [];
page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", e => errors.push(String(e)));

const TABS = ["coach", "battery", "charging", "trip", "patterns", "drives", "settings"];
const selected = () => page.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]')?.id);
const visiblePanels = () => page.evaluate(() => [...document.querySelectorAll('[role="tabpanel"]')].filter(p => !p.hidden).map(p => p.id));
const openTab = async name => {
  await page.evaluate(n => { location.hash = n; }, name);
  await page.waitForFunction(n => !document.getElementById(`panel-${n}`).hidden, name);
  await page.waitForTimeout(300);
};
const noSideScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

// ---------- import ----------

await page.goto(base);
const files = (await readdir(logs)).filter(f => f.endsWith(".gpx")).map(f => join(logs, f));
console.log(`importing ${files.length} logs from ${logs}`);
await page.setInputFiles("#fileInput", files);
await page.waitForFunction(() => /^Added/.test(document.getElementById("importStatus").textContent), null, { timeout: 600000 });
console.log(await page.textContent("#importStatus"));
check(!(await page.isHidden("#app")), "the tabs show once drives are stored");

// ---------- tabs by hash and by keyboard ----------

check(await selected() === "tab-coach", "an empty hash opens Coach");
check(JSON.stringify(await visiblePanels()) === '["panel-coach"]', "only the Coach panel is visible");
await page.goto(`${base}?load=1#charging`);
await page.waitForSelector("#app:not([hidden])");
check(await selected() === "tab-charging", "#charging opens Charging on load");
await page.goto(`${base}?load=2#nonsense`);
await page.waitForSelector("#app:not([hidden])");
check(await selected() === "tab-coach", "an unknown hash opens Coach");
await openTab("patterns");
await openTab("drives");
await page.goBack();
await page.waitForFunction(() => !document.getElementById("panel-patterns").hidden);
check(await selected() === "tab-patterns", "Back returns to the tab before");

await openTab("coach");
await page.focus("#tab-coach");
const key = async (k, expect, what) => {
  await page.keyboard.press(k);
  // The hash changes at once, the panels only when hashchange has run: wait for the panel.
  await page.waitForFunction(n => location.hash === `#${n}` && !document.getElementById(`panel-${n}`).hidden, expect);
  const focused = await page.evaluate(() => document.activeElement.id);
  const state = [focused, await selected(), ...(await visiblePanels())].join(" ");
  check(state === `tab-${expect} tab-${expect} panel-${expect}`, `${what} (${state})`);
};
await key("ArrowRight", "battery", "ArrowRight moves to Battery");
await key("End", "settings", "End jumps to Settings");
await key("ArrowRight", "coach", "ArrowRight wraps from Settings to Coach");
await key("ArrowLeft", "settings", "ArrowLeft wraps from Coach to Settings");
await key("Home", "coach", "Home jumps to Coach");
const tabIndexes = await page.evaluate(() => [...document.querySelectorAll('[role="tab"]')].map(t => t.tabIndex));
check(tabIndexes.filter(i => i === 0).length === 1, "only the open tab is in the tab order");

// ---------- charts are drawn at their box's size when their tab opens ----------

for (const [tab, box] of [["battery", "#batteryCharts"], ["charging", "#chargeCurve"], ["patterns", "#patternCharts"]]) {
  await openTab(tab);
  const sizes = await page.evaluate(sel => [...document.querySelectorAll(`${sel} .uplot`)].map(u => ({
    width: u.getBoundingClientRect().width, box: u.parentNode.clientWidth,
  })), box);
  // Under three periods of readings the Battery tab draws the period's values as bars, not charts.
  const bars = await page.locator(`${box} .bars`).count();
  check((sizes.length > 0 || bars > 0) && sizes.every(s => s.width > 0 && Math.abs(s.width - s.box) <= 2),
    `${tab}: ${sizes.length} chart(s), each as wide as its box (${sizes.map(s => Math.round(s.width)).join(", ")})` +
    (bars ? `, and ${bars} bar picture(s)` : ""));
}
for (const [tab, map] of [["charging", "#chargeMap"], ["patterns", "#placeMap"]]) {
  await openTab(tab);
  const size = await page.evaluate(sel => {
    const el = document.querySelector(sel);
    return el.hidden ? null : { w: el.clientWidth, h: el.clientHeight, tiles: el.querySelectorAll(".leaflet-tile").length };
  }, map);
  check(size === null || (size.w > 0 && size.h > 0), `${tab}: map ${size ? `${size.w}×${size.h}, ${size.tiles} tiles` : "not shown for these drives"}`);
}

// ---------- the Coach tab ----------

await openTab("coach");
const coachText = await page.textContent("#coachView");
check(/driving score/.test(coachText), `the dial is drawn (${(await page.textContent(".dial")).replace(/\s+/g, " ").trim()})`);
check(await page.locator(".phase").count() === 4, "four phase bars");
console.log(`  phases: ${(await page.locator(".phase").allTextContents()).map(t => t.replace(/\s+/g, " ").trim()).join(" | ")}`);
console.log(`  tips: ${(await page.locator(".tip").allTextContents()).map(t => t.replace(/\s+/g, " ").trim()).join(" | ") || "(none)"}`);
console.log(`  forecast: ${(await page.locator(".forecast").allTextContents()).join("") || "(none this period)"}`);

const expanded = () => page.evaluate(() => [...document.querySelectorAll('[data-evidence][aria-expanded="true"]')].length);
const areaOpen = () => page.evaluate(() => !document.getElementById("coachEvidence").hidden);
const buttons = page.locator("#coachView [data-evidence]");
for (let i = 0; i < await buttons.count(); i++) {
  const b = buttons.nth(i);
  const name = (await b.textContent()).replace(/\s+/g, " ").trim().slice(0, 40);
  await b.click();
  const opened = await areaOpen() && await b.getAttribute("aria-expanded") === "true" && await expanded() === 1;
  const panels = await page.locator("#coachEvidence > *").count();
  await b.click();
  const closedByClick = !(await areaOpen()) && await expanded() === 0;
  await b.click();
  await page.keyboard.press("Escape");
  const closedByEsc = !(await areaOpen()) && await b.getAttribute("aria-expanded") === "false";
  check(opened && panels > 0 && closedByClick && closedByEsc, `"${name}" opens ${panels} panel(s), closes by click and by Esc`);
}
const phase = page.locator(".phase");
await phase.nth(0).click();
await phase.nth(1).click();
check(await expanded() === 1 && await phase.nth(1).getAttribute("aria-expanded") === "true", "one evidence view open at a time");
await page.screenshot({ path: join(shots, "coach-open-1280.png"), fullPage: true });
await page.keyboard.press("Escape");

// All drives: enough of them for tips, and for the pull-away dot charts.
await page.click('[data-kind="all"]');
await page.waitForFunction(() => document.getElementById("periodLabel").textContent === "All drives");
const summary = async () => {
  console.log(`  dial: ${(await page.textContent(".dial")).replace(/\s+/g, " ").trim()}`);
  console.log(`  phases: ${(await page.locator(".phase").allTextContents()).map(t => t.replace(/\s+/g, " ").trim()).join(" | ")}`);
  console.log(`  tips: ${(await page.locator(".tip").allTextContents()).map(t => t.replace(/\s+/g, " ").trim()).join(" | ") || "(none)"}`);
};
await summary();
await page.click('.phase[data-evidence="pullingAway"]');
const dots = await page.locator("#coachEvidence svg.dots circle").count();
const upGroups = await page.locator("#coachEvidence .evidence-panel:not(.small)").count();
check(upGroups === 0 || dots > 0, `all drives: ${upGroups} pull-away situation(s) drawn with ${dots} dots`);
await page.screenshot({ path: join(shots, "coach-all-pulling-1280.png"), fullPage: true });
await page.keyboard.press("Escape");

// ---------- Anticipation's own evidence, and "Brisk or gentle?" ----------

const flat = s => s.replace(/\s+/g, " ").trim();
await page.click('.phase[data-evidence="anticipation"]');
const lift = await page.evaluate(() => ({
  splits: document.querySelectorAll("#coachEvidence svg.dots line.split-line").length,
  tables: document.querySelectorAll("#coachEvidence table").length,
  said: [...document.querySelectorAll("#coachEvidence .evidence-panel:not(.small) > p:not(.muted)")]
    .map(p => p.textContent.replace(/\s+/g, " ").trim()),
}));
check(lift.splits > 0 && lift.tables === 0 && lift.said.length === lift.splits,
  `Anticipation opens ${lift.splits} lift-off chart(s) with a split line and no slow-down table`);
console.log(`  anticipation: ${lift.said.join(" | ")}`);
await page.screenshot({ path: join(shots, "coach-anticipation-1280.png"), fullPage: true });
await page.keyboard.press("Escape");

await page.click('.phase[data-evidence="pullingAway"]');
await page.fill('#coachPull [data-pull="from"]', "0");
await page.fill('#coachPull [data-pull="to"]', "80");
await page.waitForFunction(() => /80 km\/h/.test(document.querySelector("#coachPull .pull-answer").textContent));
const pullAnswer = flat(await page.textContent("#coachPull .pull-answer"));
check(/brisk/.test(pullAnswer) && /gentle/.test(pullAnswer) && /\d+ (k?Wh)/.test(pullAnswer) && /m on:/.test(pullAnswer),
  `the pull-away answer names both styles and an energy: ${pullAnswer}`);
const pullDots = await page.locator("#coachPull svg.dots circle").count();
check(pullDots > 0 && await page.locator("#coachEvidence .evidence-panel:not(.pull-compare)").count() > 0,
  `all your driving: ${pullDots} pull-aways as dots, with the situation panels still under them`);
await page.screenshot({ path: join(shots, "coach-pull-1280.png"), fullPage: true });

// The two speeds are this browser's, not this drawing's: they survive a reload.
await page.fill('#coachPull [data-pull="to"]', "100");
await page.waitForFunction(() => /100 km\/h/.test(document.querySelector("#coachPull .pull-answer").textContent));
await page.reload();
await page.waitForSelector(".phase");
await page.click('.phase[data-evidence="pullingAway"]');
check(await page.inputValue('#coachPull [data-pull="to"]') === "100", "the speeds typed are there again after a reload");
await page.fill('#coachPull [data-pull="to"]', "80");
await page.keyboard.press("Escape");
await page.click('[data-kind="all"]');
await page.waitForFunction(() => document.getElementById("periodLabel").textContent === "All drives");

const tips = page.locator(".tip");
for (let i = 0; i < await tips.count(); i++) {
  const tip = tips.nth(i);
  const id = await tip.getAttribute("data-situation");
  await tip.click();
  check(await page.locator(`#coachEvidence #${id}`).count() === 1 && await tip.getAttribute("aria-expanded") === "true",
    `tip ${i + 1} opens the evidence with its own panel (${id})`);
  await page.keyboard.press("Escape");
}
await page.click('[data-kind="week"]');
await page.waitForFunction(() => document.getElementById("periodLabel").textContent !== "All drives");

// ---------- the Trip tab ----------

await openTab("charging");
check(await page.locator("#panel-charging [data-trip], #panel-charging #tripPlanner").count() === 0,
  "the Charging tab no longer holds the trip calculator");
await openTab("trip");
await page.fill('#tripPlanner [data-trip="speeds"]', "95, 110, 130");
await page.waitForFunction(() => document.querySelectorAll("#tripPlanner tr.best").length === 1);
const tint = await page.evaluate(() => getComputedStyle(document.querySelector("#tripPlanner tr.best td")).backgroundColor);
check(tint === "rgb(255, 241, 234)", `the recommended row is tinted (${tint})`);
const clean = s => s.replace(/\s+/g, " ").trim();
const recommended = clean(await page.textContent("#tripPlanner .trip-recommend"));
check(/^Recommended \d+ km\/h fastest arrival/.test(recommended), `the Recommended panel: ${recommended}`);
const tripRows = (await page.locator("#tripPlanner .trip-table tr").allTextContents()).slice(1).map(clean);
check(["95", "110", "130"].every(v => tripRows.some(r => r.startsWith(`${v} km/h`))), `a row for each typed speed:\n  ${tripRows.join("\n  ")}`);
console.log(`  basis: ${clean(await page.textContent("#tripPlanner .trip-pair > .trip-panel:last-child p"))}`);
const shape = await page.evaluate(() => {
  const box = el => el.getBoundingClientRect();
  const [rec, basis] = [...document.querySelectorAll("#tripPlanner .trip-pair > .trip-panel")].map(box);
  return {
    rec, basis,
    table: box(document.querySelector("#tripPlanner .trip-table")),
    right: box(document.querySelector("#tripPlanner .trip-right")),
    labels: [...document.querySelectorAll("#tripPlanner .trip-grid label")].map(l => box(l).height),
    inputs: [...document.querySelectorAll('#tripPlanner .trip-grid input[type="number"]')].map(box),
  };
});
check(Math.abs(shape.rec.top - shape.basis.top) < 1 && Math.abs(shape.rec.height - shape.basis.height) < 1 &&
  Math.abs(shape.rec.width - shape.basis.width) < 2 && shape.basis.left > shape.rec.right,
  `Recommended and what it rests on side by side, 50:50 and of one height (${Math.round(shape.rec.width)} and ${Math.round(shape.basis.width)} px)`);
check(shape.table.top > shape.rec.bottom && Math.abs(shape.table.width - shape.right.width) < 1,
  "the table runs across the whole right column, under the two panels");
check(Math.max(...shape.labels) < 1.5 * Math.min(...shape.labels), `every trip label fits one line (${shape.labels.map(Math.round).join(", ")} px high)`);
check(shape.inputs.every(b => Math.abs(b.left - shape.inputs[0].left) < 1 && Math.abs(b.width - shape.inputs[0].width) < 1),
  "the trip inputs line up in one column of one width");

// A negative temperature, typed one keystroke at a time: "-" alone makes a number input report "",
// which must not make the field's own redraw wipe it before the "5" lands.
const tempInput = '#tripPlanner [data-trip="temp"]';
await page.fill(tempInput, "");
await page.keyboard.type("-5", { delay: 30 });
check(await page.inputValue(tempInput) === "-5", "a negative temperature can be typed, one keystroke at a time");
await page.waitForTimeout(200);
const expectedRange = await page.evaluate(async () => {
  const { fmt } = await import("./stats/coach-view.js");
  const { TEMP_NEAR } = await import("./stats/trip.js");
  const signed = v => fmt(v, 0).replace("-", "−");
  return `from ${signed(-5 - TEMP_NEAR)} to ${signed(-5 + TEMP_NEAR)} °C`;
});
const basis = clean(await page.textContent("#tripPlanner .trip-pair > .trip-panel:last-child p"));
check(basis.includes(expectedRange) || /all your driving/i.test(basis),
  `the curve caption follows the typed temperature: ${basis}`);

await page.reload();
await page.waitForSelector('#tripPlanner [data-trip="speeds"]');
check(await page.inputValue('#tripPlanner [data-trip="speeds"]') === "95, 110, 130", "the speeds typed are there again after a reload");

// ---------- every tab at both widths ----------

// The five detail tabs share one look: four big numbers (Settings has three groups of fields instead),
// no uPlot hover legend, and no bordered card anywhere but in the Coach tab's "All habits".
const DETAIL_TABS = ["battery", "charging", "patterns", "drives", "settings"];
const detailLook = async (tab, width) => {
  const look = await page.evaluate(n => {
    const panel = document.getElementById(`panel-${n}`);
    return {
      stats: [...panel.querySelectorAll(".stat-row .stat")].map(s => s.innerText.replace(/\s+/g, " ").trim()),
      legends: [...document.querySelectorAll(".u-legend")].filter(l => l.getClientRects().length > 0).length,
      // Folded or open: a card outside "All habits" has no border to show either way.
      bordered: [...document.querySelectorAll(".habit")]
        .filter(h => !h.closest("#allHabits") && getComputedStyle(h).borderLeftWidth !== "0px").length,
      groups: [...panel.querySelectorAll(".panel > h2:first-child")].map(h => h.textContent),
      fields: panel.querySelectorAll("input[data-field]").length,
    };
  }, tab);
  const where = `${tab} at ${width} px`;
  if (tab === "settings") {
    check(look.groups.join(" | ") === "Driving | Battery and charging | Physics" && look.fields === 24,
      `${where}: three groups (${look.groups.join(", ")}) with all ${look.fields} fields`);
  } else {
    check(look.stats.length === 4, `${where}: four big numbers${width === 1280 ? `\n  ${look.stats.join("\n  ")}` : ""}`);
  }
  if (tab === "charging") check(look.stats.some(s => s.startsWith("Curve covers")), `${where}: the curve's coverage is a big number`);
  check(look.legends === 0, `${where}: no uPlot legend shown`);
  check(look.bordered === 0, `${where}: no bordered card outside the Coach tab's All habits`);
};

for (const width of [1280, 375]) {
  await page.setViewportSize({ width, height: 900 });
  for (const tab of TABS) {
    await openTab(tab);
    check(await noSideScroll(), `${tab} at ${width} px: no sideways scroll`);
    if (DETAIL_TABS.includes(tab)) await detailLook(tab, width);
    await page.screenshot({ path: join(shots, `${tab}-${width}.png`), fullPage: true });
  }
}
await openTab("coach");
await phase.nth(1).click();
check(await noSideScroll(), "coach evidence at 375 px: no sideways scroll");
await page.screenshot({ path: join(shots, "coach-open-375.png"), fullPage: true });
await page.keyboard.press("Escape");
for (const [key, name] of [["anticipation", "coach-anticipation-375.png"], ["pullingAway", "coach-pull-375.png"]]) {
  await page.click(`.phase[data-evidence="${key}"]`);
  check(await noSideScroll(), `coach ${key} evidence at 375 px: no sideways scroll`);
  await page.screenshot({ path: join(shots, name), fullPage: true });
  await page.keyboard.press("Escape");
}
await openTab("battery");
const narrow = await page.evaluate(() => [...document.querySelectorAll("#batteryCharts .uplot")].map(u => u.getBoundingClientRect().width));
check(narrow.every(w => w > 0 && w <= 375), `battery charts fit 375 px (${narrow.map(Math.round).join(", ")})`);
await page.setViewportSize({ width: 1280, height: 900 });

// ---------- the detail tabs' own pictures ----------

await openTab("battery");
const spread = await page.evaluate(() => {
  const box = [...document.querySelectorAll("#batteryCharts .panel")].find(p => /^Cell spread/.test(p.querySelector("h2").textContent));
  return box && { title: box.querySelector("h2").firstChild.textContent, bars: box.querySelectorAll(".bars").length,
    rows: box.querySelectorAll(".bars > .muted:nth-child(3n + 1)").length, charts: box.querySelectorAll(".uplot").length };
});
// "by week" once three weeks have resting readings; until then "this week" and one bar per charge range.
check(spread && (/, by /.test(spread.title) ? spread.charts === 1 && spread.bars === 0 : spread.bars === 1 && spread.rows === 5 && spread.charts === 0),
  `battery: "${spread?.title}" shows ${spread?.charts ? "its lines" : `${spread?.rows} bars`}`);
await page.click("#batteryMore summary");
console.log(`  folded: ${await page.textContent("#batteryMore summary")}`);
check(await page.locator("#batteryCards .habit").count() >= 3, "battery: the folded cards open with their figures");
await page.screenshot({ path: join(shots, "battery-more-1280.png"), fullPage: true });
await page.click("#batteryMore summary");

await openTab("drives");
const tick = page.locator("#driveRows input[type=checkbox]").first();
await tick.check();
check(await page.textContent("#openTicked") === "Open 1 ticked in player" && !(await page.isDisabled("#openTicked")),
  "drives: the button names the ticked drives");
await tick.uncheck();
check(await page.textContent("#openTicked") === "Open ticked in player" && await page.isDisabled("#openTicked"),
  "drives: with none ticked the button is off");

// ---------- a calibration change measures every drive again ----------

await openTab("settings");
const field = page.locator('#calFields input[data-field="regenEfficiency"]');
await field.fill("0.86");
await field.dispatchEvent("change");
await page.waitForFunction(() => /^Updating/.test(document.getElementById("importStatus").textContent));
check(/Working out your driving…/.test(await page.textContent("#coachView")), "the coach says it is working while drives are measured again");
await page.waitForFunction(() => /^Updated/.test(document.getElementById("importStatus").textContent), null, { timeout: 600000 });
check(/driving score/.test(await page.textContent("#coachView")), "the dial is back once they are");

check(errors.length === 0, `no console errors${errors.length ? `:\n  ${errors.join("\n  ")}` : ""}`);
console.log(`screenshots in ${shots}`);
await browser.close();
server.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);
