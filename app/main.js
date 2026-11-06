'use strict';
/*
 * SweetMusic desktop shell (thin Electron wrapper for https://music.sweetai.work).
 * Per ELECTRON-SPEC.md: shell stays thin — window, menus, external links in the
 * system browser, media keys, persistent login session. The site is the app;
 * site updates are client updates.
 *
 * SM_BASELINE=1 disables the tuned startup path so startup/size/memory can be
 * A/B measured against the naive implementation (used by selftest only).
 * SM_SELFTEST=1 runs the scripted acceptance sequence and prints JSON results.
 */
const { app, BrowserWindow, Menu, shell, globalShortcut, session, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const https = require('https');

const SITE = process.env.SM_SITE_URL || 'https://staging.libremusic.pages.dev'; // PREVIEW TIP ONLY - do not merge this commit to main
const SITE_HOST = 'music.sweetai.work';
const BASELINE = process.env.SM_BASELINE === '1';
const SELFTEST = process.env.SM_SELFTEST === '1';
const T0 = Date.now();
const marks = { t0: T0 };
function mark(name) { marks[name] = Date.now() - T0; }

// A dedicated music player should not be gated by Chromium's autoplay policy:
// every play in this shell follows an explicit user action inside the app.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Hardware acceleration stays ON (Chromium default): the v1.0.0 tuned
// path disabled it for VM self-tests and shipped that way to real
// machines, forcing every animation (spinning disc, backdrop-filter
// blur, ambient glow) onto CPU software rendering - user-measured
// jank everywhere (2026-11-05). Do not re-add any GPU-off switch.

// Clean Chrome UA: Google sign-in rejects user agents that advertise Electron
// ("disallowed_useragent"). The shell identifies as plain Chrome on the
// platform it runs on; version filled in once the app is ready.
function chromeUA() {
  const v = process.versions.chrome || '130.0.0.0';
  // The SweetMusicApp marker lets the web app switch on its
  // shell-only chrome (drag regions, traffic-light / caption-button
  // clearances) without affecting the plain browser experience.
  const marker = ` SweetMusicApp/${app.getVersion()}`;
  if (process.platform === 'darwin') return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36${marker}`;
  if (process.platform === 'win32') return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36${marker}`;
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36${marker}`;
}

// ---- window bounds persistence -------------------------------------------
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
function loadBounds() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (s && s.width >= 940 && s.height >= 600) return s;
  } catch (_) { /* first run */ }
  return { width: 1280, height: 860 };
}
function saveBounds(win) {
  if (BASELINE) return; // tuned-path feature
  try { fs.writeFileSync(stateFile(), JSON.stringify(win.getBounds())); } catch (_) {}
}

// ---- link policy -----------------------------------------------------------
// In-app: the site itself + the auth surfaces it legitimately navigates to
// (Google OAuth, the mail/relay + API hosts under sweetai.work). Everything
// else goes to the system browser.
function isInApp(url) {
  try {
    const u = new URL(url);
    if (u.hostname === SITE_HOST || u.hostname.endsWith('.sweetai.work')) return true;
    if (u.hostname === 'accounts.google.com') return true;
    if (u.hostname.endsWith('.google.com')) return true;
    if (u.hostname === 'www.google.com') return true;
    return false;
  } catch (_) { return false; }
}

let mainWindow = null;

function wireWindow(win) {
  win.webContents.setUserAgent(chromeUA());
  // window.open(): keep auth popups inside the shell (same persistent
  // partition, so the session cookie lands in the login store); send real
  // external targets to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isInApp(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520, height: 680, autoHideMenuBar: true,
          backgroundColor: '#0b0b10',
          webPreferences: { partition: 'persist:sweetmusic', contextIsolation: true, sandbox: true },
        },
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  // Top-level navigation away from the app surfaces → system browser.
  win.webContents.on('will-navigate', (e, url) => {
    if (!isInApp(url)) { e.preventDefault(); shell.openExternal(url); }
  });
}

function createWindow() {
  const b = loadBounds();
  const opts = {
    width: b.width, height: b.height,
    x: b.x, y: b.y,
    minWidth: 940, minHeight: 600,
    title: 'SweetMusic',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      partition: 'persist:sweetmusic', // persistent login session partition
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  };
  // Fused title bar (user directive 2026-11-06): no stock OS strip
  // above the glass UI. macOS keeps its traffic lights, floated
  // over the app's own top area (hiddenInset); Windows gets the
  // native caption buttons drawn by the OS in the app's colors
  // (titleBarOverlay). The web app supplies the drag regions and
  // clearances when it sees the SweetMusicApp UA marker.
  if (process.platform === 'darwin') {
    opts.titleBarStyle = 'hiddenInset';
    opts.trafficLightPosition = { x: 16, y: 16 };
  } else if (process.platform === 'win32') {
    opts.titleBarStyle = 'hidden';
    opts.titleBarOverlay = { color: '#0b0b10', symbolColor: '#f4f2fa', height: 44 };
  }
  if (!BASELINE) {
    opts.show = false;                    // no white flash; show on ready-to-show
    opts.backgroundColor = '#0b0b10';     // site dark base while loading
  }
  mainWindow = new BrowserWindow(opts);
  wireWindow(mainWindow);
  if (!BASELINE) {
    mainWindow.once('ready-to-show', () => { mark('shown'); mainWindow.show(); });
  } else {
    mark('shown');
  }
  mainWindow.webContents.once('did-finish-load', () => {
    mark('loaded');
    if (SELFTEST) runSelfTest(mainWindow).catch((e) => finish({ ok: false, error: String(e) }));
  });
  let saveTimer = null;
  mainWindow.on('close', () => saveBounds(mainWindow));
  mainWindow.on('resize', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveBounds(mainWindow), 400);
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadURL(SITE);
  return mainWindow;
}

// ---- media keys --------------------------------------------------------------
// Forward hardware media keys to the page player. Play/pause drives the
// <audio> element directly; next/prev click the player bar buttons the site
// itself renders (same controls the user would tap).
async function mediaCommand(cmd) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const js = `(async () => {
    const a = document.querySelector('#audio');
    if (${JSON.stringify(cmd)} === 'play-pause') {
      if (!a) return 'no-audio';
      if (a.paused) { await a.play(); return 'playing'; }
      a.pause(); return 'paused';
    }
    const sel = ${JSON.stringify(cmd)} === 'next'
      ? ['#barNext', '#fpNext', '#nextBtn']
      : ['#barPrev', '#fpPrev', '#prevBtn'];
    for (const s of sel) { const el = document.querySelector(s); if (el) { el.click(); return 'clicked:' + s; } }
    return 'no-button';
  })()`;
  try { return await mainWindow.webContents.executeJavaScript(js); }
  catch (e) { return 'error:' + e.message; }
}

function registerMediaKeys() {
  const map = {
    MediaPlayPause: 'play-pause',
    MediaNextTrack: 'next',
    MediaPreviousTrack: 'prev',
  };
  const reg = {};
  for (const [key, cmd] of Object.entries(map)) {
    reg[key] = globalShortcut.register(key, () => { mediaCommand(cmd); });
  }
  return reg;
}

// ---- menus -------------------------------------------------------------------
function buildMenu() {
  if (BASELINE) return; // naive path keeps Electron's default menu
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: 'SweetMusic',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: '播放',
      submenu: [
        { label: '播放 / 暂停', accelerator: 'Space', click: () => mediaCommand('play-pause') },
        { label: '下一首', accelerator: 'CmdOrCtrl+Right', click: () => mediaCommand('next') },
        { label: '上一首', accelerator: 'CmdOrCtrl+Left', click: () => mediaCommand('prev') },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '窗口',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(isMac ? [{ role: 'front' }] : [{ role: 'close' }])],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- update check (detect + one-click download) ------------------------------
// No electron-updater: mac builds are ad-hoc signed only, so Squirrel.Mac
// signature validation would likely fail on install. Instead the shell polls
// the GitHub Releases "latest" endpoint and, when a newer version exists,
// offers a native dialog whose primary button opens the platform asset in
// the system browser. Checks run ~10s after launch and every 6h after;
// network failures are silent and never retried aggressively.
const UPDATE_API = 'https://api.github.com/repos/dylanXM/sweetmusic-releases/releases/latest';
const UPDATE_RELEASES_PAGE = 'https://github.com/dylanXM/sweetmusic-releases/releases/latest';
const UPDATE_PROMPT_INTERVAL_MS = 24 * 3600 * 1000;
let updatePromptOpen = false;
const updateStateFile = () => path.join(app.getPath('userData'), 'update-check.json');

function loadUpdateState() {
  try { return JSON.parse(fs.readFileSync(updateStateFile(), 'utf8')) || {}; } catch (_) { return {}; }
}
function saveUpdateState(s) {
  try { fs.writeFileSync(updateStateFile(), JSON.stringify(s)); } catch (_) { /* read-only fs: prompting just repeats next launch */ }
}

// Dotted-numeric compare: true when a is strictly newer than b.
function semverGt(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

function fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'SweetMusic-Desktop/' + app.getVersion(),
        'Accept': 'application/vnd.github+json',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        fetchJson(res.headers.location, timeoutMs).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function fetchLatestRelease() {
  // Self-test injection: SM_FAKE_LATEST holds a JSON release object.
  if (process.env.SM_FAKE_LATEST) {
    try { return JSON.parse(process.env.SM_FAKE_LATEST); } catch (_) { return null; }
  }
  return fetchJson(UPDATE_API, 8000);
}

function pickAssetUrl(release, platform, arch) {
  platform = platform || process.platform;
  arch = arch || process.arch;
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  const find = (pred) => {
    const a = assets.find((x) => x && x.browser_download_url && pred(String(x.name || '')));
    return a ? a.browser_download_url : null;
  };
  let url = null;
  if (platform === 'win32') url = find((n) => n.toLowerCase().endsWith('.exe'));
  else if (platform === 'darwin') url = find((n) => n.indexOf(arch === 'arm64' ? 'mac-arm64' : 'mac-x64') !== -1 && n.toLowerCase().endsWith('.zip'));
  else if (platform === 'linux') url = find((n) => n.endsWith('.AppImage'));
  return url || (release && release.html_url) || UPDATE_RELEASES_PAGE;
}

// Returns a decision object (used by the self-test); shows the dialog
// unless dryRun is set. Never throws.
async function checkForUpdates(dryRun) {
  let rel = null;
  try { rel = await fetchLatestRelease(); } catch (_) { return null; }
  if (!rel || !rel.tag_name) return null;
  const latest = String(rel.tag_name).replace(/^v/i, '').trim();
  const current = app.getVersion();
  const decision = { current, latest, hasUpdate: semverGt(latest, current) };
  if (!decision.hasUpdate) return decision;
  decision.assetUrl = pickAssetUrl(rel);
  decision.assetsByPlatform = {
    win32: pickAssetUrl(rel, 'win32', 'x64'),
    'darwin-arm64': pickAssetUrl(rel, 'darwin', 'arm64'),
    'darwin-x64': pickAssetUrl(rel, 'darwin', 'x64'),
    linux: pickAssetUrl(rel, 'linux', 'x64'),
  };
  const notes = String(rel.body || '').replace(/\r/g, '').trim();
  decision.message = 'SweetMusic ' + latest + ' 已发布';
  decision.detail = '当前版本 ' + current + '。\n\n' + (notes ? notes.slice(0, 400) : '包含改进与修复。');
  if (dryRun) return decision;
  const st = loadUpdateState();
  if (st.lastPrompted && st.lastPrompted.version === latest && Date.now() - (st.lastPrompted.ts || 0) < UPDATE_PROMPT_INTERVAL_MS) return decision;
  if (updatePromptOpen) return decision;
  updatePromptOpen = true;
  st.lastPrompted = { version: latest, ts: Date.now() };
  saveUpdateState(st);
  try {
    const opts = {
      type: 'info',
      title: '发现新版本',
      message: decision.message,
      detail: decision.detail,
      buttons: ['立即下载', '稍后再说'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    const res = (mainWindow && !mainWindow.isDestroyed())
      ? await dialog.showMessageBox(mainWindow, opts)
      : await dialog.showMessageBox(opts);
    if (res.response === 0) shell.openExternal(decision.assetUrl);
  } catch (_) { /* silent: a failed prompt must never disturb playback */
  } finally {
    updatePromptOpen = false;
  }
  return decision;
}

function scheduleUpdateChecks() {
  setTimeout(() => { checkForUpdates(false).catch(() => {}); }, 10000);
  setInterval(() => { checkForUpdates(false).catch(() => {}); }, 6 * 3600 * 1000);
}

// SM_UPDATE_SELFTEST=1 (with SM_FAKE_LATEST set): dry-run the checker once
// and print the decision as JSON, without touching the network or dialogs.
async function runUpdateSelfTest() {
  try {
    await sleep(1200);
    const d = await checkForUpdates(true);
    console.log('SM_UPDATE_TEST ' + JSON.stringify(d));
  } catch (e) {
    console.log('SM_UPDATE_TEST ' + JSON.stringify({ error: String(e) }));
  }
  setTimeout(() => app.quit(), 300);
}

// ---- self test -----------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(win, js, timeout = 30000, step = 250) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await win.webContents.executeJavaScript(js); if (last) return last; } catch (_) {}
    await sleep(step);
  }
  throw new Error('waitFor timeout: ' + js.slice(0, 80) + ' last=' + JSON.stringify(last));
}

async function runSelfTest(win) {
  const out = { mode: BASELINE ? 'baseline' : 'optimized', marks };
  // 1) page up, search box present
  await waitFor(win, `!!document.querySelector('#searchInput, input[type="search"], input[placeholder*="搜"]')`, 45000);
  mark('searchReady'); out.marks = { ...marks };
  // 2) run a search for a well-known track and wait for result rows
  await win.webContents.executeJavaScript(`(() => {
    const inp = document.querySelector('#searchInput, input[type="search"], input[placeholder*="搜"]');
    inp.focus();
    inp.value = '周杰伦 晴天';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const form = document.querySelector('#searchForm') || inp.closest('form');
    if (form && form.requestSubmit) form.requestSubmit();
    const btn = [...document.querySelectorAll('button')].find(b => /搜索|search/i.test(b.textContent || ''));
    if (btn) btn.click();
    return inp.value;
  })()`);
  await waitFor(win, `(() => { const w = document.querySelector('#resultsWrap');
    return w && [...w.querySelectorAll('div,li')].some(el => /\\d+:\\d{2}/.test(el.textContent || '') && el.querySelector('button')); })()`, 45000);
  mark('resultsReady'); out.marks = { ...marks };
  // 3) press play on the first playable row (row's own play button, per site UX)
  const playInfo = await win.webContents.executeJavaScript(`(() => {
    const w = document.querySelector('#resultsWrap');
    if (!w) return null;
    const rows = [...w.querySelectorAll('div,li')]
      .filter(r => /\\d+:\\d{2}/.test(r.textContent || '') && r.querySelector('button') && r.children.length < 12);
    for (const r of rows) {
      const b = r.querySelector('button');
      if (b) { b.click(); return (r.textContent || '').trim().slice(0, 60); }
    }
    return null;
  })()`);
  out.clickedRow = playInfo;
  // 4) audio element must exist and its clock must advance
  await waitFor(win, `!!document.querySelector('#audio')`, 20000);
  const t1 = await win.webContents.executeJavaScript(`document.querySelector('#audio').currentTime`);
  await sleep(3000);
  const probe = await win.webContents.executeJavaScript(`(() => { const a = document.querySelector('#audio');
    return { t: a.currentTime, paused: a.paused, src: (a.currentSrc || '').slice(0, 80), ready: a.readyState }; })()`);
  out.audio = { t1, ...probe };
  out.playing = probe.t > t1 + 0.3 && !probe.paused;
  mark('playing'); out.marks = { ...marks };
  // 5) media-key path: pause + resume through the same function the OS keys call
  out.mediaPause = await mediaCommand('play-pause');
  await sleep(600);
  out.afterPause = await win.webContents.executeJavaScript(`document.querySelector('#audio').paused`);
  out.mediaResume = await mediaCommand('play-pause');
  await sleep(600);
  out.afterResume = await win.webContents.executeJavaScript(`!document.querySelector('#audio').paused`);
  // 6) memory footprint (all app processes)
  const metrics = app.getAppMetrics();
  out.memoryKB = metrics.reduce((s, m) => s + (m.memory.workingSetSize || 0), 0);
  out.processes = metrics.length;
  // 7) session persistence partition sanity: a cookie jar exists for the site partition
  const ses = session.fromPartition('persist:sweetmusic');
  const cookies = await ses.cookies.get({ domain: SITE_HOST });
  out.siteCookies = cookies.length;
  out.ok = out.playing === true;
  finish(out);
}

let finished = false;
function finish(obj) {
  if (finished) return; finished = true;
  console.log('SM_SELFTEST_RESULT ' + JSON.stringify(obj));
  setTimeout(() => app.quit(), 300);
}

// ---- app lifecycle --------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(() => {
    mark('ready');
    buildMenu();
    createWindow();
    const reg = registerMediaKeys();
    if (SELFTEST) console.log('SM_MEDIAKEYS ' + JSON.stringify(reg));
    if (!SELFTEST) scheduleUpdateChecks();
    if (process.env.SM_UPDATE_SELFTEST === '1') runUpdateSelfTest();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
