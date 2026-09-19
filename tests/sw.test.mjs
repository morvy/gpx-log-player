import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import vm from "node:vm";

// sw.js is a classic worker script, so it cannot be imported. It is run here in a context with
// stubs for the few things it touches at load time, and its own names are handed back at the end.
const source = await readFile(new URL("../sw.js", import.meta.url), "utf8");

/** A fresh copy of the worker, its listeners captured rather than registered. */
function load(location = "https://example.test/player/sw.js") {
  const listeners = new Map();
  const calls = { skipWaiting: 0, claim: 0 };
  const context = vm.createContext({
    URL, URLSearchParams, Request, Response, Headers, FormData, Blob, File, TextEncoder,
    console, fetch: async () => { throw new Error("nothing in these tests goes to the network"); },
    caches: null, indexedDB: null,
    self: {
      location: new URL(location),
      addEventListener: (name, fn) => listeners.set(name, fn),
      skipWaiting: () => calls.skipWaiting++,
      clients: { claim: async () => calls.claim++ },
    },
  });
  const sw = vm.runInContext(`${source}
;({ VERSION, CACHE, TILES, TILE_LIMIT, STAMP, PAGES, ASSETS, PINNED, OURS, within, maxAgeSeconds, tileFresh, stampTile, evictTiles, receiveShare })`, context);
  return { sw, context, listeners, calls };
}

// ---------- how long a tile may be reused ----------

test("max-age is read out of a Cache-Control header, whatever else it says", () => {
  const { sw } = load();
  assert.equal(sw.maxAgeSeconds("max-age=604800"), 604800);
  assert.equal(sw.maxAgeSeconds("public, max-age=86400, immutable"), 86400);
  assert.equal(sw.maxAgeSeconds("s-maxage=10, max-age=20"), 20);
  assert.equal(sw.maxAgeSeconds("Max-Age = 300"), 300);
});

test("a header that promises nothing keeps nothing", () => {
  const { sw } = load();
  assert.equal(sw.maxAgeSeconds(null), 0, "no header at all");
  assert.equal(sw.maxAgeSeconds("public"), 0, "no max-age in it");
  assert.equal(sw.maxAgeSeconds("no-store, max-age=600"), 0, "told not to store it");
  assert.equal(sw.maxAgeSeconds("no-cache"), 0);
  assert.equal(sw.maxAgeSeconds("max-age=0"), 0);
});

const tileWith = headers => new Response("tile", { headers });

test("a tile is fresh until its max-age runs out, counted from when it was fetched", async () => {
  const { sw } = load();
  const at = Date.now();
  const tile = await sw.stampTile(tileWith({ "Cache-Control": "max-age=3600" }));
  assert.equal(Number(tile.headers.get(sw.STAMP)) >= at, true, "the worker writes the moment on it");
  assert.equal(sw.tileFresh(tile, at + 3599_000), true);
  assert.equal(sw.tileFresh(tile, at + 3601_000), false, "past its max-age");
});

test("a tile that cannot say when it was fetched is never counted fresh", () => {
  const { sw } = load();
  assert.equal(sw.tileFresh(undefined, Date.now()), false, "nothing cached");
  // OpenStreetMap's reply crosses an origin, which hides its Date: an unstamped tile is not trusted.
  assert.equal(sw.tileFresh(tileWith({ "Cache-Control": "max-age=3600" }), Date.now()), false, "never stamped");
  assert.equal(sw.tileFresh(tileWith({ [sw.STAMP]: String(Date.now()) }), Date.now()), false, "no max-age");
});

// ---------- the tile cache does not grow without end ----------

/** A cache that only remembers the order its keys went in, which is all the eviction reads. */
const fakeCache = keys => {
  const deleted = [];
  return { deleted, keys: async () => keys, delete: async key => { deleted.push(key); return true; } };
};

test("the oldest tiles go when the cache is over the limit", async () => {
  const { sw } = load();
  // A fixed number, not the worker's own choice: at most 2,000 tiles are kept.
  assert.equal(sw.TILE_LIMIT, 2000);
  const keys = Array.from({ length: 2000 + 3 }, (_, i) => `tile-${i}`);
  const cache = fakeCache(keys);
  await sw.evictTiles(cache);
  assert.deepEqual(cache.deleted, ["tile-0", "tile-1", "tile-2"]);
});

test("a cache at or under the limit loses nothing", async () => {
  const { sw } = load();
  for (const count of [0, 1, 2000]) {
    const cache = fakeCache(Array.from({ length: count }, (_, i) => `tile-${i}`));
    await sw.evictTiles(cache);
    assert.deepEqual(cache.deleted, [], `${count} tiles cached`);
  }
});

