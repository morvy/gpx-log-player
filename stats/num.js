// Numbers the statistics share with the player (index.html) - kept the same
// so a drive reads the same on both pages.

export const ok = v => v != null && !Number.isNaN(v);

/**
 * A column that holds a reading. splitDrives() slices every column into every
 * drive, so a column can exist yet be all NaN here - that is absent, the same
 * as a missing column.
 */
export const usable = a => a && a.some(ok) ? a : null;

/** The speed the statistics read: the car's own where it wrote it, the GPS reading otherwise. */
export const speedOf = cols => usable(cols.speed_kmh) || usable(cols.gps_speed);

/** Power at the pack (kW): the car's own reading, or voltage times current where it wrote only those. */
export const powerOf = cols => usable(cols.power_kw) ||
  (usable(cols.pack_voltage_v) && usable(cols.current_a)
    ? cols.pack_voltage_v.map((v, i) => v * cols.current_a[i] / 1000) : null);

export function firstValid(a, i0, i1) { for (let i = i0; i <= i1; i++) if (ok(a[i])) return a[i]; return NaN; }
export function lastValid(a, i0, i1) { for (let i = i1; i >= i0; i--) if (ok(a[i])) return a[i]; return NaN; }

export function haversineKm(a1, o1, a2, o2) {
  const r = Math.PI / 180, dLat = (a2 - a1) * r, dLon = (o2 - o1) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a1 * r) * Math.cos(a2 * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

/** kWh out of (positive) and back into (negative) the pack, trapezoids over time, gaps over 10 s skipped. */
export function integrate(power, t, i0, i1) {
  let out = 0, back = 0, pi = -1;
  for (let i = i0; i <= i1; i++) {
    if (!ok(power[i])) continue;
    if (pi >= 0 && t[i] - t[pi] <= 10000) {
      const kwh = (power[pi] + power[i]) / 2 * (t[i] - t[pi]) / 3.6e6;
      if (kwh >= 0) out += kwh; else back -= kwh;
    }
    pi = i;
  }
  return { out, back };
}
