# GPX log player

Plays a GPX track log on an OpenStreetMap map, with the values logged along
it. Made for the drive logs of the Honda e dashboard app: power and regen,
speed, altitude and grade, state of charge, every cell voltage, pack voltage,
current and temperatures, and the energy used. Any GPX 1.1 track with times
plays; the more of the values below a file carries, the more the player shows.

**Open it:** https://morvy.github.io/gpx-log-player/
**Check a file:** https://morvy.github.io/gpx-log-player/validate.html

## Using it

1. Get a GPX log. In the Honda e dashboard app: Settings > ROUTE > **Share
   GPX**, and save it to Drive or anywhere the phone or computer can open it.
2. Open the player and tap **Open GPX**, or drop the file on the page. On
   Android the file picker lists Google Drive.

**Several logs at once**: select or drop more than one file. They play one
after another as a single trip, in time order: the map draws each drive
without a line between them, distance and energy carry on across, charts
against time leave a gap for the time parked, and playback skips it. The
readout names the log under the cursor. A log that overlaps the one before -
the same drive twice - is left out, and the page says which.

- **Colour route by** power, speed, grade, altitude, charge, cell spread or
  consumption.
- **Play** drives a marker along the route at 1× to 120×; the charts and the
  readout follow. Space plays and pauses, the arrow keys step a point (Shift:
  30 points).
- **Charts against** distance or time. Tick a chart's name to hide or show it.
- **Measure a stretch**: drag across a chart with the mouse, or hold two
  fingers on it on a phone. The panel shows distance, climb, grade, kWh,
  kWh/100 km, power, regen and the change in charge, and the map zooms to it.
  Double-click a chart, or press **Whole drive**, to go back.
- **Move through the drive**: hover or tap the route, or slide a finger along
  a chart.
- **BMS charge jumps**: where the car's charge figure falls (or rises) further
  than the energy through the pack explains - the fall onto the weakest cell
  near empty - the spot is marked on the map and on every chart, with what
  happened and which cell the readings point at.
- **From the car**: warnings the app logged on the drive - the charge about to
  fall, a flagged cell, the adapter link lost, the recording picked up again -
  listed with the jumps, marked in blue on the map and the charts.
- **Every cell against the pack median** is a heat map, one row per cell: a
  weak cell shows as a red stripe, and the weakest of the drive is labelled.
- **Every value** under the readout lists everything in the file at the
  cursor, and **Extra chart** plots any one of them.

The page has to be served over http - the published address above, or
`python3 -m http.server` in this folder. Opened from disk, it gets no map:
OpenStreetMap blocks tiles for a page without a web address.

The file never leaves the browser: it is read on your device and nothing is
uploaded. The player loads Leaflet and uPlot from public CDNs and map tiles
from OpenStreetMap.

## Statistics

**Open it:** https://morvy.github.io/gpx-log-player/statistics.html

Add GPX drive logs - pick them, or drop files or a whole folder on the page.
Each file is read once, in the background, and kept in this browser: next
time only the new logs need adding. A log is split into drives where the car
stood still for 5 minutes or charged, so an older log that holds a charge
does not count it as driving.

**Week, Month or All**, stepping back with ‹ ›, choose the period every
section but Patterns reads. Every figure shows how it compares with the four
weeks or months before it, and a rate - kWh/100 km, regen share, events per
100 km - waits for at least 20 km of driving in the period before it judges.

- **Summary**: drives, distance, driving time, kWh used, kWh/100 km and the
  share of energy regen put back.
- **Habits**: the driving, sorted into doing well, worth changing and worth
  knowing. Hard acceleration and hard braking as a rate per 100 km, the share
  of braking energy left in the pads instead of taken back by regen, regen
  share, steadiness over a minute of motorway, short or cold trips, time at
  full power, and a table of distance, time, kWh and kWh/100 km in each speed
  band. Each card carries its figure, the limit it is judged against and a
  sparkline of the last eight periods. **Show the moments** lists the worst of
  them with their time, speed and value, and **Open** plays any one in the
  player at that second.