// ---------- what this worker answers for ----------

test("the pages and their modules are the ones fetched from the network first", () => {
  const { sw } = load();
  const path = href => sw.within(new URL(href));
  assert.equal(path("https://example.test/player/"), "");
  assert.equal(path("https://example.test/player/statistics.html?inbox"), "statistics.html");
  assert.equal(path("https://example.test/elsewhere/index.html"), null, "outside the scope");
  assert.equal(path("https://cdn.jsdelivr.net/player/uPlot.js"), null, "another origin, same path");
  assert.equal(path("https://example.test/elsewhere/player/index.html"), null, "the scope inside another path");

  for (const ours of ["", "index.html", "statistics.html", "validate.html", "stats-worker.js",
    "stats/num.js", "manifest.webmanifest", "icons/icon-512.png", "schema/gpx.xsd"]) {
    assert.equal(sw.OURS.has(ours), true, ours);
  }
  // Somebody's drive sitting beside the page, and a URL this site never ships.
  for (const theirs of ["logs/trip-20260914-132638.gpx", "share", "elsewhere.html"]) {
    assert.equal(sw.OURS.has(theirs), false, theirs);
  }
});

test("every module under stats/ is kept for offline use", async () => {
  const { sw } = load();
  const modules = (await readdir(new URL("../stats/", import.meta.url))).filter(f => f.endsWith(".js")).map(f => `stats/${f}`);
  assert.ok(modules.includes("stats/coach-view.js"), "the coach tab's module is one of them");
  for (const module of modules) assert.ok(sw.PAGES.includes(module), `${module} is missing from PAGES`);
});

/** A share as Android sends it: a multipart POST of one or more files under "gpx". */
function share(files, at = "https://example.test/player/share") {
  const form = new FormData();
  for (const [name, text] of files) form.append("gpx", new File([text], name, { type: "application/gpx+xml" }));
  return new Request(at, { method: "POST", body: form });
}

/** The fetch listener run against one request; `answer` is undefined when the worker leaves it alone. */
function fetched(listeners, request) {
  let answer;
  listeners.get("fetch")({ request, respondWith: reply => { answer = reply; } });
  return answer;
}

test("offline, the HEAD the player asks with is answered from the cache, without a body", async () => {
  const { context, listeners } = load();
  context.caches = { open: async () => ({ match: async () => new Response("<!doctype html>"), put: async () => {} }) };
  const reply = await fetched(listeners, new Request("https://example.test/player/validate.html", { method: "HEAD" }));
  assert.equal(reply.status, 200);
  assert.equal(await reply.text(), "", "a HEAD gets no body");
});

test("requests this site has nothing to say about are left alone", () => {
  const { listeners } = load();
  assert.equal(fetched(listeners, new Request("https://example.test/elsewhere/thing.js")), undefined, "outside the scope");
  assert.equal(fetched(listeners, new Request("https://nominatim.example/search")), undefined, "another origin");
  assert.equal(fetched(listeners, new Request("https://example.test/player/index.html", { method: "DELETE" })), undefined);
});


/**
 * Caches stubbed down to what the strategies read: every lookup is a hit, so a cache-first answer
 * says "cached" and a network-first one says "network", and each says which cache it opened.
 */
function stubCaches(context) {
  const opened = [], puts = [], asked = [], fetched = [];
  context.caches = {
    open: async name => {
      opened.push(name);
      return {
        match: async (request, options) => { asked.push({ request, options }); return new Response("cached"); },
        put: async (key, value) => { puts.push(typeof key === "string" ? key : key.url); return value; },
        keys: async () => [],
        delete: async () => true,
      };
    },
    match: async () => undefined,
  };
  context.fetch = async request => {
    fetched.push(request);
    return new Response("network", { headers: { "Cache-Control": "max-age=3600" } });
  };
  return { opened, puts, asked, fetched };
}

