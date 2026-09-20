/**
 * Save a real run of the Department for Transport traffic counts to
 * `data/snapshot/`, so the dashboard can also be opened with no network.
 *
 * Run it with `node tools/build-snapshot.mjs`. It is a development tool:
 * nothing the page loads imports it.
 *
 * The feed code the page uses is a classic script, not a module, so it cannot
 * be imported. It is run here instead, in this process, exactly as the browser
 * runs it: the file leaves its functions on `globalThis.DftTrafficDemo` and
 * they are read from there. One copy of the feed code, used by both.
 *
 * The feed already bounds the slice to the most recent four years, so this
 * tool writes whatever the live page would have kept.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'data', 'snapshot');

const feedFile = join(here, '..', 'src', 'dft-feed.js');
runInThisContext(await readFile(feedFile, 'utf8'), { filename: feedFile });
const { fetchInitial, encodeRow, SNAPSHOT_COLUMNS, YEARS, DATA_URL } = globalThis.DftTrafficDemo;

const started = Date.now();
const { rows } = await fetchInitial({
  onProgress: (message, fraction) => {
    const pct = Math.round((fraction || 0) * 100);
    process.stdout.write(`\r  ${message} (${pct}%)`);
  },
});
process.stdout.write('\n');

/* Sorted by id so the file is stable and diffable between runs. */
const values = rows.map(encodeRow);
values.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

const seconds = Number(((Date.now() - started) / 1000).toFixed(1));

const meta = {
  fetchedAt: new Date().toISOString(),
  fetchedAtMs: Date.now(),
  seconds,
  rows: values.length,
  years: YEARS,
  source: 'Department for Transport road traffic statistics (AADF)',
  sourceUrl: 'https://roadtraffic.dft.gov.uk/downloads',
  dataUrl: DATA_URL,
  licence: 'Open Government Licence v3.0',
  columns: SNAPSHOT_COLUMNS,
};

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'counts.json'), JSON.stringify(values));
await writeFile(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));

const bytes = (await stat(join(outDir, 'counts.json'))).size;
console.log(`\nSaved ${values.length} count rows across ${YEARS[0]}-${YEARS[YEARS.length - 1]} in ${seconds}s.`);
console.log(`counts.json is ${(bytes / 1024 / 1024).toFixed(1)} MB.`);
