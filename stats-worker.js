// Parsing a month of logs takes seconds; here it does not freeze the page.
import { parseGpx, splitDrives, continueCounters } from "./stats/gpx.js";
import { summarize, readable } from "./stats/summary.js";

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

// The calibration comes with the file: it goes into the measuring, so the page
// sends whatever the driver has set and a changed one rebuilds what it changed.
self.onmessage = async ({ data: { name, text, calibration } }) => {
  try {
    const fileId = await sha256(text);
    const drives = splitDrives(parseGpx(text));
    if (!drives.length) throw new Error("There is no drive in the file - only standing still or charging.");
    const summaries = drives.map((log, k) => {
      continueCounters(log);
      return summarize(log, { id: `${fileId}:${k}`, fileId, file: name, calibration });
    });
    if (!summaries.every(readable)) throw new Error("The track points have no times or no positions, so the drive cannot be placed.");
    self.postMessage({ name, fileId, summaries });
  } catch (e) {
    self.postMessage({ name, error: e.message });
  }
};
