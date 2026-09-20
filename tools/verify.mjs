/**
 * Load the demo in a real browser and check that it works.
 *
 * Serves the project and opens the saved copy, so the check never depends on
 * the Department for Transport download being reachable. It does depend on
 * jsDelivr, because that is where the page gets the grid from.
 *
 * It asserts the things this demo exists to show:
 *
 *   - the library arrived by classic script tag (no type="module", pinned
 *     release, integrity hashes, each file left its global);
 *   - the counts table holds rows and the line, bar and histogram charts drew
 *     marks;
 *   - the headline figures agree with the saved data, recomputed here;
 *   - grouping the counts table, the year-by-class pivot, and the derived
 *     grids (by authority, by class, the Pareto head);
 *   - routing a pushed row lands on the row it belongs to rather than adding
 *     a duplicate;
 *   - a filter on the counts table moves the tiles;
 *   - `grid.statistics.profile('allMotorVehicles')` reports a mean and median.
 *
 * It then blocks the download in the browser and opens the live page, to prove
 * a visitor gets the saved copy, and is told so, when the DfT cannot be
 * reached.
 *
 * Exits non-zero when any of that fails, so it can gate a deployment.
 *
 * Usage: node tools/verify.mjs [--all] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const args = process.argv.slice(2);
const shotIndex = args.indexOf('--shots');
const shotDir = shotIndex >= 0 ? resolve(args[shotIndex + 1]) : null;
const all = args.includes('--all');

const GRID_VERSION = '1.66.0';
const CDN_BASE = `https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@${GRID_VERSION}/`;
const LIBRARY_TAGS = [
  { file: 'lattice-grid.min.js', global: 'LatticeGrid', member: 'createGrid' },
  { file: 'modules/charts.min.js', global: 'LatticeGrid', member: 'createChart' },
  { file: 'modules/data-router.min.js', global: 'LatticeGridDataRouter', member: 'createDataRouter' },
  { file: 'modules/kpi.min.js', global: 'LatticeGridKPI', member: 'createKPI' },
  { file: 'modules/tabs.min.js', global: 'LatticeGridTabs', member: 'createTabs' },
];

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean);

async function findChrome() {
  for (const path of CHROME_CANDIDATES) {
    try {
      await access(path);
      return path;
    } catch {}
  }
  throw new Error(`No browser found. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}\nSet CHROME_PATH to point at one.`);
}

function requireModernNode() {
  if (typeof WebSocket === 'undefined') {
    throw new Error(`This check needs Node 22 or newer. You are running ${process.version}, which has no built in WebSocket.`);
  }
}

function freePort() {
  return new Promise((ok, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

const failures = [];
const notes = [];

function check(ok, description, detail) {
  if (ok) {
    notes.push(`  ok   ${description}${detail ? ` (${detail})` : ''}`);
  } else {
    failures.push(`${description}${detail ? ` (${detail})` : ''}`);
    notes.push(`  FAIL ${description}${detail ? ` (${detail})` : ''}`);
  }
}

let browser;
let browserPid = null;
let profile;
let server;

try {
  requireModernNode();
  const chromePath = await findChrome();
  const started = await startServer(0);
  server = started.server;
  const origin = `http://127.0.0.1:${started.port}`;
  console.log(`Browser: ${chromePath}`);
  console.log(`Serving: ${origin}`);

  profile = await mkdtemp(join(tmpdir(), 'dft-traffic-umd-demo-verify-'));
  const port = await freePort();
  browser = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  browserPid = browser.pid;
  browser.stderr.on('data', () => {});

  let wsUrl;
  for (let i = 0; i < 150 && !wsUrl; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) wsUrl = (await response.json()).webSocketDebuggerUrl;
    } catch {}
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) throw new Error('the browser never opened its debugging port');

  const socket = new WebSocket(wsUrl);
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = () => fail(new Error('could not attach to the browser'));
  });

  let nextId = 0;
  const pending = new Map();
  let consoleErrors = [];
  let pageErrors = [];

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id != null && pending.has(message.id)) {
      const { resolve: ok, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else ok(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      pageErrors.push(details.exception?.description || details.text);
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      consoleErrors.push(message.params.entry.text);
    }
  };

  const send = (method, params = {}, sessionId) =>
    new Promise((ok, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: ok, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);

  await call('Page.enable');
  await call('Runtime.enable');
  await call('Log.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text + ' ' + (result.exceptionDetails.exception?.description || ''));
    }
    return result.result.value;
  };

  const waitFor = async (expression, timeout, what) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      let value;
      try {
        value = await evaluate(expression);
      } catch {}
      if (value) return value;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  const open = async (url, label) => {
    consoleErrors = [];
    pageErrors = [];
    console.log(`\n--- ${label} ---\n${url}`);
    await call('Page.navigate', { url });
    await waitFor('!!(window.__dftTrafficDemo)', 120000, `${label} to load`);
    const state = await evaluate('({ ready: window.__dftTrafficDemo.ready, error: window.__dftTrafficDemo.error || null })');
    if (!state.ready) throw new Error(`${label} reported a failure: ${state.error}`);
    await waitFor('window.__dftTrafficDemo.detailGrid && window.__dftTrafficDemo.detailGrid.rows.count() > 0', 60000, `${label} rows`);
  };

  const shoot = async (name) => {
    if (!shotDir) return;
    await mkdir(shotDir, { recursive: true });
    const { data } = await call('Page.captureScreenshot', { format: 'png' });
    const file = join(shotDir, `${name}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    console.log(`  shot ${file}`);
  };

  const noErrors = (label) => {
    check(consoleErrors.length === 0, `${label}: no console errors`, consoleErrors.slice(0, 3).join(' | '));
    check(pageErrors.length === 0, `${label}: no page errors`, pageErrors.slice(0, 3).join(' | '));
  };

  /* =================================================================== */
  /* 1. The saved copy.                                                  */
  /* =================================================================== */

  await open(`${origin}/index.html?source=snapshot`, 'saved copy');

  /* ---- how the library arrived ---- */

  const delivery = await evaluate(`(() => {
    const scripts = [...document.querySelectorAll('script')];
    return {
      moduleScripts: scripts.filter((s) => s.type === 'module').length,
      importmaps: scripts.filter((s) => s.type === 'importmap').length,
      librarySrcs: scripts.map((s) => s.getAttribute('src') || '').filter((src) => /cdn\\.jsdelivr\\.net/.test(src)),
      withIntegrity: scripts.filter((s) => /cdn\\.jsdelivr\\.net/.test(s.src) && s.integrity).length,
      stylesheetSrc: (document.querySelector('link[rel=stylesheet][href*="cdn.jsdelivr.net"]') || {}).href || null,
      members: {
        createGrid: typeof (window.LatticeGrid || {}).createGrid,
        createHeadlessGrid: typeof (window.LatticeGrid || {}).createHeadlessGrid,
        setLicence: typeof (window.LatticeGrid || {}).setLicence,
        createChart: typeof (window.LatticeGrid || {}).createChart,
        createDataRouter: typeof (window.LatticeGridDataRouter || {}).createDataRouter,
        createKPI: typeof (window.LatticeGridKPI || {}).createKPI,
        createTabs: typeof (window.LatticeGridTabs || {}).createTabs,
      },
    };
  })()`);
  console.log(`  library tags: ${delivery.librarySrcs.length} from the CDN, ${delivery.withIntegrity} with an integrity hash; module scripts on the page: ${delivery.moduleScripts}`);
  check(delivery.moduleScripts === 0, 'delivery: no type="module" script on the page', `${delivery.moduleScripts}`);
  check(delivery.importmaps === 0, 'delivery: no import map on the page', `${delivery.importmaps}`);
  check(delivery.librarySrcs.length === LIBRARY_TAGS.length, `delivery: ${LIBRARY_TAGS.length} library script tags point at the CDN`, `${delivery.librarySrcs.length}`);
  for (const tag of LIBRARY_TAGS) {
    const wanted = `${CDN_BASE}${tag.file}`;
    check(delivery.librarySrcs.includes(wanted), `delivery: ${tag.file} is loaded from the pinned ${GRID_VERSION} release`, wanted);
    check(delivery.members[tag.member] === 'function', `delivery: ${tag.file} left ${tag.global}.${tag.member} behind`, delivery.members[tag.member]);
  }
  check(delivery.withIntegrity === LIBRARY_TAGS.length, 'delivery: every library tag carries an integrity hash', `${delivery.withIntegrity} of ${LIBRARY_TAGS.length}`);
  check(delivery.stylesheetSrc === `${CDN_BASE}lattice-grid.min.css`, `delivery: the stylesheet is loaded from the pinned ${GRID_VERSION} release`, delivery.stylesheetSrc);
  check(delivery.members.setLicence === 'function', 'delivery: setLicence is on the core global');
  check(delivery.members.createHeadlessGrid === 'function', 'delivery: createHeadlessGrid is on the core global');

  const snap = await evaluate(`(() => {
    const d = window.__dftTrafficDemo;
    return {
      rows: d.detailGrid.rows.count(),
      total: d.detailGrid.rows.totalCount(),
      painted: document.querySelectorAll('.lattice [role="row"]').length,
      charts: d.charts.length,
      watermark: d.detailGrid.licence.watermark(),
      licenceState: d.detailGrid.licence.state(),
      tiles: Object.fromEntries(d.kpi.tiles().map((t) => [t.id, t.value])),
      named: document.querySelector('.kpi-named-value').textContent,
      authorityRows: d.authorityGrid ? d.authorityGrid.rows.count() : 0,
      classRows: d.classGrid ? d.classGrid.rows.count() : 0,
      paretoRows: d.paretoGrid ? d.paretoGrid.rows.count() : 0,
      pivotRows: d.pivotGrid ? d.pivotGrid.rows.count() : 0,
      stats: { mean: d.aadfProfile && d.aadfProfile.mean, median: d.aadfProfile && d.aadfProfile.median, p95: d.aadfP95 },
    };
  })()`);
  console.log(`  ${snap.rows} rows, ${snap.painted} painted, ${snap.charts} charts`);
  console.log(`  tiles: ${JSON.stringify(snap.tiles)}`);
  console.log(`  derived: authority ${snap.authorityRows}, class ${snap.classRows}, pareto ${snap.paretoRows}; pivot ${snap.pivotRows}`);
  console.log(`  stats: mean ${snap.stats.mean}, median ${snap.stats.median}, p95 ${snap.stats.p95}`);

  check(snap.rows > 0, 'saved copy: the counts table holds rows', `${snap.rows}`);
  check(snap.painted > 0, 'saved copy: the table painted rows', `${snap.painted}`);
  check(snap.charts === 3, 'saved copy: all three charts were built', `${snap.charts}`);
  check(snap.authorityRows > 0, 'saved copy: the by-authority derived grid holds rows', `${snap.authorityRows}`);
  check(snap.classRows === 6, 'saved copy: the by-class derived grid holds six classes', `${snap.classRows}`);
  check(snap.paretoRows > 0, 'saved copy: the Pareto-head derived grid holds rows', `${snap.paretoRows}`);
  check(snap.pivotRows > 0, 'saved copy: the pivot grid holds rows', `${snap.pivotRows}`);
  check(snap.watermark === false, 'saved copy: no watermark on localhost', `state ${snap.licenceState}`);

  /* Each chart is asked what it actually plotted, so an empty pair of axes is
     not mistaken for a chart. */
  const drawn = await evaluate(`(() => window.__dftTrafficDemo.charts.map((c, i) => {
    const el = c.element;
    const marks = el ? el.querySelectorAll('path, rect, circle, line').length : 0;
    const data = c.data();
    const series = (data && data.series) || [];
    const points = series.reduce((n, s) => n + ((s.points || []).length), 0);
    const withValue = series.reduce((n, s) => n + (s.points || []).filter((p) => p.y != null && p.y !== 0).length, 0);
    return { i, marks, points, withValue };
  }))()`);
  for (const c of drawn) {
    console.log(`  chart ${c.i}: ${c.marks} marks, ${c.points} points, ${c.withValue} with a value`);
    check(c.marks > 2, `saved copy: chart ${c.i} drew marks`, `${c.marks} marks`);
    check(c.withValue > 0, `saved copy: chart ${c.i} plotted values rather than empty axes`, `${c.withValue} of ${c.points} points carry a measure`);
  }
  /* ------------------------------------------------------------------ */
  /* The main grid, specifically.                                        */
  /* ------------------------------------------------------------------ */

  /*
   * `snap.painted` counts `[role="row"]` across every `.lattice` on the page,
   * so any one grid with rows satisfies it. That is a different question from
   * "did the grid this page is built around draw anything", which is the one
   * a reader actually cares about, and which the summary grids beside it can
   * answer for it. So this asks about that one grid, and counts only *data*
   * rows -- the sticky totals row and the header row are `.lat-row` too, and
   * carry no `data-index`.
   */
  const mainGrid = await evaluate(`(() => {
    const host = document.querySelector('.primary-host') || document.querySelector('.tabs-host');
    const root = host && host.querySelector('.lattice');
    const viewport = root && root.querySelector('.lat-body-viewport');
    if (!root) return { found: false };
    return {
      found: true,
      dataRows: viewport ? viewport.querySelectorAll('.lat-row[data-index]').length : 0,
      anyRows: viewport ? viewport.querySelectorAll('.lat-row').length : 0,
      bodyCells: viewport ? viewport.querySelectorAll('[role="gridcell"]').length : 0,
      columnHeaders: root.querySelectorAll('[role="columnheader"]').length,
      viewportHeight: viewport ? Math.round(viewport.getBoundingClientRect().height) : 0,
    };
  })()`);
  console.log(`  main grid: ${mainGrid.dataRows} data rows, ${mainGrid.bodyCells} body cells, `
    + `${mainGrid.columnHeaders} column headers, body ${mainGrid.viewportHeight}px tall`);

  check(mainGrid.found, 'saved copy: the main grid exists');
  check(mainGrid.dataRows > 0, 'saved copy: the main grid painted at least one data row',
    `${mainGrid.dataRows} data rows in a body ${mainGrid.viewportHeight}px tall`);
  check(mainGrid.bodyCells > 0, 'saved copy: the main grid painted cells', `${mainGrid.bodyCells}`);
  check(mainGrid.columnHeaders > 0, 'saved copy: the main grid drew a column header row',
    `${mainGrid.columnHeaders}`);

  /*
   * The right-hand tool rail is off on every grid this page builds. It is a
   * developer's control surface, not part of the story a reader came for, and
   * it takes a strip off the side of every table. `toolPanel` is off by
   * default, so this asks that nothing has turned it back on -- in the shared
   * base config, or on any one grid.
   */
  const rails = await evaluate(
    `document.querySelectorAll('.lat-panel-dock').length`,
  );
  console.log(`  tool rails on the page: ${rails}`);
  check(rails === 0, 'saved copy: no grid shows the right-hand tool rail', `${rails} rail(s)`);

  noErrors('saved copy');
  await shoot('01-counts');

  /* Independent recomputation from the saved data. */
  const meta = JSON.parse(await readFile(join(root, 'data', 'snapshot', 'meta.json'), 'utf8'));
  const values = JSON.parse(await readFile(join(root, 'data', 'snapshot', 'counts.json'), 'utf8'));
  const cols = meta.columns;
  const savedRows = values.map((v) => Object.fromEntries(cols.map((c, i) => [c, v[i]])));

  const records = savedRows.length;
  const totalFlow = savedRows.reduce((s, r) => s + r.allMotorVehicles, 0);
  const avgFlow = totalFlow / records;
  const countPoints = new Set(savedRows.map((r) => r.countPointId)).size;
  let busiest = null;
  for (const r of savedRows) if (!busiest || r.allMotorVehicles > busiest.allMotorVehicles) busiest = r;

  const near = (a, b, eps) => Math.abs(a - b) <= eps;
  check(snap.tiles.records === records, 'saved copy: the count tile matches the saved data', `tile ${snap.tiles.records}, expected ${records}`);
  check(snap.tiles.countPoints === countPoints, 'saved copy: the count-points tile matches the saved data', `tile ${snap.tiles.countPoints}, expected ${countPoints}`);
  check(snap.tiles.totalFlow === totalFlow, 'saved copy: the total-flow tile matches the saved data', `tile ${snap.tiles.totalFlow}, expected ${totalFlow}`);
  check(near(snap.tiles.avgFlow, avgFlow, 0.5), 'saved copy: the average-flow tile matches the saved data', `tile ${snap.tiles.avgFlow}, expected ${avgFlow.toFixed(1)}`);
  check(snap.named === busiest.roadName, 'saved copy: the busiest road is named', `${snap.named}, expected ${busiest.roadName} (${busiest.allMotorVehicles} vehicles a day)`);

  /* ---- the statistics surface ---- */

  check(
    typeof snap.stats.mean === 'number' && typeof snap.stats.median === 'number' && typeof snap.stats.p95 === 'number',
    'saved copy: statistics reports a mean, a median and a p95',
    `mean ${snap.stats.mean}, median ${snap.stats.median}, p95 ${snap.stats.p95}`,
  );
  check(near(snap.stats.mean, avgFlow, 0.5), 'saved copy: the statistics mean matches the saved data', `mean ${snap.stats.mean}, expected ${avgFlow.toFixed(1)}`);

  /* ---- grouping the counts table ---- */

  await evaluate("window.__dftTrafficDemo.detailGrid.columns.group(['region'])");
  await sleep(700);
  const groupedRegion = await evaluate(`(() => {
    const d = window.__dftTrafficDemo;
    let groups = 0;
    d.detailGrid.rows.forEach((r) => { if (r && r.group) groups += 1; });
    return { groups };
  })()`);
  check(groupedRegion.groups > 0, 'grouping by region produces group rows', `${groupedRegion.groups} groups`);
  await evaluate("window.__dftTrafficDemo.detailGrid.columns.group(['roadCategory'])");
  await sleep(700);
  const groupedCategory = await evaluate(`(() => {
    const d = window.__dftTrafficDemo;
    let groups = 0;
    d.detailGrid.rows.forEach((r) => { if (r && r.group) groups += 1; });
    return { groups };
  })()`);
  check(groupedCategory.groups > 0, 'grouping by road category produces group rows', `${groupedCategory.groups} groups`);
  await evaluate('window.__dftTrafficDemo.detailGrid.columns.group([])');
  await sleep(400);
  await shoot('02-grouped');

  /* ---- the pivot produced year rows and class columns ---- */

  const pivot = await evaluate(`(() => {
    const d = window.__dftTrafficDemo;
    const g = d.pivotGrid;
    const state = g.state.get();
    const text = g.element ? g.element.textContent : '';
    return {
      grouped: (state.group || []).includes('year'),
      pivoted: state.pivot && state.pivot.enabled && (state.pivot.columns || []).includes('class'),
      hasClassHeader: text.includes('Cars and taxis'),
      hasTotalHeader: text.includes('All classes'),
      rows: g.rows.count(),
    };
  })()`);
  console.log(`  pivot: ${pivot.rows} rows, grouped by year ${pivot.grouped}, pivoted by class ${pivot.pivoted}`);
  check(pivot.grouped, 'the pivot grid grouped by year');
  check(pivot.pivoted, 'the pivot grid pivoted by vehicle class');
  check(pivot.hasClassHeader, 'the pivot spread the classes into columns', 'class headings rendered');
  check(pivot.hasTotalHeader, 'the pivot shows the grand total across all classes', '"All classes" column');

  /* ---- routing a pushed row ---- */

  const pushed = await evaluate(`(async () => {
    const d = window.__dftTrafficDemo;
    let target = null;
    d.detailGrid.rows.forEachAll((r) => { if (!target && r && r.data && typeof r.data.allMotorVehicles === 'number') target = r.data; });
    const before = { count: d.detailGrid.rows.count(), id: target.id, flow: target.allMotorVehicles };
    const revised = Object.assign({}, target, { allMotorVehicles: target.allMotorVehicles + 1000, carsAndTaxis: target.carsAndTaxis + 1000 });
    d.ingest([revised]);
    await new Promise((r) => setTimeout(r, 500));
    let found = null;
    d.detailGrid.rows.forEachAll((r) => { if (r && r.data && r.data.id === before.id) found = r.data; });
    return { before, after: { count: d.detailGrid.rows.count(), flow: found ? found.allMotorVehicles : null } };
  })()`);
  console.log(`  pushed revision: ${pushed.before.id} flow ${pushed.before.flow} -> ${pushed.after.flow}, rows ${pushed.before.count} -> ${pushed.after.count}`);
  check(pushed.after.count === pushed.before.count, 'a pushed row lands on the row it belongs to rather than adding one', `${pushed.before.count} -> ${pushed.after.count}`);
  check(pushed.after.flow === pushed.before.flow + 1000, 'the pushed row carries its revised flow', `expected ${pushed.before.flow + 1000}, found ${pushed.after.flow}`);

  /* ---- a filter that moves the tiles ---- */

  const tilesBefore = await evaluate('Object.fromEntries(window.__dftTrafficDemo.kpi.tiles().map((t) => [t.id, t.value]))');
  const rowsBefore = await evaluate('window.__dftTrafficDemo.detailGrid.rows.count()');
  await evaluate('window.__dftTrafficDemo.motorwayButton.click()');
  await sleep(700);
  const tilesAfter = await evaluate('Object.fromEntries(window.__dftTrafficDemo.kpi.tiles().map((t) => [t.id, t.value]))');
  const rowsAfter = await evaluate('window.__dftTrafficDemo.detailGrid.rows.count()');
  console.log(`  motorways-only filter: rows ${rowsBefore} -> ${rowsAfter}; total-flow tile ${tilesBefore.totalFlow} -> ${tilesAfter.totalFlow}`);
  check(rowsAfter > 0 && rowsAfter < rowsBefore, 'the motorways-only filter narrows the table', `${rowsBefore} -> ${rowsAfter}`);
  check(tilesAfter.totalFlow > 0 && tilesAfter.totalFlow < tilesBefore.totalFlow, 'the motorways-only filter moves the total-flow tile', `${tilesBefore.totalFlow} -> ${tilesAfter.totalFlow}`);
  check(tilesAfter.records < tilesBefore.records, 'the motorways-only filter moves the count tile', `${tilesBefore.records} -> ${tilesAfter.records}`);
  await evaluate('window.__dftTrafficDemo.motorwayButton.click()');
  await sleep(500);
  await shoot('03-filtered');
  /* ------------------------------------------------------------------ */
  /* On a phone.                                                         */
  /* ------------------------------------------------------------------ */

  /*
   * A dashboard laid out across can leave one element wider than the screen,
   * and the whole page then scrolls sideways -- which on a phone is the first
   * thing a reader meets. Loaded narrow, nothing may stick out, and the grid
   * this page is built around must still draw rows.
   */
  await call('Emulation.setDeviceMetricsOverride', { width: 400, height: 900, deviceScaleFactor: 1, mobile: true });
  await open(`${origin}/index.html?source=snapshot`, 'saved copy, 400px wide');

  const narrow = await evaluate(`(() => {
    const de = document.documentElement;
    const host = document.querySelector('.primary-host') || document.querySelector('.tabs-host');
    const root = host && host.querySelector('.lattice');
    const viewport = root && root.querySelector('.lat-body-viewport');
    const widest = [];
    const clipped = (e) => getComputedStyle(e).overflowX !== 'visible';
    const walk = (e) => {
      for (const child of e.children) {
        const box = child.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue;
        if (box.right > de.clientWidth + 1) {
          widest.push(String(child.className || child.tagName).slice(0, 40) + ' @' + Math.round(box.right));
        }
        if (!clipped(child)) walk(child);
      }
    };
    walk(document.body);
    return {
      clientWidth: de.clientWidth,
      scrollWidth: de.scrollWidth,
      dataRows: viewport ? viewport.querySelectorAll('.lat-row[data-index]').length : 0,
      sticking: widest.slice(0, 5),
    };
  })()`);
  console.log(`  at 400px: scrollWidth ${narrow.scrollWidth} vs clientWidth ${narrow.clientWidth}, `
    + `${narrow.dataRows} data rows in the main grid`);
  if (narrow.sticking.length) console.log(`  sticking out: ${narrow.sticking.join(', ')}`);

  check(narrow.scrollWidth <= narrow.clientWidth, 'at 400px: the page does not scroll sideways',
    `scrollWidth ${narrow.scrollWidth} > clientWidth ${narrow.clientWidth}; ${narrow.sticking.join(', ')}`);
  check(narrow.dataRows > 0, 'at 400px: the main grid still paints data rows', `${narrow.dataRows}`);

  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  noErrors('saved copy, after the checks');

  /* =================================================================== */
  /* 2. What a visitor gets when the download cannot be reached.         */
  /* =================================================================== */

  await call('Network.enable');
  await call('Network.setBlockedURLs', { urls: ['*storage.googleapis.com*'] });
  await open(`${origin}/index.html`, 'live page, with the download unreachable');
  const fallback = await evaluate(`(() => {
    const d = window.__dftTrafficDemo;
    const notice = document.querySelector('.notice');
    const pill = document.querySelector('.head-note .pill');
    return {
      rows: d.detailGrid.rows.count(),
      painted: document.querySelectorAll('.lattice [role="row"]').length,
      fellBack: !!(d.timings && d.timings.fellBack),
      mode: d.timings && d.timings.mode,
      badge: pill ? pill.textContent.trim() : null,
      notice: notice ? notice.textContent.trim() : null,
      polling: !!d.poller,
    };
  })()`);
  console.log(`  rows ${fallback.rows}, badge "${fallback.badge}", fell back: ${fallback.fellBack}`);
  console.log(`  notice: ${fallback.notice}`);
  check(fallback.rows > 0, 'fallback: the saved copy is on screen', `${fallback.rows} rows`);
  check(fallback.painted > 0, 'fallback: the table painted rows', `${fallback.painted}`);
  check(fallback.fellBack, 'fallback: the page recorded that it fell back to the saved copy');
  check(fallback.mode === 'live', 'fallback: the page ran in the live default, not snapshot mode', `mode ${fallback.mode}`);
  check(fallback.badge === 'Saved copy', 'fallback: the badge reads "Saved copy"', `"${fallback.badge}"`);
  check(!!fallback.notice && /does not allow browser requests/i.test(fallback.notice),
    'fallback: the page says the download cannot be read by a browser', fallback.notice);
  check(!!fallback.notice && /saved copy/i.test(fallback.notice),
    'fallback: the page says what is on screen instead', fallback.notice);
  check(!!fallback.notice && !/will try again/i.test(fallback.notice),
    'fallback: the page does not invite a reload that cannot succeed', fallback.notice);
  check(!fallback.polling, 'fallback: no poll is started against a download that could not be reached');
  check(pageErrors.length === 0, 'fallback: no page errors', pageErrors.slice(0, 3).join(' | '));
  await shoot('04-fallback');
  await call('Network.setBlockedURLs', { urls: [] });

  if (all) {
    await open(`${origin}/index.html`, 'live');
    const live = await evaluate(`(() => {
      const d = window.__dftTrafficDemo;
      const notice = document.querySelector('.notice');
      return {
        rows: d.detailGrid.rows.count(),
        charts: d.charts.length,
        fellBack: !!(d.timings && d.timings.fellBack),
        mode: d.timings && d.timings.mode,
        watermark: d.detailGrid.licence.watermark(),
        freshness: document.querySelector('.freshness').textContent,
        notice: notice ? notice.textContent.trim() : null,
      };
    })()`);
    console.log(`  ${live.rows} rows in live mode; fell back ${live.fellBack}; ${live.freshness}`);
    /* The DfT bucket serves the CSV without CORS headers, so a browser can only
       read it same-origin. In a normal page the fetch is refused and the saved
       copy stands in, which is the honest behaviour for this data source. */
    check(live.mode === 'live', 'live: the page ran in the live default', `mode ${live.mode}`);
    check(live.rows > 0, 'live: the page holds rows', `${live.rows}`);
    check(live.charts === 3, 'live: all three charts were built', `${live.charts}`);
    check(live.watermark === false, 'live: no watermark on localhost');
    check(
      live.fellBack === false || (live.notice && /does not allow browser requests/i.test(live.notice)),
      'live: either the download was read or the fallback was explained',
      live.fellBack ? live.notice : 'downloaded',
    );
    await shoot('05-live');
  }

  socket.close();
} catch (error) {
  failures.push(String((error && error.stack) || error));
} finally {
  if (browserPid) {
    try { process.kill(-browserPid, 'SIGKILL'); } catch {}
    try { process.kill(browserPid, 'SIGKILL'); } catch {}
  }
  if (server) server.close();
  await sleep(400);
  if (profile) await rm(profile, { recursive: true, force: true });
}

console.log('\nChecks:');
for (const note of notes) console.log(note);

if (failures.length) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`\nAll ${notes.length} checks passed.`);
process.exit(0);
