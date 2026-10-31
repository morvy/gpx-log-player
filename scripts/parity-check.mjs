// The player keeps its own copy of the rules the statistics use, so it can stay one file. This runs both
// in a real browser on the same generated logs: node scripts/parity-check.mjs
// A dev check, not a test: it needs Playwright installed globally (npm i -g playwright).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { join, resolve, extname } from "node:path";
import { gpxLog, steadyDrive } from "../tests/gpx-builder.mjs";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { chromium } = require(join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "playwright"));

const server = createServer(async (req, res) => {
  const path = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  try {
    const body = await readFile(path);
    res.writeHead(200, { "Content-Type": { ".html": "text/html", ".js": "text/javascript" }[extname(path)] ?? "text/plain" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0, "127.0.0.1");
await new Promise(ok => server.once("listening", ok));

const fields = { energy_kwh: ["Energy", "kWh"], energy_regen_kwh: ["Regen", "kWh"], soc_percent: ["Charge", "%"] };
// The app restarts twice: once marked, once only visible as the counters falling.
const restarted = gpxLog({ fields, points: steadyDrive({ seconds: 300, ev: k => {
  const run = k < 100 ? k : k < 200 ? k - 100 : k - 200;
  return { energy_kwh: run * 0.01, energy_regen_kwh: run * 0.001, soc_percent: 80 - k * 0.01 };
} }).map((p, k) => k === 100 ? { ...p, name: "Resumed", type: "resumed" } : p) });
// The same driving twice: the car's readings against more points of GPS alone.
const withCar = gpxLog({ fields, points: steadyDrive({ seconds: 100, ev: k => ({ energy_kwh: k * 0.01, energy_regen_kwh: 0, soc_percent: 80 }) }) });
const gpsOnly = gpxLog({ points: steadyDrive({ seconds: 300 }).map(({ t, lat, lon, speedMs }) => ({ t, lat, lon, speedMs })) });

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
const seen = await page.evaluate(async ({ restarted, withCar, gpsOnly }) => {
  const { parseGpx: parse, continueCounters } = await import("./stats/gpx.js");
  const { fuller: fullerStats } = await import("./stats/summary.js");
  const player = text => ({ ...parseGpx(text), file: "log" });
  const stats = text => { const log = parse(text); continueCounters(log); return log; };
  const figures = (log, n) => ({ n, energy: [...log.cols.energy_kwh], regen: [...log.cols.energy_regen_kwh], t: [...log.t], lat: [...log.lat] });
  const merged = merge([player(restarted)]), counted = stats(restarted);
  const summary = (points, energy, socStart) => ({ points, energy, socStart });
  return {
    player: figures(merged, merged.n), stats: figures(counted, counted.n),
    keptByPlayer: Math.sign(fuller(player(withCar), player(gpsOnly))),
    keptByStats: Math.sign(fullerStats(summary(101, 1, 80), summary(301, null, null))),
  };
}, { restarted, withCar, gpsOnly });
await browser.close();
server.close();

let failures = 0;
const check = (same, what) => { console.log(`${same ? "PASS" : "FAIL"} ${what}`); if (!same) failures++; };
for (const key of Object.keys(seen.player)) check(JSON.stringify(seen.player[key]) === JSON.stringify(seen.stats[key]), `${key} reads the same on both pages`);
check(seen.keptByPlayer === seen.keptByStats, "both pages keep the same copy of a drive");
process.exit(failures ? 1 : 0);
