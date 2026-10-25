// Spotify Web API with the user's own app (Client ID) and PKCE sign-in.
// Settings and tokens live in <userData>/config.json (readable only by the user).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const API = "https://api.spotify.com/v1";
const ACCOUNTS = "https://accounts.spotify.com";
export const SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-library-read",
  "playlist-read-private",
  "playlist-read-collaborative",
].join(" ");

let file = null;
let config = {};

export function init(dataDir) {
  file = path.join(dataDir, "config.json");
  try {
    config = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    config = {};
  }
}

function save() {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export const status = () => ({ clientId: config.clientId || null, signedIn: !!config.tokens?.refresh_token });

export function setClientId(id) {
  config.clientId = String(id).trim();
  delete config.tokens;
  save();
}

export function signOut() {
  delete config.tokens;
  save();
}

// ---------- PKCE ----------
const pending = new Map(); // state → verifier
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function authorizeUrl(redirectUri) {
  if (!config.clientId) throw new Error("Set a Client ID first");
  const verifier = b64url(crypto.randomBytes(48));
  const state = b64url(crypto.randomBytes(16));
  pending.set(state, verifier);
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const q = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    scope: SCOPES,
    redirect_uri: redirectUri,
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  return `${ACCOUNTS}/authorize?${q}`;
}

async function tokenRequest(params) {
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Spotify sign-in failed: ${data.error_description || data.error || res.status}`);
  // Spotify rotates refresh tokens: always keep the newest one
  config.tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || config.tokens?.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  save();
}

export async function finishSignIn({ code, state, error }, redirectUri) {
  if (error) throw new Error(`Spotify sign-in was cancelled: ${error}`);
  const verifier = pending.get(state);
  if (!verifier) throw new Error("This sign-in link has expired. Start again from Spotamp.");
  pending.delete(state);
  await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
}

let refreshing = null;
async function token() {
  if (!config.tokens?.refresh_token) throw new Error("Not signed in to Spotify");
  if (config.tokens.expires_at - Date.now() < 60_000) {
    refreshing ??= tokenRequest({ grant_type: "refresh_token", refresh_token: config.tokens.refresh_token })
      .finally(() => (refreshing = null));
    await refreshing;
  }
  return config.tokens.access_token;
}

export async function api(method, pathname, body) {
  const res = await fetch(API + pathname, {
    method,
    headers: {
      authorization: `Bearer ${await token()}`,
      ...(body && { "content-type": "application/json" }),
    },
    body: body && JSON.stringify(body),
  });
  if (res.status === 204 || res.status === 202) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${pathname}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
