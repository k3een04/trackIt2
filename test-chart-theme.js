/**
 * Validates the shared bar-chart design system (chart-theme.js) without a
 * browser: the module is evaluated against a small DOM stub, and every bar chart
 * in the product is checked for the same structure, spacing and theme tokens.
 *
 * Run with:  node test-chart-theme.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// DOM STUB
// ────────────────────────────────────────────────────────────────────────────

let cssVars = {};
let lightMode = false;

function makeCtx() {
  const calls = { fillText: [], fillRect: [], gradients: [] };
  return {
    calls,
    save() {}, restore() {}, beginPath() {}, closePath() {}, fill() {},
    fillRect(...a) { calls.fillRect.push(a); },
    fillText(text, x, y) { calls.fillText.push({ text, x, y, fillStyle: this.fillStyle, font: this.font }); },
    createLinearGradient() {
      const g = { stops: [], addColorStop(offset, color) { this.stops.push({ offset, color }); } };
      calls.gradients.push(g);
      return g;
    },
    fillStyle: '', font: '', textAlign: '', textBaseline: '', lineWidth: 1,
  };
}

const bodyStub = {
  classList: {
    contains: (name) => (name === 'light-mode' ? lightMode : false),
    add: (name) => { if (name === 'light-mode') lightMode = true; },
    remove: (name) => { if (name === 'light-mode') lightMode = false; },
  },
};

const charts = [];

global.window = global;
global.document = {
  body: Object.assign(bodyStub, {
    contains: () => true,
    appendChild() {},
  }),
  getElementsByTagName: () => [],
};
global.getComputedStyle = () => ({
  getPropertyValue: (name) => cssVars[name] || '',
});
global.Chart = function Chart(canvas, config) {
  this.canvas = canvas || { getContext: () => makeCtx() };
  this.config = config;
  this.data = config.data;
  this.options = config.options;
  this.ctx = makeCtx();
  this.chartArea = { top: 0, bottom: 240, left: 0, right: 400 };
  this.updates = 0;
  this.getDatasetMeta = () => ({ type: 'bar', hidden: false, data: [] });
  this.getActiveElements = () => [];
  this.update = () => { this.updates += 1; };
  this.destroy = () => {};
  charts.push(this);
};

// Evaluate the module the same way a browser would.
const source = fs.readFileSync(path.join(__dirname, 'chart-theme.js'), 'utf8');
eval(source);

const T = global.TrackITCharts;
assert.ok(T, 'chart-theme.js must expose window.TrackITCharts');

// ────────────────────────────────────────────────────────────────────────────
// TESTS
// ────────────────────────────────────────────────────────────────────────────

console.log('\n=== TrackIT bar-chart design system ===\n');

console.log('Theme tokens');
check('exposes the module with the shared API', () => {
  ['tokens', 'barOptions', 'styleDataset', 'refreshAll', 'register', 'createBar',
    'withPlugins', 'resolveAxis', 'alpha', 'accent'].forEach((key) => {
    assert.ok(T[key] !== undefined, `missing TrackITCharts.${key}`);
  });
});

check('dark mode uses the TrackIT navy/teal tokens', () => {
  lightMode = false;
  const t = T.tokens();
  assert.strictEqual(t.isLight, false);
  assert.strictEqual(t.teal.toLowerCase(), '#00c8aa', 'teal must stay the brand teal');
  assert.strictEqual(t.tooltipBg, 'rgba(17,24,39,0.96)');
});

check('light mode resolves its own higher-contrast tokens', () => {
  lightMode = true;
  const t = T.tokens();
  assert.strictEqual(t.isLight, true);
  assert.notStrictEqual(t.tick, 'rgba(203,213,225,0.62)', 'light ticks must not stay dark-theme grey');
  assert.strictEqual(t.tick, '#475569');
  assert.strictEqual(t.tooltipBg, 'rgba(255,255,255,0.98)');
  lightMode = false;
});

check('CSS custom properties win over the built-in fallbacks', () => {
  cssVars = { '--teal': '#123456', '--teal-dark': '#0f2d4a' };
  assert.strictEqual(T.tokens().teal, '#123456');
  cssVars = {};
});

console.log('\nOption factory');
check('barOptions defaults to vertical for few categories', () => {
  const o = T.barOptions({ categoryCount: 4, datasetCount: 1 });
  assert.strictEqual(o.indexAxis, 'x');
});

check('barOptions auto-flips to horizontal for many categories', () => {
  const o = T.barOptions({ categoryCount: 12, datasetCount: 1 });
  assert.strictEqual(o.indexAxis, 'y', 'a crowded category chart must go horizontal');
});

check('a time series never auto-flips', () => {
  const o = T.barOptions({ categoryCount: 20, datasetCount: 1, timeSeries: true });
  assert.strictEqual(o.indexAxis, 'x', 'weeks must stay on the x axis');
});

check('only the value axis carries gridlines', () => {
  const vertical = T.barOptions({ vertical: true, categoryCount: 4 });
  assert.ok(vertical.scales.y.grid.color, 'value axis must have a grid colour');
  assert.strictEqual(vertical.scales.x.grid.display, false, 'category axis grid must be off');

  const horizontal = T.barOptions({ horizontal: true, categoryCount: 8 });
  assert.ok(horizontal.scales.x.grid.color, 'value axis must have a grid colour');
  assert.strictEqual(horizontal.scales.y.grid.display, false, 'category axis grid must be off');
});

check('bar spacing/radius are identical on every chart', () => {
  [T.barOptions({ vertical: true }), T.barOptions({ horizontal: true })].forEach((o) => {
    assert.strictEqual(o.datasets.bar.barPercentage, 0.78);
    assert.strictEqual(o.datasets.bar.categoryPercentage, 0.68);
    assert.strictEqual(o.datasets.bar.borderRadius, 6);
    assert.strictEqual(o.datasets.bar.borderWidth, 0, 'no default outline stroke');
    assert.strictEqual(o.datasets.bar.borderSkipped, false);
  });
});

check('the legend is hidden for single-dataset charts, shown for multiples', () => {
  assert.strictEqual(T.barOptions({ datasetCount: 1 }).plugins.legend.display, false);
  assert.strictEqual(T.barOptions({ datasetCount: 2 }).plugins.legend.display, true);
});

check('gridlines stay subtle on both themes', () => {
  lightMode = false;
  const dark = T.barOptions({ vertical: true }).scales.y.grid.color;
  lightMode = true;
  const light = T.barOptions({ vertical: true }).scales.y.grid.color;
  lightMode = false;
  assert.ok(dark.includes('0.06'), `dark grid should be near-invisible, got ${dark}`);
  assert.ok(light.includes('0.08'), `light grid should be near-invisible, got ${light}`);
  assert.notStrictEqual(dark, light, 'the grid colour must change with the theme');
});

check('ticks and tooltips switch with the theme', () => {
  lightMode = false;
  const dark = T.barOptions({ vertical: true });
  lightMode = true;
  const light = T.barOptions({ vertical: true });
  lightMode = false;
  assert.notStrictEqual(dark.scales.y.ticks.color, light.scales.y.ticks.color);
  assert.notStrictEqual(dark.plugins.tooltip.bodyColor, light.plugins.tooltip.bodyColor);
  assert.notStrictEqual(dark.plugins.legend.labels.color, light.plugins.legend.labels.color);
});

check('the existing tooltip callback is preserved verbatim', () => {
  const cb = (context) => `range-${context.dataIndex}`;
  const o = T.barOptions({ vertical: true, tooltipAfterLabel: cb });
  assert.strictEqual(o.plugins.tooltip.afterLabel, cb);
});

check('dual-axis charts keep both value axes', () => {
  const o = T.barOptions({ vertical: true, dualAxis: true, categoryCount: 8 });
  assert.ok(o.scales.y, 'left value axis');
  assert.ok(o.scales.y1, 'right value axis');
  assert.strictEqual(o.scales.y1.position, 'right');
  assert.strictEqual(o.scales.y1.grid.display, false, 'the secondary axis must not double the grid');
});

check('layout reserves room for the value captions', () => {
  const horizontal = T.barOptions({ horizontal: true });
  const vertical = T.barOptions({ vertical: true });
  assert.ok(horizontal.layout.padding.right >= 30, 'horizontal bars need right-hand space for labels');
  assert.ok(vertical.layout.padding.top >= 10);
});

console.log('\nDataset styling');
check('a styled dataset uses the palette with no default outline', () => {
  const ds = T.styleDataset({ label: 'X', data: [1, 2] }, { accent: T.accent.teal });
  assert.strictEqual(typeof ds.backgroundColor, 'function', 'fill must be scriptable for hover');
  assert.strictEqual(ds.borderWidth, 0);
  assert.strictEqual(ds.borderRadius, 6);
  assert.strictEqual(ds.barPercentage, 0.78);
  assert.strictEqual(ds.trackitValueLabels, true);
});

check('stacked datasets only round their outer end', () => {
  // Geometry on the dataset is what the real stacked chart uses.
  const ds = T.styleDataset({
    label: 'X',
    data: [1],
    borderRadius: { topLeft: 0, bottomLeft: 0, topRight: 6, bottomRight: 6 },
    borderSkipped: 'start',
  }, { accent: T.accent.teal });
  assert.strictEqual(ds.borderSkipped, 'start', 'inner corners of a stack must stay square');
  assert.strictEqual(ds.borderRadius.bottomRight, 6);
  assert.strictEqual(ds.borderRadius.topLeft, 0);

  // A plain chart still gets the shared all-corners radius.
  const plain = T.styleDataset({ label: 'X', data: [1] }, { accent: T.accent.teal });
  assert.strictEqual(plain.borderRadius, 6);
  assert.strictEqual(plain.borderSkipped, false);
});

check('value labels can be suppressed for crowded charts', () => {
  const ds = T.styleDataset({ label: 'X', data: [1] }, { accent: T.accent.teal, showValues: false });
  assert.strictEqual(ds.trackitValueLabels, false);
});

check('the fill is a gradient of the same hue (no new colours)', () => {
  const ds = T.styleDataset({ label: 'X', data: [1] }, { accent: T.accent.teal });
  const gradient = ds.backgroundColor({
    chart: { chartArea: { top: 0, bottom: 200 }, ctx: makeCtx() },
    dataIndex: 0,
  });
  assert.ok(gradient && gradient.stops && gradient.stops.length === 2, 'expected a two-stop gradient');
  gradient.stops.forEach(stop => {
    assert.ok(stop.color.startsWith('rgba(0,200,170,'), `unexpected hue: ${stop.color}`);
  });
});

check('hovering one bar dims the others and lifts the selected one', () => {
  const ds = T.styleDataset({ label: 'X', data: [10, 20, 30] }, { accent: T.accent.teal });
  const key = T.hoverIndexKey;
  const base = ds.backgroundColor({ chart: { [key]: -1, chartArea: null, ctx: makeCtx() }, dataIndex: 0 });
  const selected = ds.backgroundColor({ chart: { [key]: 1, chartArea: null, ctx: makeCtx() }, dataIndex: 1 });
  const dimmed = ds.backgroundColor({ chart: { [key]: 1, chartArea: null, ctx: makeCtx() }, dataIndex: 0 });

  assert.notStrictEqual(base, selected, 'the hovered bar must differ from the resting state');
  assert.notStrictEqual(selected, dimmed, 'non-hovered bars must be dimmed');
  const alphaOf = (c) => parseFloat(c.split(',')[3]);
  assert.ok(alphaOf(dimmed) < alphaOf(selected),
    `dimmed alpha ${alphaOf(dimmed)} should be below selected ${alphaOf(selected)}`);
});

console.log('\nPlugins');
check('withPlugins attaches both shared plugins exactly once', () => {
  const once = T.withPlugins({ type: 'bar' });
  assert.strictEqual(once.plugins.length, 2);
  const twice = T.withPlugins(once);
  assert.strictEqual(twice.plugins.length, 2, 'plugins must not be duplicated on re-wrap');
});

check('the hover plugin caches the index and updates without animating', () => {
  const o = T.barOptions({ vertical: true });
  const chart = { [T.hoverIndexKey]: -1, updates: 0, update(mode) { this.updates += 1; this.mode = mode; } };
  o.onHover({}, [{ index: 3 }], chart);
  assert.strictEqual(chart[T.hoverIndexKey], 3);
  assert.strictEqual(chart.mode, 'none', 'hover must not animate');
  const before = chart.updates;
  o.onHover({}, [{ index: 3 }], chart);
  assert.strictEqual(chart.updates, before, 'same index must not trigger another update');
  o.onHover({}, [], chart);
  assert.strictEqual(chart[T.hoverIndexKey], -1, 'leaving the chart clears the highlight');
});

const labelPlugin = T.plugins.find(p => p.id === 'trackitValueLabels');

function makeLabelChart(labelCount, values, showValues, hoverIndex, barLength, horizontal) {
  const ctx = makeCtx();
  const data = Array.from({ length: labelCount }, (_, i) => values[i] ?? 10);
  return {
    ctx,
    chart: {
      ctx,
      data: {
        labels: new Array(labelCount).fill('x'),
        datasets: [{ data, trackitValueLabels: showValues, trackitAccent: T.accent.teal }],
      },
      options: { plugins: { trackitValueLabels: { enabled: true, max: 12 } } },
      [T.hoverIndexKey]: hoverIndex,
      getDatasetMeta: () => ({
        type: 'bar',
        hidden: false,
        data: data.map((_, i) => ({
          x: 20 + i * 40, y: 100, width: barLength, height: barLength, horizontal: !!horizontal,
        })),
      }),
    },
  };
}

console.log('\nValue captions');
check('a small chart labels every non-zero bar', () => {
  const { chart, ctx } = makeLabelChart(4, [10, 20, 0, 40], true, -1, 80);
  labelPlugin.afterDatasetsDraw(chart);
  const labels = ctx.calls.fillText.map(c => c.text);
  assert.strictEqual(labels.length, 3, `zero values must be skipped, got ${labels.join(',')}`);
  assert.ok(labels.includes('10') && labels.includes('20') && labels.includes('40'));
});

check('a crowded chart labels only the bar under the cursor', () => {
  const { chart, ctx } = makeLabelChart(30, new Array(30).fill(10), true, 2, 80);
  labelPlugin.afterDatasetsDraw(chart);
  assert.strictEqual(ctx.calls.fillText.length, 1, 'only the hovered bar is labelled when crowded');
});

check('opted-out datasets stay quiet until hovered', () => {
  const { chart, ctx } = makeLabelChart(4, [10, 20, 30, 40], false, -1, 80);
  labelPlugin.afterDatasetsDraw(chart);
  assert.strictEqual(ctx.calls.fillText.length, 0, 'opted-out datasets stay quiet');
});

check('bars too small to caption are skipped', () => {
  const { chart, ctx } = makeLabelChart(4, [10, 20, 30, 40], true, -1, 8);
  labelPlugin.afterDatasetsDraw(chart);
  assert.strictEqual(ctx.calls.fillText.length, 0, 'slivers must not be captioned');
});

check('the hovered caption is readable on the light theme', () => {
  lightMode = true;
  const { chart, ctx } = makeLabelChart(1, [10], true, 0, 80);
  labelPlugin.afterDatasetsDraw(chart);
  const drawn = ctx.calls.fillText[0];
  assert.ok(drawn, 'the hovered bar must always be captioned');
  assert.notStrictEqual(drawn.fillStyle, 'rgba(203,213,225,0.9)', 'no dark-theme grey in light mode');
  lightMode = false;
});

check('horizontal bars caption past the bar end', () => {
  const { chart, ctx } = makeLabelChart(1, [10], true, 0, 120, true);
  labelPlugin.afterDatasetsDraw(chart);
  const drawn = ctx.calls.fillText[0];
  // the fixture bar starts at x = 20, so the caption must sit to its right
  assert.ok(drawn.x > 20, `caption must sit past the bar end, got x=${drawn.x}`);
  assert.strictEqual(ctx.textAlign, 'left');
});

console.log('\nLive theme switching');
check('refreshAll repaints a live chart into the other theme and back', () => {
  lightMode = false;
  const chart = T.createBar({ getContext: () => makeCtx() }, {
    data: {
      labels: ['a', 'b'],
      datasets: [T.styleDataset({ label: 'X', data: [1, 2] }, { accent: T.accent.teal })],
    },
    options: T.barOptions({ vertical: true, datasetCount: 1 }),
  });

  const darkTick = chart.options.scales.y.ticks.color;
  const darkGrid = chart.options.scales.y.grid.color;
  const darkTooltip = chart.options.plugins.tooltip.bodyColor;

  lightMode = true;
  T.refreshAll();

  assert.notStrictEqual(chart.options.scales.y.ticks.color, darkTick, 'ticks must follow the theme');
  assert.notStrictEqual(chart.options.scales.y.grid.color, darkGrid, 'grid must follow the theme');
  assert.notStrictEqual(chart.options.plugins.tooltip.bodyColor, darkTooltip, 'tooltip must follow the theme');
  assert.strictEqual(chart.options.scales.y.ticks.color, '#475569', 'light tick colour expected');
  assert.strictEqual(chart.mode, undefined, 'repaint must not animate');

  lightMode = false;
  T.refreshAll();
  assert.strictEqual(chart.options.scales.y.ticks.color, darkTick, 'switching back restores dark tokens');
});

check('the horizontal value axis is repainted too', () => {
  lightMode = false;
  const chart = T.createBar({ getContext: () => makeCtx() }, {
    data: { labels: ['a'], datasets: [T.styleDataset({ label: 'X', data: [1] }, {})] },
    options: T.barOptions({ horizontal: true, datasetCount: 1 }),
  });
  const before = chart.options.scales.x.grid.color;
  lightMode = true;
  T.refreshAll();
  assert.notStrictEqual(chart.options.scales.x.grid.color, before);
  lightMode = false;
});

console.log('\nConsistency across every bar chart in the product');
check('all seven bar charts share identical spacing, radius and responsiveness', () => {
  const configs = [
    T.barOptions({ vertical: true, categoryCount: 4, datasetCount: 1 }),                     // Key Metrics
    T.barOptions({ horizontal: true, categoryCount: 5, datasetCount: 1 }),                   // Top Trainees
    T.barOptions({ horizontal: true, categoryCount: 8, datasetCount: 1 }),                   // Hours
    T.barOptions({ vertical: true, timeSeries: true, dualAxis: true, categoryCount: 8, datasetCount: 2 }), // Attendance Trend
    T.barOptions({ horizontal: true, stacked: true, categoryCount: 8, datasetCount: 2 }),   // Trainee Progress
    T.barOptions({ vertical: true, timeSeries: true, categoryCount: 8, datasetCount: 2 }),  // Journal Trend
    T.barOptions({ vertical: true, timeSeries: true, categoryCount: 7, datasetCount: 1 }),  // Weekly Hours
  ];
  assert.strictEqual(configs.length, 7, 'seven bar charts expected');
  configs.forEach((o, i) => {
    assert.strictEqual(o.datasets.bar.barPercentage, 0.78, `chart ${i + 1}`);
    assert.strictEqual(o.datasets.bar.categoryPercentage, 0.68, `chart ${i + 1}`);
    assert.strictEqual(o.datasets.bar.borderRadius, 6, `chart ${i + 1}`);
    assert.strictEqual(o.datasets.bar.borderWidth, 0, `chart ${i + 1}`);
    assert.strictEqual(o.responsive, true, `chart ${i + 1} must be responsive`);
    assert.strictEqual(o.maintainAspectRatio, false, `chart ${i + 1}`);
  });
});

check('only the crowded category charts run horizontally; the time series stay vertical', () => {
  const topTrainees = T.barOptions({ horizontal: true, categoryCount: 5, datasetCount: 1 });
  const hours = T.barOptions({ horizontal: true, categoryCount: 8, datasetCount: 1 });
  const progress = T.barOptions({ horizontal: true, stacked: true, categoryCount: 8, datasetCount: 2 });
  const attendance = T.barOptions({ vertical: true, timeSeries: true, dualAxis: true, categoryCount: 8, datasetCount: 2 });
  const journal = T.barOptions({ vertical: true, timeSeries: true, categoryCount: 8, datasetCount: 2 });
  const weekly = T.barOptions({ vertical: true, timeSeries: true, categoryCount: 7, datasetCount: 1 });
  const metrics = T.barOptions({ vertical: true, categoryCount: 4, datasetCount: 1 });

  [topTrainees, hours, progress].forEach(o => assert.strictEqual(o.indexAxis, 'y'));
  [attendance, journal, weekly, metrics].forEach(o => assert.strictEqual(o.indexAxis, 'x'));
});

check('stacked and grouped arrangements are both wired as such', () => {
  const stacked = T.barOptions({ horizontal: true, stacked: true, datasetCount: 2 });
  assert.strictEqual(stacked.scales.x.stacked, true);
  assert.strictEqual(stacked.scales.y.stacked, true);
  const grouped = T.barOptions({ vertical: true, datasetCount: 2 });
  assert.ok(!grouped.scales.y.stacked, 'the grouped chart must stay unstacked');
});

check('every value axis still starts at zero', () => {
  [T.barOptions({ vertical: true }), T.barOptions({ horizontal: true })].forEach((o) => {
    const valueAxis = o.indexAxis === 'y' ? o.scales.x : o.scales.y;
    assert.strictEqual(valueAxis.beginAtZero, true);
  });
});

check('alpha() keeps the exact brand hues', () => {
  assert.strictEqual(T.alpha('#00c8aa', 0.5), 'rgba(0,200,170,0.5)');
  assert.strictEqual(T.alpha('#22c55e', 1), 'rgba(34,197,94,1)');
  assert.strictEqual(T.alpha('#3b82f6', 0.7), 'rgba(59,130,246,0.7)');
  assert.strictEqual(T.alpha('#f5c842', 0.2), 'rgba(245,200,66,0.2)');
});

const failed = results.filter(r => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===\n`);
process.exit(failed.length ? 1 : 0);
