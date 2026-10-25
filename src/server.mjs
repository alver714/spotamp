// Local HTTP bridge between the Webamp page and Spotify:
// serves the UI, handles sign-in, and wraps the Web API calls the player needs.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as spotify from "./spotify.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const webampBuilt = path.dirname(createRequire(import.meta.url).resolve("webamp"));

export const PORT = Number(process.env.SPOTAMP_UI_PORT) || 5174;
export const ORIGIN = `http://127.0.0.1:${PORT}`;
const REDIRECT_URI = `${ORIGIN}/callback`; // Spotify only accepts 127.0.0.1 loopback
const DEVICE = process.env.SPOTAMP_DEVICE || "Spotamp";

const short = (t) => ({
  id: t.id,
  uri: t.uri,
  title: t.name,
  artist: t.artists.map((a) => a.name).join(", "),
  album: t.album.name,
  duration: t.duration_ms / 1000,
  artwork: t.album.images?.[0]?.url,
});

async function now() {
  const p = await spotify.api("GET", "/me/player?additional_types=track");
  if (!p?.item) return { state: "stopped" };
  return {
    ...short(p.item),
    position: p.progress_ms / 1000,
    state: p.is_playing ? "playing" : "paused",
    device: p.device?.name,
  };
}

let me = null;

// Sources for the Winamp playlist: Liked Songs and the user's playlists.
// Spotify does not return the tracks of other people's playlists to apps in
// development mode (403), so those are listed but not selectable.
async function sources() {
  me ??= await spotify.api("GET", "/me");
  const liked = await spotify.api("GET", "/me/tracks?limit=1");
  const list = [{ id: "liked", name: "Liked Songs", total: liked.total, readable: true }];
  for (let url = "/me/playlists?limit=50"; url; ) {
    const page = await spotify.api("GET", url);
    for (const p of page.items) {
      list.push({
        id: p.id,
        name: p.name.trim(),
        total: p.items?.total ?? p.tracks?.total ?? 0,
        readable: p.owner.id === me.id || p.collaborative,
      });
    }
    url = page.next && page.next.replace("https://api.spotify.com/v1", "");
  }
  return list;
}

async function tracks(source, offset) {
  me ??= await spotify.api("GET", "/me");
  const liked = source === "liked";
  const page = liked
    ? await spotify.api("GET", `/me/tracks?limit=50&offset=${offset}`)
    : await spotify.api("GET", `/playlists/${encodeURIComponent(source)}/items?limit=50&offset=${offset}`);
  return {
    total: page.total,
    next: page.next ? offset + page.items.length : null,
    // with a context, Spotify keeps going through this list on its own
    context: liked ? `spotify:user:${me.id}:collection` : `spotify:playlist:${source}`,
    tracks: page.items
      .map((i) => i.track ?? i.item)
      .filter((t) => t?.id && t.type !== "episode")
      .map(short),
  };
}

// The device id is stable while librespot runs: cache it instead of asking
// Spotify before every track (one network round trip less per switch).
let device = null;
async function deviceId(fresh = false) {
  if (device && !fresh && Date.now() - device.at < 10 * 60_000) return device.id;
  const { devices } = await spotify.api("GET", "/me/player/devices");
  const d = devices.find((x) => x.name === DEVICE);
  if (!d) throw new Error(`“${DEVICE}” is not visible in Spotify yet. Is the engine running?`);
  device = { id: d.id, at: Date.now() };
  return d.id;
}

// The engine restarted, so the device has a new id: retry once with a fresh list.
async function playOnDevice(body) {
  try {
    return await spotify.api("PUT", `/me/player/play?device_id=${await deviceId()}`, body);
  } catch (err) {
    if (!/404/.test(err.message)) throw err;
    return spotify.api("PUT", `/me/player/play?device_id=${await deviceId(true)}`, body);
  }
}

// Commands without a device go wherever Spotify is already playing;
// with nothing active, playback moves to the engine.
async function withDevice(fn) {
  try {
    return await fn("");
  } catch (err) {
    if (!/NO_ACTIVE_DEVICE|404/.test(err.message)) throw err;
    return fn(`device_id=${await deviceId()}`);
  }
}

const COMMANDS = {
  play: (q) => spotify.api("PUT", `/me/player/play?${q}`),
  pause: (q) => spotify.api("PUT", `/me/player/pause?${q}`),
  stop: (q) => spotify.api("PUT", `/me/player/pause?${q}`),
  next: (q) => spotify.api("POST", `/me/player/next?${q}`),
  previous: (q) => spotify.api("POST", `/me/player/previous?${q}`),
};

