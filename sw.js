// Offline for the three pages, and the way Android's Share GPX gets a file in here.
// A classic worker on purpose: module service workers are not everywhere yet, and this
// file has to install in whatever browser the car's logs are read in.
// The worker includes a small, cut-down IndexedDB helper at the bottom.
// import it instead once module service workers can be relied on.

// Bump this and every older cache goes at the next activation.
const VERSION = "v2";
const CACHE = `gpx-log-player-${VERSION}`;
// Tiles are the map itself, not this site's code, and survive a new version of it.
const TILES = "gpx-log-player-tiles";
const TILE_HOST = "tile.openstreetmap.org";
const TILE_LIMIT = 2000;

// The pages' own code: whatever ships together and must not lag behind the page that imports it.
const PAGES = ["./", "index.html", "statistics.html", "validate.html", "stats-worker.js",
  "stats/battery.js", "stats/charges.js", "stats/charging-csv.js", "stats/coach.js", "stats/coach-view.js", "stats/episodes.js", "stats/gpx.js",
  "stats/habits.js", "stats/num.js", "stats/patterns.js", "stats/periods.js", "stats/settings.js", "stats/store.js",
  "stats/summary.js", "stats/tabs-view.js", "stats/trip-view.js", "stats/trip.js"];

// Files that only ever change with a new version of the site.
const ASSETS = ["manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png",
  "schema/ev.xsd", "schema/gpx.xsd", "schema/gpx-log-player.xsd", "schema/TrackPointExtensionv2.xsd",
  "vendor/xmllint-wasm/index-browser.mjs", "vendor/xmllint-wasm/xmllint-browser.mjs", "vendor/xmllint-wasm/xmllint.wasm"];

// The versions the pages pin in their own script tags.
const PINNED = [
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js",
  "https://cdn.jsdelivr.net/npm/uplot@1.6.32/dist/uPlot.min.css",
  "https://cdn.jsdelivr.net/npm/uplot@1.6.32/dist/uPlot.iife.min.js",
];

const SCOPE = new URL("./", self.location);
/** The path under this worker's scope, or null for anything outside it. */
const within = url => url.origin === SCOPE.origin && url.pathname.startsWith(SCOPE.pathname)
  ? url.pathname.slice(SCOPE.pathname.length) : null;
// Only the files this site ships are answered for: a GPX under the scope is somebody's drive, not ours.
const OURS = new Set([...PAGES, ...ASSETS].map(p => p === "./" ? "" : p));

// A cached CORS response answers a no-cors script tag or <img>, so the pages keep their plain
// tags and Leaflet its plain tile images: only this file ever asks for these across origins.
const cors = url => new Request(url, { mode: "cors" });
// Cross-origin replies carry Vary headers this worker has no say over, and only GETs are ever
// stored, so what is cached is found by its URL alone.
const MATCH = { ignoreVary: true, ignoreMethod: true };
/** What a HEAD is answered with: the player asks by HEAD whether the validator is beside it. */
const bodiless = reply => new Response(null, { status: reply.status, statusText: reply.statusText, headers: reply.headers });

self.addEventListener("install", e => e.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  // One at a time and failures tolerated: a CDN hiccup must not leave the site with no worker at
  // all, and anything missed is fetched and cached the first time it is wanted.
  await Promise.allSettled([
    ...[...PAGES, ...ASSETS].map(path => cache.add(path).catch(async () => {
      // The version before this one is not deleted until activate: an entry this install missed
      // is better taken from there than left as a hole in the only cache anything is read from.
      const old = await caches.match(path);
      if (old) await cache.put(path, old);
    })),
    ...PINNED.map(async url => {
      const reply = await fetch(cors(url));
      if (!reply.ok) throw new Error(`${reply.status} fetching ${url}`);
      await cache.put(cors(url), reply);
    }),
  ]);
  self.skipWaiting();
})()));

self.addEventListener("activate", e => e.waitUntil((async () => {
  for (const name of await caches.keys()) {
    if (name !== CACHE && name !== TILES && name.startsWith("gpx-log-player-")) await caches.delete(name);
  }
  await self.clients.claim();
})()));

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  const path = within(url);
  if (e.request.method === "POST" && path === "share") return e.respondWith(receiveShare(e.request));
  if (e.request.method !== "GET" && e.request.method !== "HEAD") return;
  if (url.hostname === TILE_HOST) return e.respondWith(tile(e.request));
  if (PINNED.includes(url.href)) return e.respondWith(cacheFirst(cors(url.href)));
  if (path === null || !OURS.has(path)) return;
  const answer = PAGES.includes(path || "./") ? networkFirst(e.request) : cacheFirst(e.request);
  e.respondWith(e.request.method === "HEAD" ? answer.then(bodiless) : answer);
});