test("each kind of request gets the strategy section 5 asks for", async () => {
  const { sw, context, listeners } = load();
  const { opened, puts, asked, fetched: went } = stubCaches(context);
  const answer = request => fetched(listeners, new Request(request));

  // The pages and their modules: the newest whenever there is a network.
  assert.equal(await (await answer("https://example.test/player/statistics.html?inbox")).text(), "network");
  assert.equal(await (await answer("https://example.test/player/stats/num.js")).text(), "network");
  // The query picks a drive, not a file: the page is stored once, under its own path.
  assert.equal(await (await answer("https://example.test/player/index.html?drive=abc&at=1789403039000")).text(), "network");
  assert.deepEqual(puts, ["https://example.test/player/statistics.html",
    "https://example.test/player/stats/num.js", "https://example.test/player/index.html"]);

  // Files that only change with a new version of the site: whatever was cached, without asking.
  assert.equal(await (await answer("https://example.test/player/schema/gpx.xsd")).text(), "cached");
  assert.equal(await (await answer("https://example.test/player/icons/icon-512.png")).text(), "cached");
  assert.deepEqual(opened, Array(5).fill(sw.CACHE));

  // The pinned CDN copies, asked for across the origin with cors so a cached reply answers a
  // plain no-cors script tag.
  assert.equal(await (await answer(sw.PINNED[0])).text(), "cached");
  assert.equal(asked[asked.length - 1].request.mode, "cors");
  // A cross-origin reply varies on headers this worker has no say over: it is found by its URL.
  assert.equal(asked[asked.length - 1].options.ignoreVary, true);

  // Tiles are the map, not this site, and live in their own cache.
  await answer("https://tile.openstreetmap.org/12/2200/1400.png");
  assert.equal(opened[opened.length - 1], sw.TILES);
  assert.equal(went[went.length - 1].mode, "cors");

  // A GPX beside the page is somebody's drive: the worker has nothing to do with it.
  assert.equal(answer("https://example.test/player/logs/trip-20260914-132638.gpx"), undefined);
  // A reload of the share URL is not a page this site ships either.
  assert.equal(answer("https://example.test/player/share"), undefined);
});

test("an entry this install misses is taken from the version before it, not left as a hole", async () => {
  const { sw, context, listeners, calls } = load();
  const missing = "stats/patterns.js";
  const added = [], put = [];
  context.caches = {
    open: async () => ({
      add: async path => { if (path === missing) throw new Error("404"); added.push(path); },
      put: async key => { put.push(typeof key === "string" ? key : key.url); },
    }),
    // The older cache is still there while install runs; it has the file this deploy is missing.
    match: async path => path === missing ? new Response("the copy that was already here") : undefined,
  };
  // A CDN hiccup on one pinned file: the other three still have to land.
  context.fetch = async request => {
    if (request.url === sw.PINNED[0]) throw new Error("the CDN is having a day");
    return new Response("from the cdn");
  };
  const waited = [];
  listeners.get("install")({ waitUntil: p => waited.push(p) });
  await Promise.all(waited);

  // One entry failing takes nothing else down with it...
  assert.deepEqual(added, [...sw.PAGES, ...sw.ASSETS].filter(p => p !== missing));
  // ...and the file itself comes out of the older cache rather than being left out of this one.
  assert.deepEqual([...put].sort(), [missing, ...sw.PINNED.slice(1)].sort());
  assert.equal(calls.skipWaiting, 1, "a new version does not wait for every tab to close");
});


test("offline, the page last seen answers whatever drive the query asked for", async () => {
  const { context, listeners } = load();
  const { asked } = stubCaches(context);
  context.fetch = async () => { throw new TypeError("Failed to fetch"); };
  const reply = await fetched(listeners, new Request("https://example.test/player/index.html?drive=abc&at=17"));
  assert.equal(await reply.text(), "cached");
  // One copy of the page is stored, under its own path: the query has to be ignored to find it.
  assert.equal(asked[0].options.ignoreSearch, true);
});

test("a reply the site should not be left with offline is never stored", async () => {
  const { context, listeners } = load();
  const { puts } = stubCaches(context);
  context.fetch = async () => new Response("not found", { status: 404 });
  await fetched(listeners, new Request("https://example.test/player/statistics.html"));

  context.fetch = async () => {
    const reply = new Response("<!doctype html>");
    // What a proxy that normalises paths hands back. Offline this fails every navigation using it.
    Object.defineProperty(reply, "redirected", { value: true });
    return reply;
  };
  await fetched(listeners, new Request("https://example.test/player/index.html"));
  assert.deepEqual(puts, []);
});

