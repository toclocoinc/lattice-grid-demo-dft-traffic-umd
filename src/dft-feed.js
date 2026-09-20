/**
 * The Department for Transport road traffic count feed: reading the bulk AADF
 * (annual average daily flow) CSV, turning each record into a flat row, and
 * producing the long-form vehicle-class rows the pivot and the by-class chart
 * read.
 *
 * Nothing here knows about the grid. It produces plain objects and hands them
 * to whoever asked, so the same code feeds the live page and the saved copy.
 *
 * The DfT publishes one all-time CSV (about 600,000 rows, one per count point
 * per year) as a zipped file, and needs no key. The file is far too large to
 * hold in a browser, so this feed keeps only the most recent few years, which
 * is what makes the snapshot a bounded slice and keeps the live page within
 * reach. The CSV is sorted by count point then year, and every string field is
 * double quoted; a handful of junction names carry an embedded comma, so the
 * lines are parsed with a small quote-aware parser rather than a bare split.
 *
 * This is a classic script, not a module: there is no `import` or `export`
 * anywhere on this page. What this file offers is put on `DftTrafficDemo`, a
 * plain object on the global, and the next script reads it from there. The
 * snapshot tool runs this same file under Node, which is why it looks for
 * `globalThis` rather than `window`.
 */
(function (root) {
  'use strict';

  /** The zipped all-time CSV, on the DfT road traffic statistics bucket. */
  const DATA_URL =
    'https://storage.googleapis.com/dft-statistics/road-traffic/downloads/data-gov-uk/dft_traffic_counts_aadf.zip';

  /** The most recent years the page keeps. The full file reaches back to 2000,
      but a four-year window keeps the snapshot a bounded, downloadable slice
      while still giving the line chart and the pivot a real time series. */
  const YEARS = [2022, 2023, 2024, 2025];

  /** How often the live page asks for a fresh copy. AADF figures are published
      annually rather than by the minute, so this is deliberately glacial. */
  const POLL_MS = 60 * 60 * 1000;

  /** The vehicle classes a record names, and the order the pivot and the
      by-class chart show them. `all_motor_vehicles` is the total, so it is not
      one of the parts. */
  const VEHICLE_CLASSES = [
    { field: 'pedalCycles', label: 'Pedal cycles' },
    { field: 'motorcycles', label: 'Motorcycles' },
    { field: 'carsAndTaxis', label: 'Cars and taxis' },
    { field: 'busesAndCoaches', label: 'Buses and coaches' },
    { field: 'lgvs', label: 'Light goods vehicles' },
    { field: 'hgvs', label: 'Heavy goods vehicles' },
  ];

  /** The DfT road-category codes, mapped to words for the pill and the lookup. */
  const ROAD_CATEGORY_LABELS = {
    PM: 'Principal motorway',
    TM: 'Trunk motorway',
    PA: 'Principal A road',
    TA: 'Trunk A road',
    MB: 'B road',
    MCU: 'C or unclassified',
  };

  /** The order the snapshot stores a wide row's fields in. */
  const SNAPSHOT_COLUMNS = [
    'id',
    'countPointId',
    'year',
    'region',
    'authority',
    'roadName',
    'roadCategory',
    'roadType',
    'pedalCycles',
    'motorcycles',
    'carsAndTaxis',
    'busesAndCoaches',
    'lgvs',
    'hgvs',
    'allMotorVehicles',
  ];

  /**
   * Parse one CSV line into its fields, honouring double-quoted fields that
   * carry an embedded comma (a junction name such as "Pierhead, Hugh Town")
   * and doubled quotes.
   *
   * @param {string} line one line of the CSV
   * @returns {string[]} the fields, unquoted
   */
  function parseCsvLine(line) {
    const fields = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            field += '"';
            i += 1;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(field);
        field = '';
      } else {
        field += ch;
      }
    }
    fields.push(field);
    return fields;
  }

  /** A number, or null when the field is not one. AADF columns are all
      integers in this file, but a defensive read costs nothing. */
  function num(value) {
    if (value == null || value === '' || value === 'NA') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Turn one parsed CSV record (34 fields) into a flat row, keeping only the
   * fields the grid shows.
   *
   * @param {string[]} f the fields from {@link parseCsvLine}
   * @returns {object} a flat row
   */
  function toRow(f) {
    const countPointId = num(f[0]);
    const year = num(f[1]);
    return {
      id: `${countPointId}:${year}`,
      countPointId,
      year,
      region: f[3],
      authority: f[6],
      roadName: f[8],
      roadCategory: f[9],
      roadType: f[10],
      pedalCycles: num(f[21]),
      motorcycles: num(f[22]),
      carsAndTaxis: num(f[23]),
      busesAndCoaches: num(f[24]),
      lgvs: num(f[25]),
      hgvs: num(f[32]),
      allMotorVehicles: num(f[33]),
    };
  }

  /**
   * Read the deflate stream out of a single-file zip and return the
   * uncompressed bytes. The DfT zip holds one CSV, so the local file header is
   * at the start of the buffer and the compressed data follows it directly.
   *
   * @param {ArrayBuffer} buffer the zip file
   * @returns {Uint8Array} the compressed CSV stream
   */
  function zipMember(buffer) {
    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== 0x04034b50) {
      throw new Error('The traffic data did not arrive as a zip file.');
    }
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const compressedSize = view.getUint32(18, true);
    const start = 30 + nameLength + extraLength;
    return new Uint8Array(buffer, start, compressedSize);
  }

  /**
   * Decompress a raw-deflate stream to text, using the streaming
   * `DecompressionStream` that both the browser and Node 22 provide.
   *
   * @param {Uint8Array} bytes a raw-deflate stream
   * @returns {Promise<string>} the uncompressed text
   */
  async function inflateText(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  }

  /**
   * Parse the uncompressed CSV text into rows, keeping only the years the demo
   * shows. The header line names the columns and is discarded.
   *
   * @param {string} text the full CSV text
   * @returns {object[]} the flat rows
   */
  function rowsFromCsv(text) {
    const lines = text.split('\n');
    const rows = [];
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line || line.trim() === '') continue;
      const f = parseCsvLine(line.replace(/\r$/, ''));
      const year = num(f[1]);
      if (year == null || YEARS.indexOf(year) === -1) continue;
      rows.push(toRow(f));
    }
    return rows;
  }

  /**
   * Fetch the zipped CSV and turn it into the page's flat rows.
   *
   * @param {{signal?: AbortSignal, onProgress?: Function}} [opts]
   * @returns {Promise<object[]>} the rows
   */
  async function fetchRows(opts = {}) {
    const report = opts.onProgress || (() => {});
    report('Downloading the Department for Transport traffic counts...', 0.1);
    const response = await fetch(DATA_URL, { signal: opts.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`The traffic data download answered ${response.status}.`);
    report('Unpacking the counts...', 0.5);
    const buffer = await response.arrayBuffer();
    const text = await inflateText(zipMember(buffer));
    report('Reading the most recent years...', 0.85);
    const rows = rowsFromCsv(text);
    report('Building the dashboard...', 1);
    return rows;
  }

  /**
   * Read everything the page starts from.
   *
   * @param {{signal?: AbortSignal, onProgress?: Function}} [opts]
   * @returns {Promise<{rows: object[]}>}
   */
  async function fetchInitial(opts = {}) {
    const rows = await fetchRows(opts);
    return { rows };
  }

  /**
   * Poll for a fresh copy and report each result.
   *
   * @param {object} opts
   * @param {(result: object) => void} opts.onPoll called with each successful poll
   * @param {(error: Error) => void} [opts.onError] called when a poll fails
   * @param {number} [opts.intervalMs] how often to poll
   * @returns {{stop: Function, pollNow: Function}} a handle that stops the polling
   */
  function startPolling({ onPoll, onError, intervalMs = POLL_MS }) {
    let stopped = false;
    let timer = null;
    const controller = new AbortController();

    const runOnce = async () => {
      if (stopped) return;
      try {
        const { rows } = await fetchInitial({ signal: controller.signal });
        if (!stopped) onPoll({ rows, fetchedAt: Date.now() });
      } catch (error) {
        if (!stopped && onError) onError(error);
      }
    };

    timer = setInterval(runOnce, intervalMs);

    return {
      stop() {
        stopped = true;
        clearInterval(timer);
        controller.abort();
      },
      pollNow: runOnce,
    };
  }

  /* ---------------- the snapshot ---------------- */

  /** Pack a wide row into the compact array form the snapshot stores. */
  function encodeRow(row) {
    return SNAPSHOT_COLUMNS.map((col) => row[col]);
  }

  /** Unpack a compact snapshot array back into a wide row. */
  function decodeRow(values) {
    const row = {};
    SNAPSHOT_COLUMNS.forEach((col, index) => {
      row[col] = values[index];
    });
    return row;
  }

  /**
   * Melt wide rows into long form: one row per count point, year and vehicle
   * class, carrying the class name and its flow. This is what the year-by-class
   * pivot and the by-class chart reduce.
   *
   * @param {object[]} rows the wide rows
   * @returns {object[]} one row per vehicle class per count point-year
   */
  function melt(rows) {
    const melted = [];
    for (const row of rows) {
      for (const cls of VEHICLE_CLASSES) {
        melted.push({
          id: `${row.id}:${cls.field}`,
          year: row.year,
          class: cls.label,
          flow: row[cls.field],
        });
      }
    }
    return melted;
  }

  /** Read the saved copy that ships with the demo. */
  async function readSnapshot() {
    const [values, meta] = await Promise.all(
      ['counts', 'meta'].map(async (name) => {
        const response = await fetch(`./data/snapshot/${name}.json`);
        if (!response.ok) throw new Error(`The saved copy is missing ${name}.json.`);
        return response.json();
      }),
    );
    return { rows: values.map(decodeRow), meta: { ...meta, live: false } };
  }

  root.DftTrafficDemo = Object.assign(root.DftTrafficDemo || {}, {
    DATA_URL,
    YEARS,
    POLL_MS,
    VEHICLE_CLASSES,
    ROAD_CATEGORY_LABELS,
    SNAPSHOT_COLUMNS,
    parseCsvLine,
    num,
    toRow,
    zipMember,
    inflateText,
    rowsFromCsv,
    fetchRows,
    fetchInitial,
    startPolling,
    encodeRow,
    decodeRow,
    melt,
    readSnapshot,
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
