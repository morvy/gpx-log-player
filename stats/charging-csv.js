const METADATA = ["format_version", "vehicle", "session_id", "started_at", "ended_at", "soc_from", "soc_to", "kwh_added", "seconds", "peak_kw"];
const HEADER = "charge_s,charge_kw,soc_pct,observed";

export function isChargingCsv(text) {
  return String(text).replace(/^﻿/, "").split(/\r?\n/, 12).some(line => line.trim() === HEADER);
}

export function parseChargingCsv(text) {
  const lines = String(text).replace(/^﻿/, "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const header = lines.indexOf(HEADER);
  if (header < 0) {
    const version = lines.find(line => line.startsWith("format_version,"));
    if (version && version !== "format_version,1") throw new Error(`Unsupported format version: ${version.slice("format_version,".length)}`);
    throw new Error("Missing charging session point header.");
  }
  if (header < METADATA.length) throw new Error("Missing charging session metadata.");
  const metadata = Object.create(null);
  for (const line of lines.slice(0, header)) {
    const comma = line.indexOf(",");
    if (comma < 1) throw new Error(`Malformed metadata row: ${line}`);
    const key = line.slice(0, comma), value = line.slice(comma + 1);
    if (!METADATA.includes(key)) throw new Error(`Unexpected metadata: ${key}`);
    if (Object.hasOwn(metadata, key)) throw new Error(`Duplicate metadata: ${key}`);
    metadata[key] = value;
  }
  if (METADATA.some(key => !Object.hasOwn(metadata, key))) throw new Error("Missing required charging session metadata.");
  const number = key => {
    const value = Number(metadata[key]);
    if (metadata[key] === "" || !Number.isFinite(value)) throw new Error(`Invalid ${key}: ${metadata[key]}`);
    return value;
  };
  const formatVersion = number("format_version");
  if (!Number.isInteger(formatVersion) || formatVersion !== 1) throw new Error(`Unsupported format version: ${metadata.format_version}`);
  for (const key of ["vehicle", "session_id", "started_at"]) if (!metadata[key].trim()) throw new Error(`${key} must not be blank`);
  const startedAt = Date.parse(metadata.started_at);
  if (!Number.isFinite(startedAt) || !/^\d{4}-\d\d-\d\dT/.test(metadata.started_at)) throw new Error("Invalid started_at");
  if (metadata.ended_at) {
    const endedAt = Date.parse(metadata.ended_at);
    if (!Number.isFinite(endedAt) || !/^\d{4}-\d\d-\d\dT/.test(metadata.ended_at)) throw new Error("Invalid ended_at");
    if (endedAt < startedAt) throw new Error("ended_at precedes started_at");
  }
  const socFrom = number("soc_from"), socTo = number("soc_to"), kwhAdded = number("kwh_added"), seconds = number("seconds"), peakKw = number("peak_kw");
  if (![socFrom, socTo].every(value => value >= 0 && value <= 100)) throw new Error("SOC metadata must be between 0 and 100");
  if ([kwhAdded, seconds, peakKw].some(value => value < 0)) throw new Error("Session totals must be non-negative");
  const points = lines.slice(header + 1).map(line => {
    const fields = line.split(",");
    if (fields.length !== 4) throw new Error(`Malformed point: ${line}`);
    const [chargeS, chargeKw, socPct] = fields.slice(0, 3).map(Number);
    if (fields.slice(0, 3).some(value => value.trim() === "")) throw new Error(`Invalid numeric point: ${line}`);
    if (!Number.isFinite(socPct)) throw new Error(`Invalid soc_pct: ${fields[2]}`);
    if (!Number.isFinite(chargeS)) throw new Error(`Invalid charge_s: ${fields[0]}`);
    if (!Number.isFinite(chargeKw)) throw new Error(`Invalid charge_kw: ${fields[1]}`);
    if (chargeS < 0) throw new Error(`Invalid charge_s: ${chargeS}`);
    if (chargeKw < 0) throw new Error(`Invalid charge_kw: ${chargeKw}`);
    if (socPct < 0 || socPct > 100) throw new Error(`Invalid soc_pct: ${socPct}`);
    if (fields[3] !== "true" && fields[3] !== "false") throw new Error(`Invalid observed: ${fields[3]}`);
    return { chargeS, chargeKw, socPct, observed: fields[3] === "true" };
  });
  if (points.some((point, i) => i && point.chargeS < points[i - 1].chargeS)) throw new Error("charge_s must be non-decreasing");
  return { formatVersion, vehicle: metadata.vehicle, sessionId: metadata.session_id, startedAt: metadata.started_at, endedAt: metadata.ended_at, socFrom, socTo, kwhAdded, seconds, peakKw, points };
}
