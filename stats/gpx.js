// GPX without DOMParser, which Web Workers do not have. Reads what the
// player's parseGpx (index.html) reads, into the same shape.

import { ok, firstValid, lastValid } from "./num.js";

export const NS_EV = "urn:dev.moped:ev-gpx:1";
export const NS_TPX = "http://www.garmin.com/xmlschemas/TrackPointExtension/v2";

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export const decode = s => s.indexOf("&") < 0 ? s : s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (m, e) =>
  e[0] !== "#" ? ENTITIES[e] ?? m : String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))));

const TAG = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=>\/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>/g;
const ATTR = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * Calls onOpen(name, attrs, selfClosing), onText(text) and onClose(name) for
 * [xml] in document order; a self-closing tag gets onOpen then onClose.
 * GPX uses no DTDs or internal entities.
 */
export function tokenize(xml, { onOpen, onText, onClose }) {
  TAG.lastIndex = 0;
  let last = 0;
  for (let m; (m = TAG.exec(xml)); last = TAG.lastIndex) {
    if (m.index > last) onText(decode(xml.slice(last, m.index)));
    if (m[5] !== undefined) onText(m[5]);
    else if (m[2] && m[1]) onClose(m[2]);
    else if (m[2]) {
      const attrs = {};
      for (const a of m[3].matchAll(ATTR)) attrs[a[1]] = decode(a[2] ?? a[3]);
      onOpen(m[2], attrs, m[4] === "/");
      if (m[4] === "/") onClose(m[2]);
    }
  }
  if (last < xml.length) onText(decode(xml.slice(last)));
}

const ROOT_SCOPE = { "": "" };

/** A log in the player's shape: arrays by point, readings by name. */
export function parseGpx(text) {
  const unreadable = () => new Error("This is not a readable GPX file.");
  const stack = [], pts = [], key = {};
  let vehicle = null, name = "", pt = null, buf = "";
  tokenize(text, {
    onOpen(qname, attrs) {
      const parent = stack.length ? stack[stack.length - 1].scope : ROOT_SCOPE;
      let scope = parent;
      for (const a in attrs) {
        if (a !== "xmlns" && !a.startsWith("xmlns:")) continue;
        if (scope === parent) scope = { ...parent };
        scope[a === "xmlns" ? "" : a.slice(6)] = attrs[a];
      }
      const colon = qname.indexOf(":");
      const ns = colon < 0 ? scope[""] : scope[qname.slice(0, colon)] ?? "";
      const local = colon < 0 ? qname : qname.slice(colon + 1);
      stack.push({ qname, ns, local, scope });
      buf = "";
      if (local === "trkpt") pt = { lat: Number(attrs.lat), lon: Number(attrs.lon), t: NaN, ev: {} };
      else if (ns === NS_EV && local === "field" && attrs.id) key[attrs.id] = { label: attrs.label ?? attrs.id, unit: attrs.unit ?? "" };
    },
    onText(s) { buf += s; },
    onClose(qname) {
      const el = stack.pop();
      if (!el || el.qname !== qname) throw unreadable();
      const parent = stack.length ? stack[stack.length - 1].local : "";
      if (el.local === "trkpt") { if (pt) pts.push(pt); pt = null; }
      else if (pt && el.ns === NS_EV) {
        if (el.local === "cells_v") pt.cells = buf.trim(); else pt.ev[el.local] = parseFloat(buf);
      } else if (pt && el.ns === NS_TPX) {
        if (el.local === "speed") pt.gpsSpeed = Number(buf) * 3.6; else if (el.local === "course") pt.course = Number(buf);
      } else if (pt && parent === "trkpt") {
        if (el.local === "ele") pt.ele = Number(buf);
        else if (el.local === "time") pt.t = Date.parse(buf);
        else if (el.local === "speed") pt.gpsSpeed = Number(buf) * 3.6;   // GPX 1.0 files, from before the extension
        else if (el.local === "name" || el.local === "desc" || el.local === "type") pt[el.local] = buf;
      } else if (el.ns === NS_EV && el.local === "vehicle") vehicle = buf.trim();
      else if (el.local === "name" && parent === "trk") name = buf;
      buf = "";
    },
  });
  if (stack.length) throw unreadable();

  const n = pts.length;
  if (n < 2) throw new Error("The file has fewer than two track points.");
  const lat = new Float64Array(n), lon = new Float64Array(n), t = new Float64Array(n);
  const cols = {};
  const col = id => cols[id] || (cols[id] = new Float64Array(n).fill(NaN));
  const cells = new Array(n).fill(null);
  // Point names are events only in a file the app wrote; other tools name points for their own reasons.
  const ours = Object.keys(key).length > 0, carEvents = [];
  let lastText = null, lastCells = null;
  pts.forEach((p, i) => {
    lat[i] = p.lat; lon[i] = p.lon; t[i] = p.t;
    if (p.ele !== undefined) col("ele")[i] = p.ele;
    if (p.gpsSpeed !== undefined) col("gps_speed")[i] = p.gpsSpeed;
    if (p.course !== undefined) col("course")[i] = p.course;
    for (const id in p.ev) col(id)[i] = p.ev[id];
    if (p.cells !== undefined) {
      if (p.cells !== lastText) { lastText = p.cells; lastCells = Float64Array.from(p.cells.split(/\s+/), Number); }
      cells[i] = lastCells;
    }
    if (ours && p.type) carEvents.push({ i, name: p.name, desc: p.desc, type: p.type });
  });
  return { n, lat, lon, t, cols, cells, key, vehicle, name, carEvents };
}

