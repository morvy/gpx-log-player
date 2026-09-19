// Prints what the coach makes of real GPX logs: node scripts/episodes-check.mjs drive1.gpx [drive2.gpx ...]
// A dev check, not a test - real logs are somebody's movements and stay out of the repository.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseGpx, splitDrives, continueCounters } from "../stats/gpx.js";
import { summarize, visible } from "../stats/summary.js";
import { coach } from "../stats/coach.js";

const summaries = process.argv.slice(2).flatMap(path => {
  try {
    const drives = splitDrives(parseGpx(readFileSync(path, "utf8")));
    if (!drives.length) console.log(`${basename(path)}: no drive - only standing still or charging`);
    return drives.map((log, k) => {
      continueCounters(log);
      const s = summarize(log, { id: `${path}:${k}`, fileId: path, file: basename(path) });
      const e = s.episodes;
      console.log(`${basename(path)} #${k}: ${s.km.toFixed(1)} km, ` +
        (e ? `${e.up.v0.length} speed-ups, ${e.down.v0.length} slow-downs` : "no power"));
      return s;
    });
  } catch (err) {
    console.log(`${basename(path)}: ${err.message}`);
    return [];
  }
});

const kept = visible(summaries);
console.log(`${kept.length}/${summaries.length} drives kept after dedup`);

// Over a drive the car slows about as often as it speeds up, so a ratio far from 1
// means one detector (up or down) is dropping episodes the other one catches.
const ups = kept.reduce((n, s) => n + (s.episodes ? s.episodes.up.v0.length : 0), 0);
const downs = kept.reduce((n, s) => n + (s.episodes ? s.episodes.down.v0.length : 0), 0);
console.log(`balance: ${ups} speed-ups, ${downs} slow-downs (${(downs / ups).toFixed(2)} per speed-up)`);

// Too few stops leaves the to-stop slow-down groups empty; too few presses leaves the best quarter nothing to show.
const sumDown = key => kept.reduce((n, s) => n + (s.episodes ? s.episodes.down[key].filter(v => v === 1).length : 0), 0);
console.log(`slow-downs: ${sumDown("toStop")} to a stop, ${sumDown("braked")} with a press`);

console.dir(coach(kept), { depth: 4 });