- **Battery**: driving on an empty pack, charge jumps the energy cannot
  explain, hard pulls on a cold or nearly empty pack, and the car's own events;
  then trends across the periods - the three weakest cells against the pack
  median (or any one of the 96), cell spread by charge band, state of health,
  and the 12 V at the start of a drive. A pack drifts by tenths, so these axes
  are not pinned to nought.
- **Charging**: the gaps between two drives the charge rose across - what each
  added, how fast, and where, on a map with DC in orange and AC in blue. Under
  them **the charging curve**: kW per charge band from the DC charges on
  record, drawn as a staircase because a band knows one figure and not a slope.
  Every charging figure is averaged over the whole gap, parking included, so it
  is a floor and not a peak.
- **Trip calculator**: a distance and a starting charge, and the page plans the
  trip at each speed the logs have enough driving to know - driving time,
  stops, charging time, total, kWh and arrival charge, the fastest marked, and
  a line comparing neighbours. The figures are estimates: consumption comes
  from this car's own driving in weather like the temperature entered, charging
  time from the curve above, and the plan assumes a charger wherever it wants
  one.
- **Patterns**: every drive stored, not the period above - distance per
  calendar week, a weekday × hour grid of driving time, the places the car
  keeps coming back to as circles sized by how often, and consumption against
  outside temperature, one point per drive, coloured by how hard the A/C
  worked.
- **Drives**: every drive in the period. **Open** plays it in the player with
  the charts on that whole drive; tick several and **Open ticked in player**
  plays them as one trip, spanning them all. **Delete** removes a drive from
  this browser. **Show the moments** links open the charts on two minutes
  either side of the moment instead - a braking is worth looking at closely,
  a drive is worth seeing whole.
- **The same driving in two files** (a live log and one rebuilt from the trip
  log) is kept both times but counted once: the copy with the car's readings,
  then the one with more points. Deleting it shows the other copy.

### What a section needs from a log

Any GPX 1.1 track with times gives the Summary, the Drives table, and Patterns'
weeks, hours and places. Everything else waits for a value the log may not
carry, and says so where it would have stood:

| Section | Needs | Without it |
|---|---|---|
| kWh, kWh/100 km, regen, the speed bands | `ev:energy_kwh` and `ev:energy_regen_kwh`, else `ev:power_kw` to integrate | the figure is left out of the period |
| Habits' acceleration, braking and speed bands | `ev:speed_kmh`, else `gpxtpx:speed` | the card says there is nothing to measure |
| Battery's cells and spread | `ev:cells_v` | "no cell readings in these periods" |
| Empty-pack driving, charge jumps | `ev:soc_percent` | nothing is flagged |
| State of health, 12 V | `ev:soh_percent`, `ev:aux_12v_v` | "not in these logs" |
| Charging, the curve, the trip calculator | `ev:soc_percent` on the drives either side of a gap | no charge is found; the calculator does not appear |
| Consumption against the weather | `ev:outside_temp_c` | the drive is left out, and the caption counts how many were |
| The A/C colouring on that chart | `ev:aircon` | every point is grey - **no log this app writes carries it yet** |

The curve only knows the charge bands its DC charges actually went through. On
this driver's logs that is two charges covering 0-70 %, so the curve reads
26 kW to 60 %, 25 kW to 70 %, and "no data" above it - and the calculator
cannot plan a stop that charges past 70 %.

### Limits and calibration

Every number the driving is judged by is editable under **Limits and
calibration** in the Habits section: what counts as a hard pull, how many per
100 km is still fine, where good braking ends and bad begins, what makes a
trip short or a pack cold or weak, what rise in charge counts as a charge and
what average kW makes it DC, how near two parkings have to be to count as one
place. A limit is applied when the page draws, so changing one re-judges every
stored drive at once - no re-import, no waiting.

The brake-loss calibration is different: mass, drag area, rolling resistance,
air density and regen efficiency go into the measuring, not the verdict.
Changing one marks every summary stale and the page works each drive out again
from the GPX file it already has.

