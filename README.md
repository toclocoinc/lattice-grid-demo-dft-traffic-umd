# Road traffic counts across Great Britain, by year and vehicle class

A dashboard of the Department for Transport's annual average daily flow counts
on major and minor roads, grouped by region and road class, with a
year-by-class pivot, derived grids and the distributions drawn live, built on
Lattice Grid loaded by `<script>` tag: no npm install, no bundler, no build
step, no `type="module"`.

**[See it running](https://toclocoinc.github.io/lattice-grid-demo-dft-traffic-umd/)**

| | |
| --- | --- |
| Grid on npm | [@toclocoinc/lattice-grid](https://www.npmjs.com/package/@toclocoinc/lattice-grid) |
| Grid repository | [toclocoinc/latticegrid](https://github.com/toclocoinc/latticegrid) |
| Product site | [latticegrid.dev](https://www.latticegrid.dev) |

It is one stream of count rows with several views on it: a table for the counts
themselves, a cross-tab of flow by year and vehicle class, and three grids
derived from the table - total flow by local authority, total flow by vehicle
class, and a Pareto head of the roads that carry most of the traffic. They all
read the same stream, so grouping or filtering the table moves everything else
with it.

The point of the demo is the shape of traffic: a handful of busy motorways and
A roads carry a large share of all vehicle flow, while thousands of minor roads
carry a small one. The full dataset is over half a million counts reaching back
to 2000; this page holds the most recent four years - about 90,000 counts - and
every count keeps its real figure.

## How the grid gets onto the page

Six tags in `index.html`, and that is the whole of the library setup:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.65.0/lattice-grid.min.css">

<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.65.0/lattice-grid.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.65.0/modules/charts.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.65.0/modules/data-router.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.65.0/modules/kpi.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@1.65.0/modules/tabs.min.js"></script>
```

Each file is the package's UMD build (`*.min.js`, beside the `*.esm.min.js`
the ESM edition imports) and leaves a global behind:

| File | Global | Used here for |
| --- | --- | --- |
| `lattice-grid.min.js` | `LatticeGrid` | `createGrid`, `createHeadlessGrid`, `setLicence` |
| `modules/charts.min.js` | extends `LatticeGrid` | `LatticeGrid.createChart` |
| `modules/data-router.min.js` | `LatticeGridDataRouter` | `createDataRouter` |
| `modules/kpi.min.js` | `LatticeGridKPI` | `createKPI` |
| `modules/tabs.min.js` | `LatticeGridTabs` | `createTabs` |

The charts module folds its exports into the core global rather than defining
one of its own, so its tag must come after the core's. The other three are
self-contained and can go in any order. `main.js` checks that every factory it
needs is actually there before it draws anything, so a tag that did not load
is reported as a sentence rather than as an error from inside the grid.

Every address names the exact release, `1.65.0`, and every tag carries the
`integrity` hash of the file it expects. The page cannot quietly pick up a
different build than the one it was checked against, and the browser refuses
a file that does not match. The hashes are the SHA-384 of the published files.

The demo's own code is four classic scripts, loaded in order after the
library: `src/licence.js`, `src/dft-feed.js`, `src/dashboard.js`, `main.js`.
Each file wraps itself in a function and puts what it offers on one plain
object, `DftTrafficDemo`, for the next file to read. `src/dashboard.js` is
handed the grid's factories as arguments and never touches a global itself.

## Running it

You need nothing but a browser and a way to serve the folder, because the
page fetches its data with `fetch()` and browsers will not do that from
`file://`. Any static server will do; one is included:

```
node tools/serve.mjs
```

That prints an address. Open it.

| Address | What you get |
| --- | --- |
| `/` | tries the DfT traffic counts, then shows the saved copy (see below) |
| `/?source=snapshot` | the saved copy in `data/snapshot`, no download needed |

The live path attempts to read the bulk CSV from the DfT's storage bucket. That
bucket does not send CORS headers, so a browser can only read it same-origin;
from a normal web page the fetch is refused and the dashboard opens the saved
copy instead, saying so under the title. The snapshot tool below runs under
Node, where there is no CORS restriction, so it is what actually reads the
download.

Running a copy on your own machine needs no licence key. Publishing it on a
web address does.

## What it shows

**One stream, several views.** The count table holds one row per count point
per year. The pivot, the by-class chart and the derived grids are built from
the same rows, so nothing can disagree with the table. Filter the table and
every view follows.

**A real, large dataset.** The saved copy holds about 90,000 counts over the
most recent four years, every one with its true figure. Group by region, local
authority or road category and each group total is the real sum, not a sample.

**A cross-tab, not just a table.** The pivot spreads vehicle class across the
top and year down the side, so the flow in each cell is the year's traffic for
that class, with a grand total column across all of them.

**Derived grids.** Total flow by local authority (summed and sorted largest
first), total flow by vehicle class, and a Pareto head of the roads that reach
80% of the flow.

**Distributions.** Three charts draw straight from the table's rows: a line of
total flow by year, a bar of flow by vehicle class, and a histogram of how busy
a count point is.

**Figures that follow the table.** The strip of tiles reads whatever the table
currently matches: counts in view, distinct count points, total AADF and the
average. The busiest road in view is named beside them, and the mean, median
and 95th percentile of flow are read straight off the grid's statistics
surface.

**Roads that read as colours.** The road-category column carries a pill per
class (motorway, A road, minor road), and the flow column carries a data bar
and conditional-formatting rules the grid holds as runtime state, so a reader
can open the Formatting panel and change them.

## The data

Everything comes from the Department for Transport road traffic statistics:

- <https://roadtraffic.dft.gov.uk/downloads>

The bulk file is a zipped CSV of annual average daily flow (AADF) counts, one
row per count point per year with a column per vehicle class:

- `https://storage.googleapis.com/dft-statistics/road-traffic/downloads/data-gov-uk/dft_traffic_counts_aadf.zip`

It needs no key. The data are published under the Open Government Licence v3.0
and are free to use.

A few things worth knowing about the data:

- The full file is about 600,000 rows reaching back to 2000, and far too large
  to hold in a browser. This page keeps the most recent four years, which is
  what makes the saved copy a bounded, downloadable slice.
- One count is one count point in one year. A count point appears once per
  year, so the composite id is `countPointId:year`.
- `road_category` is the DfT's own code (`PA`, `TA`, `TM`, `PM` for major
  roads; `MB` and `MCU` for minor ones). The pill maps each code to words.
- `all_motor_vehicles` is the headline AADF figure; the vehicle-class columns
  (`pedal_cycles`, `two_wheeled_motor_vehicles`, `cars_and_taxis`,
  `buses_and_coaches`, `LGVs`, `all_HGVs`) are its parts. The pivot and the
  by-class chart melt those six columns into one `class` column.
- The bucket that serves the CSV does not send CORS headers, which is why the
  live browser path falls back to the saved copy rather than reading the file
  directly.

## Files

```
index.html                page shell, and the six library tags
main.js                   works out where the data comes from, then starts
src/licence.js            the key for this demo's own published address
src/dft-feed.js           the CSV: fetch, unzip, parse, melt, polling
src/dashboard.js          the views: router, tables, tiles, charts, pivot, derived grids
styles.css                the page around the grid
tools/serve.mjs           a small static file server
tools/build-snapshot.mjs  save a real run into data/snapshot
tools/verify.mjs          open it in a real browser and check it
data/snapshot/            a saved run, so the demo works without the download
```

There is no `package.json` and no `node_modules`. The tools need Node 22 or
newer and nothing else.

The saved copy is a compact array of arrays - one value per column, in the
order `meta.json` documents - so 90,000 counts stay a manageable download. The
browser unpacks it with the same code that parses the live CSV, so the two
paths produce identical rows.

## Building the saved copy

```
node tools/build-snapshot.mjs
```

It downloads the zipped CSV, unpacks it, keeps the most recent four years, and
writes the compact form to `data/snapshot/`. Re-run it to refresh the copy.

## Checking it

```
node tools/verify.mjs   # open the page in a real browser and assert
node tools/verify.mjs --all   # also open the live page
```

`tools/verify.mjs` is not a smoke test. It first insists on how the library
arrived: no `type="module"` script anywhere on the page, five script tags
pointing at the pinned release on the CDN, each with an integrity hash, and
each leaving the global it documents. It then recomputes the headline figures
from the saved data and compares them with what the page is showing, groups the
table and insists the group rows appear, checks the pivot spread the classes
into columns, reads the derived grids and the statistics profile, pushes a
corrected count through and insists it lands on its row rather than adding one,
narrows the table and insists the tiles moved with it, and finally blocks the
download in the browser and insists the saved copy appears with a notice saying
why. The GitHub Pages workflow runs it before every publish.

## Licence

The demo code is MIT. See `LICENSE`.

The traffic data is from the Department for Transport, published under the Open
Government Licence v3.0.

Lattice Grid itself is a separate commercial product with its own terms. It is
free to use on localhost, with no key and no watermark, so a copy of this
repository runs unrestricted on your own machine. This demo carries a key for
its own published address only, which is why you will find one in the source.
Keys for your own sites come from [latticegrid.dev](https://www.latticegrid.dev).

---
Built with [Lattice Grid](https://www.latticegrid.dev), a JavaScript data grid with a Data Router: one live feed keeps grids, charts, boards, Gantt and KPI tiles in step. [Documentation](https://www.latticegrid.dev/docs/) · [Demos](https://www.latticegrid.dev/demos/) · [Licence](https://www.latticegrid.dev/licence/)
