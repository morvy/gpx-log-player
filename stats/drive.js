// The dashboard app's Google Drive folder as a source of logs. The page asks
// Google for a token on a tap, lists the folder and fetches what it has not
// read: no server, and the token lives only as long as the tap's work. The
// scope is drive.file, so Google shows this page the app's own files and
// nothing else in the Drive; the page never writes to them.

export const CLIENT_ID = "515069403352-q6s3jqom6674d48ljh85du9e9u2gk433.apps.googleusercontent.com";
export const FOLDER = "Honda e logs";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const API = "https://www.googleapis.com/drive/v3/files";
const GIS = "https://accounts.google.com/gsi/client";
const CHUNK = 10;     // read and stored together, so a first sync of hundreds never sits in memory at once

/** The folder also holds raw and capture logs, most of its bytes; only these two are read here. */
export const wanted = name => /^(gpx-.*\.gpx|charging-.*\.csv)$/.test(name);

/** Oldest first, by the time in the name. A file whose bytes changed has a new MD5 and is read again. */
export const unseen = (files, seen) => files
  .filter(f => wanted(f.name) && seen[f.id] !== f.md5Checksum)
  .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// ponytail: Google's script, because a token without it needs a redirect away from the page.
// Fetched on the first tap only, so a visit that never touches Drive never talks to Google.
const loadGis = () => window.google?.accounts?.oauth2 ? Promise.resolve() : new Promise((resolve, reject) => {
  const script = document.createElement("script");
  script.src = GIS;
  script.onload = resolve;
  script.onerror = () => reject(new Error("Google's sign-in could not be reached."));
  document.head.append(script);
});

const WHY = {
  popup_closed: "The Google window was closed before access was given.",
  popup_failed_to_open: "The browser blocked Google's window. Tap Sync Drive again.",
};

/** A token for this tap. Call it straight from the click: a browser only lets a tap open a window. */
export async function requestToken() {
  await loadGis();
  return new Promise((resolve, reject) => {
    google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID, scope: SCOPE,
      callback: r => r.error ? reject(new Error(`Google refused: ${r.error}`)) : resolve(r.access_token),
      error_callback: e => reject(new Error(WHY[e.type] ?? `Google sign-in failed: ${e.type}`)),
    }).requestAccessToken();
  });
}

async function call(token, url) {
  const reply = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!reply.ok) throw new Error(`Drive answered ${reply.status}`);
  return reply;
}

async function query(token, q) {
  const found = [];
  let page = "";
  do {
    const url = `${API}?pageSize=1000&fields=${encodeURIComponent("nextPageToken,files(id,name,md5Checksum)")}&q=${encodeURIComponent(q)}${page && `&pageToken=${encodeURIComponent(page)}`}`;
    const body = await (await call(token, url)).json();
    found.push(...body.files);
    page = body.nextPageToken;
  } while (page);
  return found;
}

/** Every file in the app's folder, or none when the app has not made one for this account. */
export async function listLogs(token) {
  const folders = await query(token, `name = '${FOLDER}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const files = [];
  for (const folder of folders) files.push(...await query(token, `'${folder.id}' in parents and trashed = false`));
  return files;
}

const read = async (token, file) => ({ name: file.name, text: await (await call(token, `${API}/${file.id}?alt=media`)).text() });

/**
 * Brings the folder's new logs in. [add] takes { name, text } files; [keep]
 * stores [seen] after each chunk, so a sync cut short carries on where it
 * stopped. A file that was read counts as seen whatever [add] made of it - a
 * log of standing still will not read better next week. One that could not be
 * fetched does not: a token running out mid-sync leaves the rest for next time.
 */
export async function syncLogs({ token, seen, add, keep, progress = () => {} }) {
  const files = unseen(await listLogs(token), seen);
  let unread = 0;
  for (let at = 0; at < files.length; at += CHUNK) {
    progress(at, files.length);
    const chunk = files.slice(at, at + CHUNK);
    const got = await Promise.allSettled(chunk.map(f => read(token, f)));
    unread += got.filter(r => r.status === "rejected").length;
    await add(got.filter(r => r.status === "fulfilled").map(r => r.value));
    got.forEach((r, k) => { if (r.status === "fulfilled") seen[chunk[k].id] = chunk[k].md5Checksum; });
    await keep(seen);
  }
  return { found: files.length, unread };
}
