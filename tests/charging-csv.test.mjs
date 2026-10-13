import test from "node:test";
import assert from "node:assert/strict";
import { isChargingCsv, parseChargingCsv } from "../stats/charging-csv.js";

const validCsv = `format_version,1
vehicle,honda-e
session_id,20260923-181500
started_at,2026-09-23T18:15:00Z
ended_at,2026-09-23T19:05:00Z
soc_from,31.0
soc_to,70.0
kwh_added,18.42
seconds,3000
peak_kw,52.1
charge_s,charge_kw,soc_pct,observed
0,49.2,31.0,true
1800,42.0,70.0,false
`;

test("parses valid session metadata and points", () => {
  const session = parseChargingCsv(validCsv);
  assert.equal(session.sessionId, "20260923-181500");
  assert.equal(session.points[1].observed, false);
  assert.equal(session.points[1].chargeKw, 42);
});

test("rejects unsupported versions and malformed rows", () => {
  assert.throws(() => parseChargingCsv("format_version,3\n"), /version/i);
  assert.throws(() => parseChargingCsv(validCsv.replace("31.0,true", "nope,true")), /soc_pct/i);
  assert.throws(() => parseChargingCsv(validCsv.replace("1800,42.0", "-1,42.0")), /charge_s/i);
  assert.throws(() => parseChargingCsv(validCsv.replace("1800,42.0", "900,42.0").replace("0,49.2", "1200,49.2")), /non-decreasing/i);
  assert.throws(() => parseChargingCsv(validCsv.replace("true", "TRUE")), /observed/i);
});

test("sniffs charging headers without treating GPX as charging CSV", () => {
  assert.equal(isChargingCsv(validCsv), true);
  assert.equal(isChargingCsv("<?xml version=\"1.0\"?><gpx></gpx>"), false);
});

test("rejects duplicate, missing, and invalid metadata", () => {
  assert.throws(() => parseChargingCsv(validCsv.replace("vehicle,honda-e\n", "")), /metadata/i);
  assert.throws(() => parseChargingCsv(validCsv.replace("vehicle,honda-e\n", "vehicle,honda-e\nvehicle,honda-e\n")), /duplicate/i);
  assert.throws(() => parseChargingCsv(validCsv.replace("soc_to,70.0", "soc_to,101")), /SOC/i);
});

// Written by the app since its charging sessions gained battery health, connector, temperatures and odometer.
const v2Csv = validCsv.replace("format_version,1", "format_version,2").replace("peak_kw,52.1\n",
  "peak_kw,52.1\nsoh_pct,89.36\nconnector,DC\npack_temp_start_c,21.8\npack_temp_end_c,\nodometer_km,33618.0\n");

test("reads version 2, its five extra rows empty-able, and sniffs its later header", () => {
  assert.equal(isChargingCsv(v2Csv), true);
  const session = parseChargingCsv(v2Csv);
  assert.equal(session.formatVersion, 2);
  assert.equal(session.sohPct, 89.36);
  assert.equal(session.connector, "DC");
  assert.equal(session.packTempEndC, null);
  assert.equal(session.odometerKm, 33618);
  assert.equal(parseChargingCsv(validCsv).sohPct, null);
  assert.throws(() => parseChargingCsv(v2Csv.replace("connector,DC", "connector,XX")), /connector/i);
  assert.throws(() => parseChargingCsv(v2Csv.replace("soh_pct,89.36\n", "")), /metadata/i);
  assert.throws(() => parseChargingCsv(validCsv.replace("peak_kw,52.1\n", "peak_kw,52.1\nsoh_pct,90\n")), /metadata/i);
});