/** Online is always the newest page; offline, the one last seen. */
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(request);
    // The query picks a drive, not a file: one copy of the page under its own path. A redirected
    // reply is never stored - handed back to a navigation offline it fails it, for ever.
    if (fresh.ok && !fresh.redirected && request.method === "GET") await cache.put(request.url.split("?")[0], fresh.clone());
    return fresh;
  } catch (e) {
    // index.html?drive=… is the same page: the query picks a drive, it does not pick a file.
    const hit = await cache.match(request, { ...MATCH, ignoreSearch: true });
    if (hit) return hit;
    throw e;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request, MATCH);
  if (hit) return hit;
  const fresh = await fetch(request);
  if (fresh.ok && request.method === "GET") await cache.put(request, fresh.clone());
  return fresh;
}

// ---------- map tiles ----------

/** The seconds a Cache-Control header allows a reply to be reused for; 0 when it says nothing useful. */
function maxAgeSeconds(header) {
  if (!header) return 0;
  if (/(^|,)\s*(no-store|no-cache)\s*(,|$)/i.test(header)) return 0;
  const found = /(?:^|[,\s])max-age\s*=\s*"?(\d+)/i.exec(header);
  return found ? Number(found[1]) : 0;
}

// A cross-origin reply hands a worker only a few of its headers, and Date is not among them,
// so the moment a tile was fetched is written on it here instead.
const STAMP = "x-tile-fetched";
const stampTile = async response => new Response(await response.blob(), {
  status: response.status,
  statusText: response.statusText,
  headers: [...response.headers, [STAMP, String(Date.now())]],
});

/** Reusable until its max-age runs out, counted from when this worker fetched it. */
function tileFresh(response, now) {
  if (!response) return false;
  const seconds = maxAgeSeconds(response.headers.get("Cache-Control"));
  if (!seconds) return false;
  const fetched = Number(response.headers.get(STAMP));
  return fetched > 0 && now < fetched + seconds * 1000;
}

/**
 * Tiles are kept as they are looked at and never fetched ahead: OpenStreetMap's tile usage
 * policy forbids bulk downloading, and a map of a month of drives would be thousands of tiles.
 */
async function tile(request) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(request, MATCH);
  if (tileFresh(hit, Date.now())) return hit;
  try {
    const fresh = await fetch(cors(request.url));
    // OpenStreetMap answers 429 over its tile budget and 503 when the CDN is unhappy, and invites
    // a stale tile in return (stale-if-error=604800). A reply that is not ok is not a map.
    if (!fresh.ok) return hit || fresh;
    const keep = await stampTile(fresh);
    await cache.put(cors(request.url), keep.clone());
    // cache.keys() builds every key, so trim in batches.
    // the cap is then TILE_LIMIT plus at most one batch.
    if (++storedTiles % 50 === 0) await evictTiles(cache);
    return keep;
  } catch (e) {
    // Offline, an out-of-date tile is a better map than a grey square.
    if (hit) return hit;
    throw e;
  }
}

let storedTiles = 0;

/** cache.keys() is insertion order and a re-stored tile moves to the end, so the front is the oldest. */
async function evictTiles(cache) {
  const keys = await cache.keys();
  for (const old of keys.slice(0, keys.length - TILE_LIMIT)) await cache.delete(old);
}

// ---------- the share target ----------

/**
 * Android's Share GPX posts here. The files go in the inbox for the statistics page to import:
 * the worker has no window to hand them to, and the share may have started the app.
 */
async function receiveShare(request) {
  const seen = new URL("statistics.html?inbox", self.location).href;
  try {
    const form = await request.formData();
    const shared = [...form.getAll("gpx"), ...form.getAll("file"), ...form.getAll("files")]
      .filter(f => typeof f?.text === "function");
    // Read here: the page wants text, and a File from a share is not worth keeping alive.
    const files = await Promise.all(shared.map(async f => ({ name: f.name || "shared.gpx", text: await f.text() })));
    if (files.length) await addToInbox(files);
  } catch (e) {
    // A share that cannot be stored still opens the page, and the page says so: the user shared a
    // file and would otherwise be told nothing at all.
    console.warn("The shared files could not be stored:", e);
    return Response.redirect(seen + "=failed", 303);
  }
  return Response.redirect(seen, 303);
}

/** The stores stats/store.js makes; kept in step with it by hand. */
const DB = "gpx-log-player";
const STORES = ["files", "summaries", "settings", "inbox", "charges"];

function openWith(version) {
  const req = version ? indexedDB.open(DB, version) : indexedDB.open(DB);
  req.onupgradeneeded = () => {
    const db = req.result;
    for (const store of STORES) if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { autoIncrement: store === "inbox" });
  };
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    // Without this the share navigation waits for ever on a connection nobody will close.
    req.onblocked = () => reject(new Error("The database is in use elsewhere."));
  });
}

/** A share can be the first thing that ever opens this database, so the stores may have to be made here. */
async function addToInbox(files) {
  let db = await openWith();
  if (!db.objectStoreNames.contains("inbox")) {
    const next = db.version + 1;
    db.close();
    db = await openWith(next);
  }
  try {
    const tx = db.transaction("inbox", "readwrite");
    for (const file of files) tx.objectStore("inbox").put(file);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || new Error("Storing the shared files failed."));
    });
  } finally {
    // A connection left open here blocks the next version change, which is what hangs a share.
    db.close();
  }
}