// Silence of the track's length: Webamp needs a real audio file for its clock
// and position slider. 8 kHz, 8-bit mono keeps it small.
function silentWav(seconds) {
  const rate = 8000;
  const n = Math.max(1, Math.round(Math.min(seconds, 3600) * rate));
  const buf = Buffer.alloc(44 + n, 128);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n, 40);
  return buf;
}

// Without Range support the browser treats the duration as infinite and won't seek.
function sendWav(req, res, wav) {
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  if (!m) {
    res.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length, "accept-ranges": "bytes" });
    return res.end(wav);
  }
  const start = m[1] ? Number(m[1]) : 0;
  const end = m[2] ? Math.min(Number(m[2]), wav.length - 1) : wav.length - 1;
  res.writeHead(206, {
    "content-type": "audio/wav",
    "content-length": end - start + 1,
    "content-range": `bytes ${start}-${end}/${wav.length}`,
    "accept-ranges": "bytes",
  });
  res.end(wav.subarray(start, end + 1));
}

const TYPES = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript", ".js": "text/javascript", ".map": "application/json" };

async function sendFile(res, file) {
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

async function readJson(req) {
  let s = "";
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}

const json = (res, data) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
};

const page = (res, title, text) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:32em;margin:15vh auto;padding:0 16px;color:#222">
<h2>${title}</h2><p>${text}</p></body>`);
};

/** @param {{ engineStatus: () => object }} hooks */
export function startServer(hooks) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, ORIGIN);
    try {
      // ---------- setup & sign-in ----------
      if (url.pathname === "/api/setup") {
        return json(res, { ...spotify.status(), redirectUri: REDIRECT_URI, engine: hooks.engineStatus() });
      }
      if (url.pathname === "/api/client-id" && req.method === "POST") {
        const { clientId } = await readJson(req);
        if (!/^[0-9a-f]{32}$/i.test(clientId || "")) return res.writeHead(400).end("That doesn't look like a Client ID (32 hex characters).");
        spotify.setClientId(clientId);
        return res.writeHead(204).end();
      }
      if (url.pathname === "/login") {
        res.writeHead(302, { location: spotify.authorizeUrl(REDIRECT_URI) });
        return res.end();
      }
      if (url.pathname === "/callback") {
        try {
          await spotify.finishSignIn(Object.fromEntries(url.searchParams), REDIRECT_URI);
          return page(res, "Signed in", "Spotamp is connected to your Spotify account. You can close this tab.");
        } catch (err) {
          return page(res, "Sign-in failed", err.message);
        }
      }

      // ---------- player ----------
      if (url.pathname === "/api/now") return json(res, await now());
      if (url.pathname === "/api/sources") return json(res, await sources());
      if (url.pathname === "/api/tracks") {
        const source = url.searchParams.get("source") || "liked";
        return json(res, await tracks(source, Number(url.searchParams.get("offset")) || 0));
      }
      if (url.pathname === "/api/play-track" && req.method === "POST") {
        const { uri, context } = await readJson(req);
        await playOnDevice(context ? { context_uri: context, offset: { uri } } : { uris: [uri] });
        return res.writeHead(204).end();
      }
      if (url.pathname.startsWith("/api/cmd/") && req.method === "POST") {
        const cmd = COMMANDS[url.pathname.slice(9)];
        if (!cmd) return res.writeHead(400).end("unknown command");
        await withDevice(cmd);
        return res.writeHead(204).end();
      }
      if (url.pathname === "/api/seek" && req.method === "POST") {
        const t = Number(url.searchParams.get("t"));
        if (!Number.isFinite(t)) return res.writeHead(400).end("bad t");
        await spotify.api("PUT", `/me/player/seek?position_ms=${Math.round(t * 1000)}`);
        return res.writeHead(204).end();
      }
      if (url.pathname === "/silence.wav") {
        return sendWav(req, res, silentWav(Number(url.searchParams.get("d")) || 1));
      }

      // ---------- static ----------
      if (url.pathname === "/webamp.mjs") return sendFile(res, path.join(webampBuilt, "webamp.bundle.min.mjs"));
      if (url.pathname === "/setup") return sendFile(res, path.join(here, "setup.html"));
      return sendFile(res, path.join(here, "player.html"));
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(String(err.message || err));
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}
