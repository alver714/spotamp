// Spotamp: classic Winamp (Webamp) as a Spotify player for macOS.
// A frameless widget that pops up on a global hotkey and lives in the menu bar.
const {
  app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, screen, shell,
} = require("electron");
const path = require("node:path");
const { Engine } = require("./engine.cjs");

const HOTKEY = process.env.SPOTAMP_HOTKEY || "Control+Alt+W";
const UI_PORT = Number(process.env.SPOTAMP_UI_PORT) || 5174;
const DSP_PORT = Number(process.env.SPOTAMP_DSP_PORT) || 5187;
const ORIGIN = `http://127.0.0.1:${UI_PORT}`;
const RESOURCES = app.isPackaged ? process.resourcesPath : path.join(__dirname, "..");

// Our silent tracks must start without a click, like a normal player.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

if (!app.requestSingleInstanceLock()) app.quit();

let widget = null;
let setup = null;
let tray = null;
let engine = null;
let spotify = null;
let source = "liked";

// ---------- widget ----------
function createWidget() {
  const { workArea } = screen.getPrimaryDisplay();
  widget = new BrowserWindow({
    width: 275,
    height: 348,
    x: workArea.x + workArea.width - 275 - 24,
    y: workArea.y + 24,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.cjs") },
  });
  widget.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  widget.loadURL(`${ORIGIN}/?widget&dsp=${DSP_PORT}`);
}

function toggle() {
  if (!widget) return;
  if (widget.isVisible()) widget.hide();
  else widget.show();
}

// The page drags the whole window by Winamp's title bars.
let grab = null;
ipcMain.on("widget:hide", () => widget?.hide());
ipcMain.on("widget:drag-start", (_e, x, y) => {
  const [wx, wy] = widget.getPosition();
  grab = { dx: x - wx, dy: y - wy };
});
ipcMain.on("widget:drag-move", (_e, x, y) => {
  if (grab) widget.setPosition(Math.round(x - grab.dx), Math.round(y - grab.dy));
});

// ---------- first-run setup ----------
function openSetup() {
  if (setup) return setup.focus();
  setup = new BrowserWindow({
    width: 560,
    height: 830,
    title: "Set up Spotamp",
    resizable: false,
    webPreferences: { preload: path.join(__dirname, "preload.cjs") },
  });
  setup.loadURL(`${ORIGIN}/setup`);
  setup.on("closed", () => (setup = null));
  app.dock?.show();
}

ipcMain.on("open-url", (_e, url) => {
  if (/^https:\/\/|^http:\/\/127\.0\.0\.1:/.test(url)) shell.openExternal(url);
});
ipcMain.on("engine:start", () => engine.start());
ipcMain.on("setup:done", () => {
  setup?.close();
  app.dock?.hide();
  if (!widget) createWidget();
  widget.once("ready-to-show", () => widget.show());
  if (widget.webContents.isLoading()) return;
  widget.reload();
  widget.show();
});

// ---------- menu bar ----------
// Winamp has a single playlist, so the source is picked here: Liked Songs or
// any of your own Spotify playlists. The list is fresh every time the menu opens.
function pick(id) {
  source = id;
  widget?.webContents.executeJavaScript(`window.switchSource(${JSON.stringify(id)})`);
  if (widget && !widget.isVisible()) widget.show();
}

async function openTrayMenu() {
  let items = [];
  if (spotify.status().signedIn) {
    try {
      const list = await (await fetch(`${ORIGIN}/api/sources`)).json();
      items = list.map((s) => ({
        label: `${s.name}  (${s.total})`,
        type: "radio",
        checked: s.id === source,
        enabled: s.readable,
        click: () => pick(s.id),
      }));
      if (list.some((s) => !s.readable)) {
        items.push({ label: "Greyed out: Spotify doesn't share other people's playlists", enabled: false });
      }
    } catch (err) {
      items = [{ label: `Couldn't load playlists: ${err.message}`, enabled: false }];
    }
    items.push({ type: "separator" });
  }
  tray.popUpContextMenu(
    Menu.buildFromTemplate([
      ...items,
      { label: `Show or hide (${HOTKEY.replace("Control", "⌃").replace("Alt", "⌥").replace(/\+/g, "")})`, click: toggle },
      { label: "Set up Spotify…", click: openSetup },
      { type: "separator" },
      { label: "Quit Spotamp", role: "quit" },
    ])
  );
}

// ---------- startup ----------
app.whenReady().then(async () => {
  app.dock?.hide();
  process.env.SPOTAMP_UI_PORT = String(UI_PORT);
  process.env.SPOTAMP_DSP_PORT = String(DSP_PORT);

  spotify = await import("./spotify.mjs");
  spotify.init(app.getPath("userData"));

  engine = new Engine({
    resources: RESOURCES,
    dataDir: app.getPath("userData"),
    dspPort: DSP_PORT,
    uiPort: UI_PORT,
    openUrl: (url) => shell.openExternal(url),
  });

  const { startServer } = await import("./server.mjs");
  try {
    await startServer({ engineStatus: () => engine.status() });
  } catch (err) {
    const { dialog } = require("electron");
    dialog.showErrorBox("Spotamp can't start", `Port ${UI_PORT} is busy (${err.code}). Quit whatever uses it, or set SPOTAMP_UI_PORT.`);
    return app.quit();
  }

  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle("♫");
  tray.setToolTip("Spotamp");
  tray.on("click", openTrayMenu);
  tray.on("right-click", openTrayMenu);

  if (!globalShortcut.register(HOTKEY, toggle)) {
    console.error(`Hotkey ${HOTKEY} is taken by another app; use the menu bar icon or set SPOTAMP_HOTKEY.`);
  }

  if (spotify.status().signedIn && engine.signedIn) {
    engine.start();
    createWidget();
  } else {
    if (engine.signedIn) engine.start();
    openSetup();
  }
});

app.on("second-instance", () => (setup ? setup.focus() : widget?.show()));
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  engine?.stop();
});
// The widget hides instead of closing; the app lives until Quit.
app.on("window-all-closed", (e) => e.preventDefault());

// For scripts and debugging: `kill -USR2 <pid>` works like the hotkey.
process.on("SIGUSR2", toggle);