Nothing is uploaded: the logs are read and kept on this device. Clearing the
site's data in the browser removes them. On GitHub Pages every project under
the same `morvy.github.io` address shares that browser storage, so other
pages published there could read the drives.

The page needs a web server, like the player. The unit tests run with
`node --test tests/*.test.mjs`, in any time zone.

## Installing it, and using it offline

The three pages are one installable app. Open the statistics page or the
validator in a browser that offers it and install it; the installed app opens
the player, with the other two a link away. A service worker takes a copy of
the pages, their code, the schemas, the validator's WebAssembly and the pinned
Leaflet and uPlot files on the first visit, so after that the whole site works
with no network: the drives are already in this browser, the charts and the
maps still draw, and the validator still runs. Map tiles are kept as they are
looked at, up to 2,000 of them, and shown even when they are stale - none is
ever fetched ahead, because OpenStreetMap's tile policy forbids it. Online the
pages always come from the network, so an update lands on the next visit.

On Android the installed app is a share target: in the dashboard app share the
GPX, pick **GPX log player**, and the log goes straight into the statistics
page and is imported. Share one drive and the page also offers to open it in
the player.

`index.html` links no manifest and stays one file that loads nothing of its
own. Served on its own, or opened from disk, it registers no worker and works
as it always has.

## Data requirements

A file the player can read:

1. **Is GPX 1.1**, valid against [`schema/gpx-log-player.xsd`](schema/gpx-log-player.xsd).
   That one file pulls in the three namespaces a log uses:
   | Prefix   | Namespace                                                 | Schema |
   |----------|-----------------------------------------------------------|--------|
   | (none)   | `http://www.topografix.com/GPX/1/1`                       | [`gpx.xsd`](schema/gpx.xsd), the official GPX 1.1 schema |
   | `gpxtpx` | `http://www.garmin.com/xmlschemas/TrackPointExtension/v2` | [`TrackPointExtensionv2.xsd`](schema/TrackPointExtensionv2.xsd), Garmin's |
   | `ev`     | `urn:dev.moped:ev-gpx:1`                                  | [`ev.xsd`](schema/ev.xsd), what the vehicle logged |
2. **Has at least two track points** (`trkpt`), each with `lat`, `lon` and a
   `time`, in time order. GPX itself lets `time` out; the player cannot play a
   track without it.
3. **Has a number in every `ev:` value**, and the same count in `ev:cells_v`
   on every point.

Everything else is optional. `ele` gives altitude and climb, `gpxtpx:speed`
(m/s) speed and `gpxtpx:course` the heading, and these go in each point's
`<extensions>`:

| Element | Unit | Shows as |
|---|---|---|
| `ev:speed_kmh` | km/h | Speed chart, average speed, colour by speed. Falls back to `gpxtpx:speed`. |
| `ev:power_kw` | kW, positive out of the pack | Power chart, draw and regen, colour by power. Falls back to `pack_voltage_v` × `current_a`. |
| `ev:pack_voltage_v`, `ev:current_a` | V, A (positive out) | Pack voltage and current chart. |
| `ev:energy_kwh` | kWh, running total from any start | Energy used chart, kWh and kWh/100 km. Without it those figures come from integrating power. |
| `ev:energy_regen_kwh` | kWh, running total, never falls | Out of pack · regen back in the measurements, Regen back on the Energy used chart. Without it both come from integrating power. With it, an app restart partway through a log - both counters start again - is carried over. |
| `ev:kwh_per_100km` | kWh/100 km | Consumption (dash). |
| `ev:grade_percent` | % | Grade chart, colour by grade. |
| `ev:soc_percent` | % (the BMS figure) | State of charge chart, BMS charge jumps. |
| `ev:soc_weakest_cell_percent`, `cell_soc_min_percent`, `cell_soc_max_percent` | % | Weakest cell, cell min and max on the charge chart. |
| `ev:cell_voltage_min_v`, `cell_voltage_max_v` | V | Cells chart, the car's own spread. |
| `ev:cells_v` | V, space separated, cell 1 first | Cells at the cursor, cell spread, the cell heat map, the weakest cell. |
| `ev:battery_temp_c`, `outside_temp_c`, `module_1_temp_c` … `module_6_temp_c` | °C | Temperatures chart. |
| `ev:soh_percent`, `odometer_km`, `range_km`, `aux_12v_v`, `pressure_altitude_m` | %, km, km, V, m | Every value, Extra chart. |
| any other `ev:` name | a number | Every value, Extra chart. |
| `<name>`, `<desc>`, `<type>` on a `trkpt` | text; `type` is `soc`, `cell`, `link` or `resumed`, space separated | An event from the car, in a file with an `ev:field` key. `resumed` also marks where the energy counters started again. |

