// Spotamp audio engine: sits between librespot and the speakers.
//
//   librespot -B pipe -f F32 | node dsp.mjs | pcm-out
//
// I/O: 32-bit float LE, stereo, 44100 Hz. The output side (pcm-out) sets the
// clock: it pulls in real time, and stdout backpressure paces everything else.
//
// The player page connects over WebSocket (ws://127.0.0.1:$SPOTAMP_DSP_PORT):
//   {t:'state', volume:0..1, hold:bool}   volume knob, instant pause/resume
//   {t:'eq', on, preamp, bands:{60:…}}    Winamp equalizer, sliders 0..100
//   {t:'flush'}                           user switched tracks: drop old audio
// and receives:
//   {t:'vu', level, buf}                  output level, seconds buffered
//   binary frames                         output PCM, Int16 stereo (visualizer)
//
// librespot reports playback events through engine/event.sh → $SPOTAMP_EVENT_FIFO

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';

const RATE = 44100;
const PORT = Number(process.env.SPOTAMP_DSP_PORT) || 5187;
const ALLOWED_ORIGIN = new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${Number(process.env.SPOTAMP_UI_PORT) || 5174}$`);
const BLOCK = 512;               // frames per render block
const RING = RATE * 8;           // input ring, frames
// How much audio we keep ahead. librespot decodes far faster than real time,
// so without a cap the ring fills up and every track switch lags behind.
const HIGH_WATER = Math.round(RATE * 0.8);
const LOW_WATER = Math.round(RATE * 0.4);

// ---------- input ring ----------
const bufL = new Float32Array(RING);
const bufR = new Float32Array(RING);
let writeIdx = 0;           // frames received (monotonic)
let readPos = 0;            // frames played (monotonic)
let inputPaused = false;
let leftover = Buffer.alloc(0); // tail of an incomplete frame from the last chunk

// ---------- track switch quarantine ----------
// After a flush, old audio is still in transit and librespot keeps decoding the
// old track until Spotify's command reaches it. librespot then stops the old
// track, reports "loading" (engine/event.sh → the event FIFO), and starts
// writing the new track after a short loading gap. That gap is the boundary:
// after the event we drain the old transit and admit the first chunk that
// follows a natural gap, i.e. a gap with no input pause of ours inside it.
//
// The event must arrive fast: through curl it took 50–100 ms, long enough for
// the new track to start, and a later gap inside it got picked instead. A FIFO
// written by the shell's printf delivers it in a few milliseconds.
//
// Until the event, dropped audio is consumed at real-time pace (qPending):
// read it unthrottled and librespot would race through the old track to its end.
const TRACK_EVENTS = new Set(['loading', 'playing', 'seeked', 'track_changed']);
const NATURAL_GAP_MS = 15;       // a loading gap is at least this long
const EVENT_SETTLE_MS = 250;     // no gap after the event: take what comes
const EVENT_TIMEOUT_MS = 5000;   // no event (command lost): fall back to gaps
const FALLBACK_GAP_MS = 150;
let quarantine = false;
let awaitEvent = false;
let flushAt = 0;
let eventAt = 0;
let lastPcmAt = 0;
let pausedSinceChunk = false; // our own pause happened since the last chunk
let dropped = 0;              // frames dropped in this quarantine
let qPending = 0;             // dropped frames still "playing" in real time

function pauseInput() {
  pausedSinceChunk = true;
  if (!inputPaused) { inputPaused = true; process.stdin.pause(); }
}
function resumeInput() {
  if (inputPaused) { inputPaused = false; process.stdin.resume(); }
}

function ingest(chunk) {
  const now = Date.now();
  // Always split on whole frames: dropping raw bytes would shift the 8-byte
  // frame phase and turn the stream into float garbage.
  const data = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
  const frames = Math.floor(data.length / 8);
  leftover = Buffer.from(data.subarray(frames * 8));
  const gap = now - lastPcmAt;
  const natural = gap >= NATURAL_GAP_MS && !pausedSinceChunk;
  lastPcmAt = now;
  pausedSinceChunk = false;
  if (!frames) return;

  if (quarantine) {
    let admit = false;
    if (awaitEvent) admit = now - flushAt > EVENT_TIMEOUT_MS && gap >= FALLBACK_GAP_MS;
    else admit = natural || now - eventAt > EVENT_SETTLE_MS;
    if (!admit) {
      dropped += frames;
      if (awaitEvent) {
        qPending += frames;
        if (qPending > HIGH_WATER) pauseInput();
      }
      return;
    }
    quarantine = false;
    log(`track boundary: ${awaitEvent ? 'gap fallback' : natural ? `${gap} ms gap` : 'settled'}; `
      + `event ${awaitEvent ? 'missing' : `after ${eventAt - flushAt} ms`}, `
      + `audio from ${now - flushAt} ms, dropped ${(dropped / RATE).toFixed(2)} s of old audio`);
  }

  for (let i = 0; i < frames; i++) {
    const at = writeIdx % RING;
    const l = data.readFloatLE(i * 8);
    const r = data.readFloatLE(i * 8 + 4);
    // a non-finite sample would poison the filter state forever
    bufL[at] = Number.isFinite(l) ? l : 0;
    bufR[at] = Number.isFinite(r) ? r : 0;
    writeIdx++;
  }
  if (writeIdx - readPos > HIGH_WATER) pauseInput();
}

process.stdin.on('data', ingest);
process.stdin.on('end', () => setTimeout(() => process.exit(0), 200));
process.stdin.on('error', () => process.exit(1));

function flush() {
  readPos = writeIdx;   // forget what is buffered
  musicRamp = 0;        // fade the new track in over a few ms (no click)
  quarantine = true;
  awaitEvent = true;
  flushAt = lastPcmAt = Date.now();
  pausedSinceChunk = false;
  dropped = 0;
  qPending = 0;
}

function onPlayerEvent(name) {
  if (!quarantine || !awaitEvent || !TRACK_EVENTS.has(name)) return;
  awaitEvent = false;
  eventAt = Date.now();
  // librespot has dropped the old track: drain the rest of the transit fast
  qPending = 0;
  pausedSinceChunk = true; // the gap up to now was ours, not librespot's
  resumeInput();
}

// librespot events arrive on a FIFO (see engine/event.sh), one per line.
// Opening it read-write keeps it from hitting EOF between writers.
if (process.env.SPOTAMP_EVENT_FIFO) {
  const fd = fs.openSync(process.env.SPOTAMP_EVENT_FIFO, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
  let pendingLine = '';
  // net.Socket polls the pipe through libuv; fs streams choke on EAGAIN here
  new net.Socket({ fd, readable: true, writable: false }).on('data', (d) => {
    const lines = (pendingLine + d.toString()).split('\n');
    pendingLine = lines.pop();
    for (const line of lines) onPlayerEvent(line.trim().split(' ')[0]);
  });
}

// ---------- biquads (RBJ cookbook) ----------
function biquad(kind, f0, q, dbGain) {
  const A = Math.pow(10, dbGain / 40);
  const w = (2 * Math.PI * f0) / RATE;
  const cw = Math.cos(w), sw = Math.sin(w);
  const al = sw / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (kind === 'lowshelf' || kind === 'highshelf') {
    const s = 2 * Math.sqrt(A) * al;
    const sign = kind === 'lowshelf' ? 1 : -1;
    b0 = A * ((A + 1) - sign * (A - 1) * cw + s);
    b1 = 2 * sign * A * ((A - 1) - sign * (A + 1) * cw);
    b2 = A * ((A + 1) - sign * (A - 1) * cw - s);
    a0 = (A + 1) + sign * (A - 1) * cw + s;
    a1 = -2 * sign * ((A - 1) + sign * (A + 1) * cw);
    a2 = (A + 1) + sign * (A - 1) * cw - s;
  } else {
    b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A;
    a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A;
  }
  const st = { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
  st.run = (x) => {
    const y = st.b0 * x + st.b1 * st.x1 + st.b2 * st.x2 - st.a1 * st.y1 - st.a2 * st.y2;
    st.x2 = st.x1; st.x1 = x; st.y2 = st.y1; st.y1 = y;
    return y;
  };
  return st;
}

// ---------- Winamp equalizer ----------
// Same bands and shapes as Webamp: shelves at the edges, peaks in between;
// slider 0..100, 50 = 0 dB, ends = ±12 dB.
const EQ_BANDS = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];
const EQ = { on: true, preamp: 50, bands: Object.fromEntries(EQ_BANDS.map((f) => [f, 50])) };
const sliderDb = (v) => ((Math.max(0, Math.min(100, v)) - 50) / 50) * 12;
const eqL = [], eqR = [];
let eqPre = 1;

// New coefficients, old filter state: dragging a slider does not click.
function rebuildEq() {
  EQ_BANDS.forEach((f, i) => {
    const kind = f === 60 ? 'lowshelf' : f === 16000 ? 'highshelf' : 'peaking';
    const db = EQ.on ? sliderDb(EQ.bands[f]) : 0;
    for (const chain of [eqL, eqR]) {
      const next = biquad(kind, f, kind === 'peaking' ? 1.4 : 0.7, db);
      const prev = chain[i];
      if (prev) Object.assign(next, { x1: prev.x1, x2: prev.x2, y1: prev.y1, y2: prev.y2 });
      chain[i] = next;
    }
  });
  eqPre = EQ.on ? Math.pow(10, sliderDb(EQ.preamp) / 20) : 1;
}
rebuildEq();

// ---------- render ----------
const P = { volume: 0.7, hold: false };
let gain = Math.pow(P.volume, 1.7);
let holdAmp = 1;    // pause envelope (~6 ms, no click)
let musicRamp = 1;  // fade-in after a flush or an underrun
const out = Buffer.allocUnsafe(BLOCK * 8);

const TAP_FRAMES = 1024;
const tap = Buffer.alloc(TAP_FRAMES * 4);
let tapN = 0;
let vuAcc = 0, vuN = 0;

function renderBlock() {
  const gainT = Math.pow(Math.max(0, Math.min(1, P.volume)), 1.7);
  const holdT = P.hold ? 0 : 1;
  for (let n = 0; n < BLOCK; n++) {
    gain += (gainT - gain) * 0.0001;
    holdAmp += (holdT - holdAmp) * 0.004;
    const frozen = P.hold && holdAmp < 0.002; // paused: keep our place in the ring
    let l = 0, r = 0;
    if (!frozen && readPos < writeIdx) {
      const at = readPos % RING;
      l = bufL[at]; r = bufR[at];
      readPos++;
      musicRamp += (1 - musicRamp) * 0.0009;
      l *= musicRamp; r *= musicRamp;
    } else if (!frozen) {
      musicRamp += (0 - musicRamp) * 0.0002; // buffer ran dry: soften the cut
    }

    l *= eqPre; r *= eqPre;
    for (let i = 0; i < eqL.length; i++) { l = eqL[i].run(l); r = eqR[i].run(r); }

    l *= gain * holdAmp; r *= gain * holdAmp;
    // soft limiter instead of hard clipping
    if (Math.abs(l) > 0.95) l = Math.sign(l) * (0.95 + Math.tanh((Math.abs(l) - 0.95) * 2) * 0.05);
    if (Math.abs(r) > 0.95) r = Math.sign(r) * (0.95 + Math.tanh((Math.abs(r) - 0.95) * 2) * 0.05);

    out.writeFloatLE(l, n * 8);
    out.writeFloatLE(r, n * 8 + 4);
    vuAcc += l * l + r * r; vuN += 2;
    if (clients.size) {
      tap.writeInt16LE(Math.round(l * 32767), tapN * 4);
      tap.writeInt16LE(Math.round(r * 32767), tapN * 4 + 2);
      if (++tapN === TAP_FRAMES) { tapN = 0; broadcastBinary(tap); }
    }
  }
  if (vuN >= RATE / 5) {
    const level = Math.min(1, Math.sqrt(vuAcc / vuN) * 3.2);
    const buf = (writeIdx - readPos) / RATE;
    broadcast(JSON.stringify({ t: 'vu', level: Math.round(level * 100) / 100, buf: Math.round(buf * 100) / 100 }));
    vuAcc = 0; vuN = 0;
  }
  qPending = Math.max(0, qPending - BLOCK); // dropped audio leaves in real time
  if (writeIdx - readPos + qPending < LOW_WATER) resumeInput();
}

function pump() {
  for (;;) {
    renderBlock();
    if (!process.stdout.write(Buffer.from(out))) {
      process.stdout.once('drain', pump);
      return;
    }
  }
}
process.stdout.on('error', () => process.exit(0)); // speakers went away

// ---------- control messages ----------
function handleMsg(text) {
  let m;
  try { m = JSON.parse(text); } catch { return; }
  if (m.t === 'state') {
    if (typeof m.volume === 'number') P.volume = Math.max(0, Math.min(1, m.volume));
    if (typeof m.hold === 'boolean') P.hold = m.hold;
  } else if (m.t === 'eq') {
    if (typeof m.on === 'boolean') EQ.on = m.on;
    if (typeof m.preamp === 'number') EQ.preamp = m.preamp;
    for (const f of EQ_BANDS) if (typeof m.bands?.[f] === 'number') EQ.bands[f] = m.bands[f];
    rebuildEq();
  } else if (m.t === 'flush') {
    flush();
  }
}

// ---------- minimal WebSocket server (no dependencies) ----------
function wsFrame(payload, op = 1) {
  const data = Buffer.from(payload);
  if (data.length < 126) return Buffer.concat([Buffer.from([0x80 | op, data.length]), data]);
  const head = Buffer.alloc(4);
  head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(data.length, 2);
  return Buffer.concat([head, data]);
}

function parseWsFrame(buf) {
  if (buf.length < 2) return null;
  const op = buf[0] & 0x0f;
  const masked = !!(buf[1] & 0x80);
  let len = buf[1] & 0x7f, off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  const maskOff = off;
  if (masked) off += 4;
  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[maskOff + (i & 3)];
  return { op, payload, consumed: off + len };
}

const clients = new Set();
function broadcast(json) {
  if (!clients.size) return;
  const frame = wsFrame(json);
  for (const s of clients) { try { s.write(frame); } catch {} }
}
function broadcastBinary(buf) {
  const frame = wsFrame(buf, 2);
  for (const s of clients) {
    if (s.writableLength > 256 * 1024) continue; // slow client: skip, don't queue
    try { s.write(frame); } catch {}
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(426); res.end('spotamp engine');
});
server.on('upgrade', (req, sock) => {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGIN.test(origin)) { sock.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key) { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  clients.add(sock);
  sock.on('close', () => clients.delete(sock));
  sock.on('error', () => clients.delete(sock));
  let acc = Buffer.alloc(0);
  sock.on('data', (d) => {
    acc = acc.length ? Buffer.concat([acc, d]) : d;
    for (let f; (f = parseWsFrame(acc)); ) {
      acc = Buffer.from(acc.subarray(f.consumed));
      if (f.op === 8) { clients.delete(sock); sock.end(); return; }
      if (f.op === 9) { sock.write(wsFrame(f.payload, 10)); continue; }
      if (f.op === 1) handleMsg(f.payload.toString('utf8'));
    }
  });
});
server.listen(PORT, '127.0.0.1', () => log(`listening on ws://127.0.0.1:${PORT}`));

function log(msg) { process.stderr.write(`[dsp] ${msg}\n`); }

pump();
