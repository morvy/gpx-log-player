// Synthetic GPX logs written the way the app writes them, so tests never
// need a real log - real logs are GPS traces of somebody's life.

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/\n/g, "&#10;");

/** A whole GPX 1.1 document. [fields] is { id: [label, unit] } for the metadata key. */
export function gpxLog({ points, fields = {}, vehicle = "test-car", prefix = "ev" }) {
  let s = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1"` +
    ` xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v2" xmlns:${prefix}="urn:dev.moped:ev-gpx:1">\n<metadata><extensions>\n`;
  if (vehicle) s += `<${prefix}:vehicle>${esc(vehicle)}</${prefix}:vehicle>\n`;
  for (const [id, [label, unit]] of Object.entries(fields)) s += `<${prefix}:field id="${id}" label="${esc(label)}" unit="${esc(unit)}"/>\n`;
  s += `</extensions></metadata>\n<trk><name>test drive</name><trkseg>\n`;
  for (const p of points) {
    s += `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">`;
    if (p.ele != null) s += `<ele>${p.ele}</ele>`;
    if (p.t != null) s += `<time>${new Date(p.t).toISOString().replace(/\.\d{3}Z$/, "Z")}</time>`;
    for (const tag of ["name", "desc", "type"]) if (p[tag]) s += `<${tag}>${esc(p[tag])}</${tag}>`;
    const ev = Object.entries(p.ev ?? {}).filter(([, v]) => v != null);
    if (p.speedMs != null || ev.length || p.cells) {
      s += "<extensions>";
      if (p.speedMs != null) s += `<gpxtpx:TrackPointExtension><gpxtpx:speed>${p.speedMs}</gpxtpx:speed></gpxtpx:TrackPointExtension>`;
      for (const [k, v] of ev) s += `<${prefix}:${k}>${v}</${prefix}:${k}>`;
      if (p.cells) s += `<${prefix}:cells_v>${p.cells.join(" ")}</${prefix}:cells_v>`;
      s += "</extensions>";
    }
    s += "</trkpt>\n";
  }
  return s + "</trkseg></trk>\n</gpx>\n";
}

/** A straight drive north at a steady speed, one point a second. [ev] adds readings per second k. */
export function steadyDrive({ start = Date.UTC(2026, 8, 14, 7, 0, 0), seconds = 600, kmh = 36, powerKw = 5,
  lat = 48.1, lon = 17.1, ev = () => ({}) } = {}) {
  const step = kmh / 3.6 / 111194.93;   // degrees of latitude a second, on the player's 6371 km earth
  return Array.from({ length: seconds + 1 }, (_, k) => ({
    t: start + k * 1000, lat: lat + k * step, lon, speedMs: kmh / 3.6,
    ev: { speed_kmh: kmh, power_kw: powerKw, ...ev(k) },
  }));
}
