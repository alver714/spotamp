// Runs the audio pipeline:  librespot → dsp.mjs → pcm-out
// librespot is a Spotify Connect device named "Spotamp". It signs in once
// through the browser and then keeps its own credentials in <userData>/librespot.
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEVICE = process.env.SPOTAMP_DEVICE || "Spotamp";

class Engine {
  /**
   * @param {object} o
   * @param {string} o.resources  folder with engine/ and vendor/bin/
   * @param {string} o.dataDir    app data folder
   * @param {number} o.dspPort
   * @param {number} o.uiPort
   * @param {(url: string) => void} o.openUrl
   */
  constructor(o) {
    Object.assign(this, o);
    this.bin = path.join(o.resources, "vendor", "bin");
    this.cache = path.join(o.dataDir, "librespot");
    this.state = "stopped"; // stopped | signing-in | starting | running | error
    this.error = null;
    this.procs = [];
    this.stopping = false;
    fs.mkdirSync(this.cache, { recursive: true });

    // librespot splits the --onevent value on spaces, and app paths usually
    // contain some ("Application Support"). Link the hook from a space-free path.
    this.eventHook = path.join(os.tmpdir(), `spotamp-event-${process.getuid()}.sh`);
    try { fs.unlinkSync(this.eventHook); } catch {}
    fs.symlinkSync(path.join(o.resources, "engine", "event.sh"), this.eventHook);

    // The hook writes events into this FIFO and the DSP reads them.
    this.eventFifo = path.join(os.tmpdir(), `spotamp-events-${process.getuid()}.fifo`);
    try { fs.unlinkSync(this.eventFifo); } catch {}
    execFileSync("mkfifo", ["-m", "600", this.eventFifo]);
  }

  get signedIn() {
    return fs.existsSync(path.join(this.cache, "credentials.json"));
  }

  status() {
    return { state: this.state, error: this.error, signedIn: this.signedIn };
  }

  start() {
    this.stopping = false;
    if (this.signedIn) this.run();
    else this.signIn();
  }

  stop() {
    this.stopping = true;
    for (const p of this.procs) p.kill();
    this.procs = [];
  }

  // One-time browser sign-in. librespot prints the link on stdout, which is
  // the audio pipe in normal runs, so this run is separate and has no audio.
  signIn() {
    this.state = "signing-in";
    const p = spawn(path.join(this.bin, "librespot"), [
      "-n", DEVICE, "-B", "pipe", "-j", "-c", this.cache, "-C", this.cache,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    this.procs = [p];
    let opened = false;
    const scan = (chunk) => {
      const m = /Browse to: (https:\/\/accounts\.spotify\.com\/\S+)/.exec(chunk.toString());
      if (m && !opened) {
        opened = true;
        this.openUrl(m[1]);
      }
    };
    p.stdout.on("data", scan);
    p.stderr.on("data", scan);
    const wait = setInterval(() => {
      if (!this.signedIn) return;
      clearInterval(wait);
      p.kill();
    }, 500);
    p.on("exit", () => {
      clearInterval(wait);
      if (this.stopping) return;
      if (this.signedIn) this.run();
      else this.fail("Spotify sign-in for the player engine did not finish.");
    });
  }

  run() {
    this.state = "starting";
    this.error = null;
    const env = {
      ...process.env,
      SPOTAMP_DSP_PORT: String(this.dspPort),
      SPOTAMP_UI_PORT: String(this.uiPort),
      SPOTAMP_EVENT_FIFO: this.eventFifo,
    };
    // Electron's own binary runs plain Node scripts with this flag.
    const dsp = spawn(process.execPath, [path.join(this.resources, "engine", "dsp.mjs")], {
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out = spawn(path.join(this.bin, "pcm-out"), [], { stdio: ["pipe", "ignore", "pipe"] });
    const librespot = spawn(path.join(this.bin, "librespot"), [
      "-n", DEVICE, "-F", "speaker",
      "-B", "pipe", "-f", "F32", "-b", "320",
      "--volume-ctrl", "fixed", "-R", "100",
      "--autoplay", "off",
      "--onevent", this.eventHook,
      "-c", this.cache, "-C", this.cache,
    ], { env, stdio: ["ignore", "pipe", "pipe"] });

    librespot.stdout.pipe(dsp.stdin);
    dsp.stdout.pipe(out.stdin);
    for (const s of [librespot.stdout, dsp.stdin, dsp.stdout, out.stdin]) s.on("error", () => {});
    this.procs = [librespot, dsp, out];

    librespot.stderr.on("data", (d) => {
      const text = d.toString();
      if (/Authenticated as/.test(text)) this.state = "running";
      // saved credentials stopped working: sign in again
      if (/INVALID_CREDENTIALS|BadCredentials/i.test(text)) {
        fs.rmSync(path.join(this.cache, "credentials.json"), { force: true });
      }
      if (process.env.SPOTAMP_DEBUG) process.stderr.write(text);
    });
    dsp.stderr.on("data", (d) => process.env.SPOTAMP_DEBUG && process.stderr.write(d));
    out.stderr.on("data", (d) => process.stderr.write(d));

    // Any piece dies: tear down the rest and start over.
    let restarting = false;
    for (const p of this.procs) {
      p.on("exit", () => {
        if (restarting || this.stopping) return;
        restarting = true;
        for (const q of this.procs) q.kill();
        this.state = "starting";
        setTimeout(() => !this.stopping && this.start(), 2000);
      });
    }
  }

  fail(message) {
    this.state = "error";
    this.error = message;
  }
}

module.exports = { Engine };
