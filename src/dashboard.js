/**
 * The dashboard: one stream of road-traffic count rows, and every view built
 * on top of it.
 *
 * Nothing here fetches anything and nothing here reaches for the grid's
 * globals: every factory is handed in, so this file is the same whether the
 * library arrived by script tag, as it does here, or by import.
 *
 * How the pieces fit together:
 *
 *   the CSV  ->  the router  ->  the counts grid  ->  the tiles
 *                             ->  (nothing else)      the line / histogram
 *                                                        charts
 *              melt (feed)   ->  the pivot grid         the by-class chart
 *                                the by-class grid
 *              derived       ->  by authority, by class, the Pareto head
 *
 * The counts grid (one row per count point per year) is the primary view: the
 * tiles, the line chart, the histogram and the three derived grids read it.
 * The vehicle classes are columns on those wide rows, so a long-form melt -
 * one row per class per count point-year - feeds the year-by-class pivot and
 * the by-class chart, which need class to be a single column.
 *
 * A classic script: it reads the constants from `DftTrafficDemo`, put there by
 * `dft-feed.js`, and adds `buildDashboard` alongside them.
 */
(function (root) {
  'use strict';

  const { ROAD_CATEGORY_LABELS, melt } = root.DftTrafficDemo;

  /** Make an element with a class and optional text, the long way round. */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** One number, written the way a reader expects to see it. */
  function commas(value) {
    return Number(value || 0).toLocaleString('en-GB');
  }

  /** A clock time, local to whoever is reading. */
  function clockText(ms) {
    return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  /* ------------------------------------------------------------------ */
  /* Columns                                                             */
  /* ------------------------------------------------------------------ */

  /** The count columns, grouped under three headings. */
  function countColumns(topFlow) {
    const roadCategoryOptions = Object.keys(ROAD_CATEGORY_LABELS).map((code) => ({
      value: code,
      label: ROAD_CATEGORY_LABELS[code],
    }));
    return [
      {
        title: 'The road',
        columns: [
          {
            id: 'roadName',
            field: 'roadName',
            title: 'Road',
            filter: { type: 'text' },
            layout: { width: 280 },
            /* The road's name over its region and authority: a bold line, then
               the quieter place underneath. */
            cell: {
              render: 'twoline',
              props: { secondary: (p) => (p && p.data ? `${p.data.region}, ${p.data.authority}` : '') },
            },
          },
          {
            id: 'region',
            field: 'region',
            title: 'Region',
            filter: { type: 'set' },
            layout: { width: 170 },
          },
          {
            id: 'authority',
            field: 'authority',
            title: 'Local authority',
            filter: { type: 'set' },
            layout: { width: 190 },
          },
        ],
      },
      {
        title: 'The count',
        columns: [
          {
            id: 'countPointId',
            field: 'countPointId',
            title: 'Count point',
            type: 'number',
            filter: { type: 'number' },
            layout: { width: 100 },
          },
          {
            id: 'year',
            field: 'year',
            title: 'Year',
            type: 'number',
            filter: { type: 'number' },
            layout: { width: 80 },
          },
          {
            id: 'roadCategory',
            field: 'roadCategory',
            title: 'Road category',
            filter: { type: 'set' },
            lookup: { options: roadCategoryOptions },
            layout: { width: 170 },
            /* A pill, coloured by road class: motorways in one tone, A roads in
               another, minor roads in a third. */
            cell: {
              decoration: 'pill',
              variant: {
                map: {
                  PM: 'accent',
                  TM: 'accent',
                  PA: 'success',
                  TA: 'success',
                  MB: 'warning',
                  MCU: 'neutral',
                },
                default: 'neutral',
              },
            },
          },
          {
            id: 'roadType',
            field: 'roadType',
            title: 'Road type',
            filter: { type: 'set' },
            layout: { width: 90, hidden: true },
          },
        ],
      },
      {
        title: 'Vehicles per day',
        columns: [
          {
            id: 'allMotorVehicles',
            field: 'allMotorVehicles',
            title: 'All motor vehicles',
            type: 'number',
            total: 'sum',
            groupTotal: 'sum',
            filter: { type: 'number' },
            layout: { width: 160 },
            /* The bar is the count point's flow against the busiest one, so a
               motorway and a quiet lane read at a glance. */
            cell: { decoration: { type: 'bar', min: 0, max: topFlow } },
          },
          {
            id: 'carsAndTaxis',
            field: 'carsAndTaxis',
            title: 'Cars and taxis',
            type: 'number',
            total: 'sum',
            filter: { type: 'none' },
            layout: { width: 120, hidden: true },
          },
          {
            id: 'hgvs',
            field: 'hgvs',
            title: 'HGVs',
            type: 'number',
            total: 'sum',
            filter: { type: 'none' },
            layout: { width: 110, hidden: true },
          },
          {
            id: 'pedalCycles',
            field: 'pedalCycles',
            title: 'Pedal cycles',
            type: 'number',
            total: 'sum',
            filter: { type: 'none' },
            layout: { width: 110, hidden: true },
          },
        ],
      },
    ];
  }

  /**
   * The magnitude bands on the flow column. These are conditional formatting
   * rules the grid holds as runtime state, so a reader can open the Formatting
   * panel and change them.
   *
   * @returns {object} rules keyed by column id
   */
  function flowFormatting() {
    return {
      allMotorVehicles: [
        { id: 'flow-heavy', label: 'Very heavy (at least 60,000 a day)', when: { op: 'gte', value: 60000 }, style: { color: '#b42318', fontWeight: '700' } },
        { id: 'flow-busy', label: 'Busy (at least 20,000 a day)', when: { op: 'gte', value: 20000 }, style: { color: '#175cd3', fontWeight: '600' } },
        { id: 'flow-light', label: 'Light (under 20,000 a day)', when: { op: 'lt', value: 20000 }, style: { color: '#667085' } },
      ],
    };
  }

  /** The shared grid settings every view uses. */
  function baseGridConfig(title) {
    return {
      rowKey: 'id',
      theme: 'light',
      density: 'compact',
      stripedRows: true,
      columnMenu: true,
      groupPanel: true,
      statusBar: true,
      find: true,
      grandTotalRow: 'bottom',
      groupDefaultExpanded: 0,
      toolPanel: { side: 'right', panels: ['filters', 'columns', 'formatting'] },
      selection: 'multiple',
      highlightOnChange: { colour: '#ffe8a3', duration: 2500 },
      title,
    };
  }

  /* ------------------------------------------------------------------ */
  /* The dashboard                                                       */
  /* ------------------------------------------------------------------ */

  function buildDashboard({
    root: host,
    createGrid,
    createHeadlessGrid,
    createChart,
    createKPI,
    createTabs,
    createDataRouter,
    rows,
    meta,
  }) {
    host.textContent = '';

    const topFlow = rows.length ? rows.reduce((max, row) => Math.max(max, row.allMotorVehicles || 0), 0) : 1;

    const built = {
      detailGrid: null,
      pivotGrid: null,
      authorityGrid: null,
      classGrid: null,
      paretoGrid: null,
      meltedGrid: null,
      router: null,
      kpi: null,
      charts: [],
      tabs: null,
      store: new Map(),
      aadfProfile: null,
      aadfP95: null,
      status: { lastPoll: null, lastError: null, polls: 0, arrivals: 0, revisions: 0 },
    };

    /* ---------------- the masthead ---------------- */

    const header = el('header', 'head');
    const heading = el('div', 'head-text');
    heading.append(el('h1', null, 'Road traffic counts across Great Britain, by year and vehicle class'));
    heading.append(
      el(
        'p',
        'lede',
        'Annual average daily flow counts the Department for Transport publishes for major and minor roads, grouped by ' +
          'region and road class, with a year-by-class pivot, derived grids and the distributions drawn live. The full ' +
          'dataset is over half a million counts; this page holds the most recent four years, and every count keeps its real figure.',
      ),
    );
    if (meta.fellBack) {
      heading.append(
        el(
          'p',
          'notice',
          'The Department for Transport traffic counts could not be reached, so this is the saved copy. Reloading the page will try again.',
        ),
      );
    }
    header.append(heading);

    const provenance = el('div', 'head-note');
    const modePill = el('span', 'pill', meta.live ? 'Live' : 'Saved copy');
    const liveDot = el('span', 'dot');
    if (meta.live) modePill.prepend(liveDot);
    const freshness = el('span', 'freshness', 'Waiting for the first update...');
    provenance.append(modePill, freshness);
    header.append(provenance);
    host.append(header);

    /* ---------------- the tiles ---------------- */

    const kpiHost = el('section', 'kpi-strip');
    kpiHost.setAttribute('aria-label', 'Headline figures');
    const panelHost = el('div', 'kpi-panel');
    const namedTile = el('div', 'kpi-named');
    const namedValue = el('div', 'kpi-named-value', 'No data');
    const namedLabel = el('div', 'kpi-named-label', 'Busiest road in view');
    namedTile.append(namedValue, namedLabel);
    kpiHost.append(panelHost, namedTile);
    host.append(kpiHost);

    /* ---------------- the charts ---------------- */

    const chartHost = el('section', 'chart-wrap');
    chartHost.setAttribute('aria-label', 'Charts');
    const chartBoxes = [];
    for (let i = 0; i < 3; i += 1) {
      const box = el('div', 'chart-box');
      chartHost.append(box);
      chartBoxes.push(box);
    }
    host.append(chartHost);

    /* ---------------- the controls ---------------- */

    const actions = el('div', 'actions');
    host.append(actions);

    /* ---------------- the tables ---------------- */

    const tabsHost = el('section', 'tabs-host');
    host.append(tabsHost);

    const tabs = createTabs(tabsHost, {
      createGrid,
      createHeadlessGrid,
      ariaLabel: 'Road traffic views',
      tabs: [
        {
          id: 'counts',
          label: 'Traffic counts',
          badge: true,
          config: {
            ...baseGridConfig('Annual average daily flow counts on major and minor roads'),
            rowHeight: 40,
            columns: countColumns(topFlow),
            formatting: flowFormatting(),
            rows: [],
          },
        },
        {
          id: 'pivot',
          label: 'AADF by year and class',
          config: {
            ...baseGridConfig('Annual average daily flow, by year and vehicle class'),
            columns: [
              { id: 'year', field: 'year', title: 'Year', type: 'number' },
              { id: 'class', field: 'class', title: 'Vehicle class' },
              { id: 'flow', field: 'flow', title: 'Vehicles per day', type: 'number', total: 'sum' },
            ],
            pivotView: true,
            pivot: { groupTotals: 'after', totalsLabel: 'All classes' },
            rows: [],
          },
        },
      ],
    });
    built.tabs = tabs;
    built.detailGrid = tabs.tab('counts');

    /* Materialise the pivot grid now, rather than on first activation, so the
       grouping and pivoting below have a grid to act on from the moment the
       page is drawn. Both switches are synchronous and paint once. */
    tabs.activate('pivot', { silent: true });
    built.pivotGrid = tabs.tab('pivot');
    tabs.activate('counts', { silent: true });

    /* ---------------- the router ---------------- */

    /*
     * One stream in, one table out. There is no partition here - a count row
     * belongs to exactly one table - but the router still earns its place: it
     * turns a full snapshot or a pushed row into a keyed diff, so a re-fetch or
     * a corrected count lands on the row it belongs to rather than appending a
     * duplicate. The counting subscriber below matches every row, which is what
     * the "N new, M revised" readout under the masthead reads; `overlap: true`
     * lets one row reach both its table and that subscriber.
     */
    const router = createDataRouter({
      key: (row) => 'count',
      rowKey: 'id',
      overlap: true,
    });
    built.router = router;

    router.attach(built.detailGrid, (row) => true);
    router.subscribe(() => true, (change) => {
      built.status.arrivals += (change.add || []).length;
      built.status.revisions += (change.update || []).length;
    });

    /**
     * Put rows into the store and through the router.
     *
     * @param {object[]} incoming the rows to apply
     * @returns {number} how many rows were applied
     */
    const ingest = (incoming) => {
      if (!incoming || !incoming.length) return 0;
      for (const row of incoming) built.store.set(row.id, row);
      router.apply(incoming.map((row) => ({ op: 'upsert', row })));
      return incoming.length;
    };

    for (const row of rows) built.store.set(row.id, row);
    router.load([...built.store.values()]);

    /* ---------------- the melt and the pivot ---------------- */

    const melted = melt(rows);
    built.meltedGrid = createHeadlessGrid({
      rowKey: 'id',
      columns: [
        { id: 'year', field: 'year', type: 'number' },
        { id: 'class', field: 'class', type: 'text' },
        { id: 'flow', field: 'flow', type: 'number', total: 'sum' },
      ],
      rows: melted,
    });

    /* The pivot: year down the side, vehicle class across the top, summed flow
       in each cell. */
    built.pivotGrid.rows.load(melted);
    built.pivotGrid.columns.group(['year']);
    built.pivotGrid.columns.pivot(['class']);

    /* ---------------- the derived grids ---------------- */

    const derivedHost = el('section', 'derived-wrap');
    derivedHost.setAttribute('aria-label', 'Derived grids');
    const authorityBox = el('div', 'derived-box');
    const classBox = el('div', 'derived-box');
    const paretoBox = el('div', 'derived-box');
    derivedHost.append(authorityBox, classBox, paretoBox);
    host.append(derivedHost);

    try {
      built.authorityGrid = createGrid(authorityBox, {
        rowKey: '__key',
        title: 'Total flow by local authority (derived from the counts)',
        columns: [
          { id: 'authority', field: 'authority', title: 'Local authority', filter: { type: 'text' }, layout: { width: 260 } },
          { id: 'flow', field: 'flow', title: 'Vehicles per day', type: 'number', format: { type: 'number', notation: 'compact', decimals: 1 }, layout: { width: 150 } },
          { id: 'points', field: 'points', title: 'Count points', type: 'number', layout: { width: 110 } },
        ],
        source: {
          mode: 'derived',
          from: built.detailGrid,
          groupBy: 'authority',
          select: {
            flow: { of: 'allMotorVehicles', fn: 'sum' },
            points: { of: 'countPointId', fn: 'distinct' },
          },
          sort: [{ col: 'flow', dir: 'desc' }],
        },
      });
    } catch (error) {
      authorityBox.append(el('p', 'chart-error', `This derived grid could not be built: ${error.message}`));
      console.error('[dft demo] authority grid', error);
    }

    try {
      built.classGrid = createGrid(classBox, {
        rowKey: '__key',
        title: 'Total flow by vehicle class (derived from the melt)',
        columns: [
          { id: 'class', field: 'class', title: 'Vehicle class', layout: { width: 240 } },
          { id: 'flow', field: 'flow', title: 'Vehicles per day', type: 'number', format: { type: 'number', notation: 'compact', decimals: 1 }, layout: { width: 150 } },
        ],
        source: {
          mode: 'derived',
          from: built.meltedGrid,
          groupBy: 'class',
          select: { flow: { of: 'flow', fn: 'sum' } },
          sort: [{ col: 'flow', dir: 'desc' }],
        },
      });
    } catch (error) {
      classBox.append(el('p', 'chart-error', `This derived grid could not be built: ${error.message}`));
      console.error('[dft demo] class grid', error);
    }

    try {
      built.paretoGrid = createGrid(paretoBox, {
        rowKey: '__key',
        title: 'The Pareto head - the roads that reach 80% of the flow',
        columns: [
          { id: 'roadName', field: 'roadName', title: 'Road', filter: { type: 'text' }, layout: { width: 220 } },
          { id: 'flow', field: 'flow', title: 'Vehicles per day', type: 'number', format: { type: 'number', notation: 'compact', decimals: 1 }, layout: { width: 130 } },
        ],
        source: {
          mode: 'derived',
          from: built.detailGrid,
          groupBy: 'roadName',
          select: { flow: { of: 'allMotorVehicles', fn: 'sum' } },
          sort: [{ col: 'flow', dir: 'desc' }],
          cumulative: { of: 'flow', upTo: 0.8 },
        },
      });
    } catch (error) {
      paretoBox.append(el('p', 'chart-error', `This derived grid could not be built: ${error.message}`));
      console.error('[dft demo] pareto grid', error);
    }

    /* ---------------- the statistics readout ---------------- */

    const statsNote = el('p', 'stats-note', '');
    derivedHost.append(statsNote);

    /** Read the profile and the 95th percentile straight off the grid. */
    const refreshStatsNote = () => {
      const profile = built.detailGrid.statistics.profile('allMotorVehicles');
      built.aadfProfile = profile;
      built.aadfP95 = built.detailGrid.statistics.reduce('allMotorVehicles', 'p95');
      if (!profile || profile.mean == null) {
        statsNote.textContent = 'No statistics to report yet.';
        return;
      }
      statsNote.textContent =
        `Over the ${commas(profile.present || 0)} counts in view, the mean flow is ${commas(Math.round(profile.mean || 0))} ` +
        `vehicles a day and the median is ${commas(Math.round(profile.median || 0))}; the 95th percentile is ` +
        `${commas(Math.round(built.aadfP95 || 0))}, which is how far a few busy motorways sit above the typical road.`;
    };
    built.refreshStatsNote = refreshStatsNote;
    refreshStatsNote();

    /* ---------------- the tiles, bound to the counts table ---------------- */

    const kpi = createKPI(panelHost, {
      grid: built.detailGrid,
      rowKey: 'id',
      fields: ['countPointId', 'roadName', 'allMotorVehicles'],
      columns: 4,
      ariaLabel: 'Headline figures',
      tiles: [
        { id: 'records', label: 'Counts in view', aggregation: 'count', format: 'number' },
        { id: 'countPoints', label: 'Count points', aggregation: 'countDistinct', field: 'countPointId', format: 'number' },
        { id: 'totalFlow', label: 'Total AADF (vehicles a day)', aggregation: 'sum', field: 'allMotorVehicles', format: 'compact' },
        { id: 'avgFlow', label: 'Average AADF', aggregation: 'avg', field: 'allMotorVehicles', format: 'compact' },
      ],
    });
    built.kpi = kpi;

    /** Name the busiest road in view. */
    const refreshNamedTile = () => {
      let best = null;
      kpi.rows.forEach((row) => {
        const flow = Number(row.allMotorVehicles) || 0;
        if (row.roadName && (!best || flow > best.flow)) best = { roadName: row.roadName, flow };
      });
      if (!best) {
        namedValue.textContent = 'No data';
        namedLabel.textContent = 'Busiest road in view';
        return;
      }
      namedValue.textContent = best.roadName;
      namedLabel.textContent = `Busiest in view, ${commas(best.flow)} vehicles a day`;
    };
    kpi.on('change', refreshNamedTile);
    refreshNamedTile();

    /* ---------------- the charts, bound to the counts table ---------------- */

    try {
      built.charts.push(createChart({
        grid: built.detailGrid,
        container: chartBoxes[0],
        type: 'line',
        x: 'year',
        y: 'allMotorVehicles',
        title: 'Total flow by year',
        axis: { y: 'Vehicles per day', x: { title: 'Year' } },
        legend: false,
      }));
    } catch (error) {
      chartBoxes[0].append(el('p', 'chart-error', `This chart could not be drawn: ${error.message}`));
      console.error('[dft demo] chart line', error);
    }

    try {
      built.charts.push(createChart({
        grid: built.classGrid,
        container: chartBoxes[1],
        type: 'bar',
        x: 'class',
        y: 'flow',
        title: 'Flow by vehicle class',
        axis: { y: 'Vehicles per day', x: { rotate: 'auto' } },
        legend: false,
      }));
    } catch (error) {
      chartBoxes[1].append(el('p', 'chart-error', `This chart could not be drawn: ${error.message}`));
      console.error('[dft demo] chart class', error);
    }

    try {
      built.charts.push(createChart({
        grid: built.detailGrid,
        container: chartBoxes[2],
        type: 'histogram',
        y: 'allMotorVehicles',
        buckets: 24,
        title: 'How busy a count point is',
        axis: { x: 'Vehicles per day', y: 'Count points' },
        legend: false,
      }));
    } catch (error) {
      chartBoxes[2].append(el('p', 'chart-error', `This chart could not be drawn: ${error.message}`));
      console.error('[dft demo] chart histogram', error);
    }

    /* ---------------- the controls ---------------- */

    const button = (label, onClick, className) => {
      const node = el('button', className || 'action', label);
      node.type = 'button';
      node.addEventListener('click', onClick);
      return node;
    };

    actions.append(el('span', 'actions-label', 'Group by'));
    actions.append(button('Region', () => built.detailGrid && built.detailGrid.columns.group(['region'])));
    actions.append(button('Local authority', () => built.detailGrid && built.detailGrid.columns.group(['authority'])));
    actions.append(button('Road category', () => built.detailGrid && built.detailGrid.columns.group(['roadCategory'])));
    actions.append(button('No grouping', () => built.detailGrid && built.detailGrid.columns.group([])));

    actions.append(el('span', 'actions-gap'));
    actions.append(el('span', 'actions-label', 'Order by'));
    actions.append(button('Busiest first', () => built.detailGrid && built.detailGrid.sort.set([{ col: 'allMotorVehicles', dir: 'desc' }])));
    actions.append(button('Road A\u2013Z', () => built.detailGrid && built.detailGrid.sort.set([{ col: 'roadName', dir: 'asc' }])));

    const motorwayButton = button('Motorways only', () => {
      const on = motorwayButton.getAttribute('aria-pressed') === 'true';
      const motorways = ['PM', 'TM'];
      built.detailGrid.filters.where('motorways', on ? null : (row) => motorways.includes(row.roadCategory));
      motorwayButton.setAttribute('aria-pressed', String(!on));
      motorwayButton.classList.toggle('on', !on);
      refreshStatsNote();
    }, 'action toggle');
    motorwayButton.setAttribute('aria-pressed', 'false');
    actions.append(el('span', 'actions-gap'));
    actions.append(motorwayButton);
    built.motorwayButton = motorwayButton;

    /* ---------------- the live readout ---------------- */

    const setFreshness = () => {
      if (!meta.live) {
        const saved = new Date(meta.fetchedAt).toLocaleString('en-GB');
        freshness.textContent = `A saved copy of the traffic counts, taken on ${saved}.`;
        freshness.className = 'freshness';
        return;
      }
      if (built.status.lastError) {
        freshness.textContent = built.status.lastPoll
          ? `Could not reach the download. Still showing what arrived at ${clockText(built.status.lastPoll)}.`
          : 'Could not reach the download.';
        freshness.className = 'freshness failed';
        return;
      }
      if (!built.status.lastPoll) {
        freshness.textContent = 'Waiting for the first update...';
        freshness.className = 'freshness';
        return;
      }
      freshness.textContent =
        `Updated ${clockText(built.status.lastPoll)}. ` +
        `${commas(built.status.arrivals)} new, ${commas(built.status.revisions)} revised since the page opened.`;
      freshness.className = 'freshness';
    };
    built.setFreshness = setFreshness;

    /** Take a poll's result: apply it, re-melt, refresh the figures. */
    built.onPoll = (result) => {
      built.status.lastPoll = result.fetchedAt || Date.now();
      built.status.lastError = null;
      built.status.polls += 1;
      liveDot.classList.add('beat');
      setTimeout(() => liveDot.classList.remove('beat'), 900);
      ingest(result.rows);
      built.meltedGrid.rows.load(melt(result.rows));
      refreshStatsNote();
      setFreshness();
    };

    /** Take a failed poll: keep the table, say what happened. */
    built.onPollError = (error) => {
      built.status.lastError = String((error && error.message) || error);
      setFreshness();
      console.warn('[dft demo] a poll failed:', built.status.lastError);
    };

    /* A hook for the verification script and for anyone poking at the page:
       push rows through exactly the path a poll uses. */
    built.ingest = ingest;

    setFreshness();

    /* ---------------- the footer ---------------- */

    const footer = el('footer', 'foot');
    const line = el('p', null, 'Traffic counts from the ');
    const link = el('a', null, 'Department for Transport road traffic statistics');
    link.href = 'https://roadtraffic.dft.gov.uk/downloads';
    link.rel = 'noopener';
    line.append(link);
    line.append(
      document.createTextNode(
        '. The data are published under the Open Government Licence v3.0. A count is an annual average daily flow ' +
          '(AADF): one row per count point per year, with a column per vehicle class. The full file reaches back to 2000; ' +
          'this page holds the most recent four years.',
      ),
    );
    footer.append(line);
    host.append(footer);

    built.destroy = () => {
      for (const chart of built.charts) chart.destroy();
      kpi.destroy();
      router.destroy();
      tabs.destroy();
    };

    return built;
  }

  root.DftTrafficDemo.buildDashboard = buildDashboard;
})(typeof globalThis !== 'undefined' ? globalThis : window);