test("a tile inside its max-age is not asked for again, and an error reply does not replace it", async () => {
  const { sw, context, listeners } = load();
  let cached = await load().sw.stampTile(new Response("the map", { headers: { "Cache-Control": "max-age=3600" } }));
  let fetches = 0, trims = 0;
  context.caches = { open: async () => ({
    match: async () => cached,
    put: async () => {},
    keys: async () => { trims++; return []; },
    delete: async () => true,
  }) };
  context.fetch = async () => { fetches++; return new Response("over your tile budget", { status: 429 }); };

  const tileAt = n => fetched(listeners, new Request(`https://tile.openstreetmap.org/12/2200/${n}.png`));
  assert.equal(await (await tileAt(1)).text(), "the map");
  assert.equal(fetches, 0, "OpenStreetMap is not asked for a tile this browser already has");

  // Past its max-age, so it is asked for - and 429 is an answer, not a map.
  cached = new Response("the old map", { headers: { "Cache-Control": "max-age=3600", [sw.STAMP]: "1" } });
  assert.equal(await (await tileAt(2)).text(), "the old map");
  assert.equal(fetches, 1);

  // Stored tiles are trimmed in batches: cache.keys() builds every key, so not once per tile.
  context.fetch = async () => new Response("a tile", { headers: { "Cache-Control": "max-age=3600" } });
  for (let n = 0; n < 50; n++) await tileAt(100 + n);
  assert.equal(trims, 1, "trimmed once in fifty tiles, and not never");
});

test("a share is recognised by the path it is posted to", async () => {
  const { context, listeners } = load();
  let stored;
  context.addToInbox = async files => { stored = files; };
  const reply = await fetched(listeners, share([["one.gpx", "<gpx/>"]]));
  assert.equal(reply.status, 303);
  assert.equal(stored.length, 1);
  // Not the share target, and not a file this site ships: the browser's own 404.
  assert.equal(fetched(listeners, share([["one.gpx", "<gpx/>"]], "https://example.test/player/shared")), undefined);
});

// ---------- the version rules ----------

test("activating deletes this site's older caches, and keeps the tiles", async () => {
  const { sw, context, listeners, calls } = load();
  const deleted = [];
  context.caches = {
    keys: async () => [sw.CACHE, "gpx-log-player-v0", sw.TILES, "some-other-site-v3"],
    delete: async name => { deleted.push(name); return true; },
  };
  const waited = [];
  listeners.get("activate")({ waitUntil: p => waited.push(p) });
  await Promise.all(waited);
  assert.deepEqual(deleted, ["gpx-log-player-v0"]);
  assert.equal(calls.claim, 1, "the pages open now are served by this worker");
});

test("the cache is named by the version, and the tiles are not", () => {
  const { sw } = load();
  assert.match(sw.CACHE, /^gpx-log-player-v\d+$/, `${sw.CACHE} carries a version`);
  assert.equal(sw.CACHE, `gpx-log-player-${sw.VERSION}`);
  assert.equal(sw.TILES, "gpx-log-player-tiles", "no version in it: tiles survive a new one");
});

// ---------- the share target ----------

test("shared files reach the inbox as the page reads them, and the browser is sent to ?inbox", async () => {
  const { sw, context } = load();
  let stored;
  context.addToInbox = async files => { stored = files; };
  const reply = await sw.receiveShare(share([["morning.gpx", "<gpx/>"], ["evening.gpx", "<gpx>2</gpx>"]]));
  assert.equal(reply.status, 303);
  assert.equal(reply.headers.get("Location"), "https://example.test/player/statistics.html?inbox");
  // importFiles() takes { name, text } exactly as a picked File does.
  // The records are made inside the worker's own realm, so compare their contents, not their class.
  assert.deepEqual(Array.from(stored, f => ({ ...f })), [
    { name: "morning.gpx", text: "<gpx/>" },
    { name: "evening.gpx", text: "<gpx>2</gpx>" },
  ]);
});

test("a share that cannot be stored still opens the page, and says so", async () => {
  const { sw, context } = load();
  context.addToInbox = async () => { throw new Error("no room left"); };
  context.console = { warn: () => {} };
  const reply = await sw.receiveShare(share([["one.gpx", "<gpx/>"]]));
  assert.equal(reply.status, 303);
  // The page has an empty inbox either way: without this it would have nothing to tell the user.
  assert.equal(reply.headers.get("Location"), "https://example.test/player/statistics.html?inbox=failed");
});

test("a share with no file in it stores nothing", async () => {
  const { sw, context } = load();
  let called = false;
  context.addToInbox = async () => { called = true; };
  assert.equal((await sw.receiveShare(share([]))).status, 303);
  assert.equal(called, false, "nothing shared");

  // Android sends the text and url fields alongside; a "gpx" part that is not a file is not a drive.
  const form = new FormData();
  form.append("gpx", "https://example.test/not-a-file.gpx");
  form.append("text", "look at this");
  const reply = await sw.receiveShare(new Request("https://example.test/player/share", { method: "POST", body: form }));
  assert.equal(called, false, "no file in it either");
  // Nothing went wrong: there was simply nothing to store, so the page is not told a share failed.
  assert.equal(reply.headers.get("Location"), "https://example.test/player/statistics.html?inbox");
});