Readings every EV has go by one name with the unit in it; what only one car
reports keeps that car's own id (`motor_rpm`, `temp_a`). A value is repeated
on every point until it changes or stops being fresh - the player reads each
point on its own. The vehicle and a key to the names go in
`<metadata><extensions>`, one `ev:field` per name; without one a name is
listed under itself:

```xml
<metadata><extensions>
  <ev:vehicle>honda-e</ev:vehicle>
  <ev:field id="pack_voltage_v" label="Pack" unit="V" field="pack_voltage" ecu="01" request="22202A" byte="58"/>
</extensions></metadata>
```

A minimal point:

```xml
<trkpt lat="48.1420000" lon="17.1000000">
  <ele>327.3</ele>
  <time>2026-09-14T16:38:44Z</time>
  <extensions>
    <gpxtpx:TrackPointExtension><gpxtpx:speed>5.58</gpxtpx:speed></gpxtpx:TrackPointExtension>
    <ev:power_kw>2.997</ev:power_kw>
    <ev:soc_percent>98.64</ev:soc_percent>
    <ev:cells_v>4.1448 4.1444 4.1432</ev:cells_v>
  </extensions>
</trkpt>
```

Logs in the app's earlier `hondae:` namespace (`urn:dev.moped.hondae:gpx:1`)
are not read; convert them to `ev:` first. A bare `<speed>` (GPX 1.0, from logs
older still) plays but fails the 1.1 schema.

## Validating a file

**In the browser:** open [`validate.html`](validate.html) (the **Validate a
file** link in the player) and open or drop the file. It runs the schema with
libxml2 compiled to WebAssembly, then the checks a schema cannot make -
point count, times, numbers in unknown `ev:` names, the cell count - and
lists every problem with its line or point. Nothing is uploaded.

**In a terminal**, the schema part only:

```
xmllint --noout --schema schema/gpx-log-player.xsd drive.gpx
```

The schema declares the shared `ev:` names. GPX lets any other namespace into
`<extensions>` with lax processing, so a name the schema does not declare
passes unchecked; that is on purpose, a log can carry any value a car reports.

## Updating

`index.html` carries the player whole: one file, no build step, nothing to
install. A local web server is enough to run it, and `?file=<url>&name=<name>`
opens a log the server offers, for looking at a drive without publishing
anything. The **Validate a file** and **Statistics** links appear only where
`validate.html` sits beside the page, so a server offering the player alone
shows neither.

`vendor/xmllint-wasm/` is [xmllint-wasm](https://github.com/noppa/xmllint-wasm)
5.3.0's browser build, copied in because a page cannot start a Worker from
another origin such as a CDN.

## Publishing

Name the repository `gpx-log-player` (the URLs above follow the name).
Settings > Pages > Build and deployment: Source **GitHub Actions**. Every push
to `master` runs the unit tests and, if they pass,
[`.github/workflows/pages.yml`](.github/workflows/pages.yml) publishes the
repository root as it is.

## Licences

Copyright © 2026 morvy. The player, validator and statistics are free software
under the [GNU General Public License v3.0](LICENSE) or any later version: use,
change and share them, keep this notice, and publish your changes under the
same licence.

Map data © OpenStreetMap contributors. `schema/gpx.xsd` is TopoGrafix's,
`schema/TrackPointExtensionv2.xsd` Garmin's, both unmodified.
`vendor/xmllint-wasm/` is MIT, see its `COPYING`. Not affiliated with Honda.