/** Points [a]..[b] of a log as a log of their own. */
function slice(log, a, b) {
  const cols = {};
  for (const id in log.cols) cols[id] = log.cols[id].slice(a, b + 1);
  return {
    ...log, n: b - a + 1, offset: a, cols,
    lat: log.lat.slice(a, b + 1), lon: log.lon.slice(a, b + 1), t: log.t.slice(a, b + 1), cells: log.cells.slice(a, b + 1),
    carEvents: log.carEvents.filter(e => e.i >= a && e.i <= b).map(e => ({ ...e, i: e.i - a })),
  };
}

/**
 * A log as the drives in it. The app now closes its file at a charge and picks
 * a file back up only after a pause under 5 minutes, but older logs and trip
 * logs rebuilt from CSV hold a charge inside a long gap - a lone point, then
 * the drive - with the energy counter falling across it. A drive ends at a gap
 * of [gapMs] or more, at a gap of a minute or more across which the charge
 * rose [socRise] points, and around points marked charging; pieces of fewer
 * than two points are dropped.
 */
export function splitDrives(log, { gapMs = 300000, socRise = 5 } = {}) {
  const { n, t, cols } = log, soc = cols.soc_percent, charging = cols.charging;
  // The charge a little after a gap: the first point after one often has no reading yet.
  const socNear = i => { for (let j = i; j < n && t[j] - t[i] <= 30000; j++) if (ok(soc[j])) return soc[j]; return NaN; };
  const parts = [];
  let from = -1, prev = -1, lastSoc = NaN;
  // A closed drive's last charge reading says nothing about the next drive's stops.
  const close = () => { if (from >= 0 && prev > from) parts.push(slice(log, from, prev)); from = -1; lastSoc = NaN; };
  for (let i = 0; i < n; i++) {
    if (charging && charging[i] >= 1) { close(); continue; }
    if (from >= 0) {
      const gap = t[i] - t[prev];
      if (gap >= gapMs || (gap >= 60000 && soc && socNear(i) - lastSoc >= socRise)) close();
    }
    if (from < 0) from = i;
    prev = i;
    if (soc && ok(soc[i])) lastSoc = soc[i];
  }
  close();
  return parts;
}

/**
 * The energy counters start again wherever the app restarted: at a point the
 * app marked "resumed" - certain even where the new count is already past the
 * old - or where regen, or what left the pack (energy_kwh + energy_regen_kwh),
 * falls, which a running total never does. Both are carried on from where they
 * stopped, as the player's merge() does.
 * Without energy_regen_kwh, an unmarked restart looks like regen.
 */
export function continueCounters({ n, cols, carEvents }) {
  const e = cols.energy_kwh, r = cols.energy_regen_kwh, breaks = new Set();
  for (const ev of carEvents) if (ev.i > 0 && /\bresumed\b/.test(ev.type)) breaks.add(ev.i);
  if (e && r) for (let i = 0, j = -1; i < n; i++) {
    if (!ok(e[i]) || !ok(r[i])) continue;
    if (j >= 0 && (r[i] < r[j] - 1e-6 || e[i] + r[i] < e[j] + r[j] - 1e-6)) breaks.add(i);
    j = i;
  }
  const at = [...breaks].sort((a, b) => a - b);
  for (const c of [e, r]) if (c) at.forEach((b, k) => {
    const end = (at[k + 1] ?? n) - 1, before = lastValid(c, 0, b - 1), from = firstValid(c, b, end);
    if (ok(before) && ok(from)) for (let i = b; i <= end; i++) c[i] += before - from;
  });
  return at;
}
