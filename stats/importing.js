// Logs into the store, whatever they came through: a pick, a drop, a share or Drive.

import { sha256 } from "./num.js";
import { isChargingCsv, parseChargingCsv, sameSession, fullerSession } from "./charging-csv.js";

/**
 * Stores [files] (File objects, or { name, text }), adding to [summaries] and
 * [logged] in place. [summarize] reads a GPX, off the page's thread; [change]
 * writes to the store.
 *
 * A file can fail two ways, and they must not be confused. One that is simply
 * no log goes to [refused] and will not read better next week. One that met a
 * full disk or a crashed worker says nothing about the file: it comes back in
 * `retry`, as its index, so whoever holds it can try again.
 */
export async function importLogs(files, { summaries, logged, summarize, change, progress = () => {}, refused = () => {} }) {
  const fresh = [], retry = new Set();
  let skipped = 0, addedCharges = 0;
  for (const [k, f] of files.entries()) {
    progress(k, f);
    try {
      const text = typeof f.text === "function" ? await f.text() : f.text;
      if (isChargingCsv(text)) {
        let session;
        try {
          session = parseChargingCsv(text);
        } catch (e) {
          refused(f.name, e.message);
          continue;
        }
        const value = { ...session, fileId: await sha256(text), file: f.name };
        // A session rewritten while it ran is one session, whichever copy came first.
        const copy = logged.find(c => sameSession(c, value));
        if (copy && fullerSession(copy, value) >= 0) { skipped++; continue; }
        await change([...(copy ? [{ store: "charges", key: copy.fileId }] : []), { store: "charges", key: value.fileId, value }]);
        if (copy) logged.splice(logged.indexOf(copy), 1);
        logged.push(value);
        addedCharges++;
        continue;
      }
      if (/\.csv$/i.test(f.name)) { refused(f.name, "CSV is not a supported charging session file."); continue; }
      const result = await summarize(f.name, text);
      if (result.error) {
        if (result.crashed) retry.add(k);
        refused(f.name, result.error);
        continue;
      }
      if (summaries.some(o => o.fileId === result.fileId)) { skipped++; continue; }
      // Every copy of a drive is stored; visible() counts only the fullest one.
      await change([
        { store: "files", key: result.fileId, value: { name: f.name, text } },
        ...result.summaries.map(s => ({ store: "summaries", key: s.id, value: s })),
      ]);
      summaries.push(...result.summaries);
      fresh.push(...result.summaries.map(s => s.id));
    } catch (e) {
      retry.add(k);
      refused(f.name, e.message);
    }
  }
  return { fresh, retry, skipped, addedCharges };
}
