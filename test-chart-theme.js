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

const hoverPlugin = T.plugins.find(p => p.id === 'trackitBarHover');

check('the hover highlight never calls chart.update (render-loop safe)', () => {
  const o = T.barOptions({ vertical: true });
  const chart = { updates: 0, update() { this.updates += 1; } };
  o.onHover({}, [{ index: 3 }], chart);
  assert.strictEqual(chart.updates, 0,
    'onHover must not trigger an update - it would fight Chart.js render loop');
});

check('the hover plugin lifts the selected bar and dims the others in-place', () => {
  const key = T.hoverIndexKey;
  function build(activeIndex) {
    const ctx = makeCtx();
    const elements = [0, 1, 2].map(() => ({ options: {} }));
    return {
      ctx,
      chart: {
        ctx,
        chartArea: { top: 0, bottom: 200 },
        data: {
          datasets: [{
            data: [10, 20, 30],
            trackitAccent: T.accent.teal,
            trackitFlat: false,
            hoverBackgroundColor: 'rgba(0,0,0,0)',
          }],
        },
        [key]: -1,
        getDatasetMeta: () => ({ type: 'bar', data: elements }),
        getActiveElements: () => (activeIndex < 0 ? [] : [{ datasetIndex: 0, index: activeIndex }]),
      },
      elements,
    };
  }

  const rest = build(-1);
  hoverPlugin.beforeDatasetsDraw(rest.chart);
  assert.strictEqual(rest.chart[key], -1);
  const restAlpha = (el) => parseFloat(el.options.backgroundColor.stops[0].color.split(',')[3]);
  assert.ok(restAlpha(rest.elements[0]) > 0.7, 'resting bars stay fully legible');

  const hovered = build(1);
  hoverPlugin.beforeDatasetsDraw(hovered.chart);
  assert.strictEqual(hovered.chart[key], 1, 'the hovered index is tracked');
  assert.ok(restAlpha(hovered.elements[1]) > restAlpha(hovered.elements[0]),
    'the selected bar is lifted');
  assert.ok(restAlpha(hovered.elements[0]) < 0.4,
    `non-selected bars are dimmed, got ${restAlpha(hovered.elements[0])}`);
});

check('the hover highlight leaves foreign datasets untouched', () => {
  const key = T.hoverIndexKey;
  const elements = [{ options: {} }, { options: {} }];
  const chart = {
    ctx: makeCtx(),
    chartArea: { top: 0, bottom: 200 },
    data: { datasets: [{ data: [1, 2] }, { data: [3, 4] }] }, // no trackitAccent
    [key]: -1,
    getDatasetMeta: () => ({ type: 'bar', data: elements }),
    getActiveElements: () => [{ datasetIndex: 0, index: 0 }],
  };
  hoverPlugin.beforeDatasetsDraw(chart);
  assert.deepStrictEqual(elements[0].options, {}, 'a dataset we did not style is not touched');
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

console.log('\nRegressions (bugs that broke chart rendering)');
check('no bar-chart code calls chart.update() from the hover path', () => {
  // A chart.update() inside onHover / a canvas listener fights Chart.js's render
  // loop: the chart re-renders forever and appears never to load.
  const raw = fs.readFileSync(path.join(__dirname, 'chart-theme.js'), 'utf8');
  // strip comments so the explanatory notes are not mistaken for code
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(source.indexOf('onHover') > -1, 'onHover handler not found');
  assert.ok(!/onHover\s*:\s*function[^{]*\{[^}]*\.update\(/.test(source),
    'onHover must not call chart.update() - it re-enters the render loop');
  assert.ok(!/addEventListener\([^)]*mouseleave[\s\S]{0,240}?\.update\(/.test(source),
    'no canvas listener may call chart.update()');
  // hoverBackgroundColor is the native highlight; we must not also force updates
  assert.ok(source.indexOf('getActiveElements') > -1,
    'the hover highlight should read the active elements during the render pass');
});

check('the stylesheets never force the chart canvas width', () => {
  // Chart.js sizes its own canvas when `responsive: true`. Forcing the width
  // from CSS makes its resize observer fight the layout.
  ['visuals/coordinator-dashboard.css', 'visuals/ojtdashboard.css'].forEach((rel) => {
    const file = path.join(__dirname, rel);
    const css = fs.readFileSync(file, 'utf8');
    const frameRule = /\.chart-frame\s*>\s*canvas\s*\{([\s\S]*?)\}/.exec(css);
    assert.ok(frameRule, `${rel}: .chart-frame > canvas rule not found`);
    assert.ok(!/width\s*:\s*100%\s*!important/.test(frameRule[1]),
      `${rel}: must not force the canvas width - it breaks Chart.js resizing`);
  });
});

check('every chart frame uses a fluid height, not a fixed pixel value', () => {
  ['coordinator-dashboard.html', 'ojtdashboard.html'].forEach((rel) => {
    const html = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    const barFrames = html.match(/class="chart-frame chart-frame--bars[^"]*"/g) || [];
    assert.ok(barFrames.length > 0, `${rel}: expected bar chart frames`);
    barFrames.forEach((frame) => {
      assert.ok(!/height\s*:\s*\d+px/.test(frame), 'a bar frame still uses a fixed height');
    });
  });
});

check('the shared design system is loaded on both dashboards', () => {
  ['coordinator-dashboard.html', 'ojtdashboard.html'].forEach((rel) => {
    const html = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    const chartJs = html.indexOf('chart');
    const themeJs = html.indexOf('chart-theme.js');
    const dashJs = html.indexOf(rel.startsWith('coordinator')
      ? 'coordinator-dashboard.js'
      : 'ojtdashboard.js');
    assert.ok(themeJs > -1, `${rel}: chart-theme.js is not loaded`);
    assert.ok(themeJs < dashJs, `${rel}: chart-theme.js must load before the dashboard script`);
    assert.ok(chartJs < themeJs, `${rel}: Chart.js must load before chart-theme.js`);
  });
});

console.log('\nGlassmorphism design system');
const GLASS = fs.readFileSync(path.join(__dirname, 'visuals/trackit-glass.css'), 'utf8');
const DASHBOARDS = ['coordinator-dashboard.html', 'ojtdashboard.html', 'supervisor-dashboard.html'];

check('the shared design system is loaded by every dashboard', () => {
  DASHBOARDS.forEach((rel) => {
    const html = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    assert.ok(html.includes('visuals/trackit-glass.css'),
      `${rel} does not load the shared glassmorphism stylesheet`);
  });
});

check('the design system loads after each page-specific stylesheet', () => {
  DASHBOARDS.forEach((rel) => {
    const html = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    const own = html.search(/visuals\/(coordinator|ojt|supervisor)-dashboard\.css/);
    const glass = html.indexOf('visuals/trackit-glass.css');
    assert.ok(glass > own,
      `${rel}: trackit-glass.css must load after its own stylesheet to win the cascade`);
  });
});

check('brand colours are unchanged', () => {
  assert.ok(GLASS.includes('--tk-teal: #00c8aa'), 'dark accent must stay #00C8AA');
  assert.ok(GLASS.includes('--tk-teal: #00a98f'), 'light accent must stay #00A98F');
  assert.ok(/body\s*\{[^}]*background-color:\s*#0a0f1e/i.test(GLASS), 'dark bg must be #0A0F1E');
  assert.ok(/body\.light-mode\s*\{[^}]*background-color:\s*#f5f7fa/i.test(GLASS), 'light bg must be #F5F7FA');
});

check('the same radius, hairline and blur tokens drive every surface', () => {
  // One radius scale, one hairline, one blur - that is what makes the UI feel
  // like a single application rather than sections designed separately.
  ['--tk-radius:', '--tk-radius-sm:', '--tk-radius-lg:'].forEach((token) => {
    assert.ok(GLASS.includes(token), `missing shared geometry token ${token}`);
  });
  assert.ok(/--tk-blur:\s*\d+px/.test(GLASS), 'missing shared blur token');
  assert.ok(/--tk-hairline:\s*rgba/.test(GLASS), 'missing shared hairline token');
});

check('glass treatment covers cards, tables, forms, badges, modals and nav', () => {
  const required = [
    '.glass-card',        // cards / panels
    '.analytics-kpi',     // stat cards
    '.analytics-table-wrap', // tables
    'input',              // forms / search / filters
    '.status-badge',      // status badges
    '.notif-popup',       // notifications
    'body nav',           // top nav
    '.sidebar',           // sidebar
    '.btn-primary',       // buttons
  ];
  required.forEach((selector) => {
    assert.ok(GLASS.includes(selector),
      `glass system does not cover ${selector}`);
  });
});

check('both themes are handled, not one inverted into the other', () => {
  const light = GLASS.slice(GLASS.indexOf('body.light-mode'));
  assert.ok(light.includes('--tk-surface-1'), 'light theme needs its own surface token');
  assert.ok(light.includes('--tk-text:'), 'light theme needs its own text token');
  // light mode must not simply reuse the dark translucent fills
  assert.ok(!/body\.light-mode[\s\S]{0,400}rgba\(255,\s*255,\s*255,\s*0\.0(45|75|11)\)/.test(light),
    'light mode reuses the dark surface alpha instead of a designed one');
});

check('teal stays an accent, never a surface fill', () => {
  // Surfaces must be neutral; teal may only appear on interactive/indicator
  // rules. A teal card background would turn the whole UI cyan.
  const surfaceBlock = GLASS.slice(GLASS.indexOf('--tk-surface-1'), GLASS.indexOf('--tk-hairline:'));
  assert.ok(!surfaceBlock.includes('0, 200, 170'),
    'a glass surface token must not be teal-tinted');
});

check('accessibility and motion guards are present', () => {
  assert.ok(GLASS.includes('prefers-reduced-motion'), 'must respect reduced motion');
  assert.ok(GLASS.includes('focus-visible'), 'must provide a visible focus ring');
  assert.ok(GLASS.includes('-webkit-backdrop-filter'), 'Safari needs the -webkit- blur prefix');
});

check('responsive tables never get squeezed into a phone viewport', () => {
  assert.ok(/@media \(max-width: 768px\)[\s\S]{0,900}overflow-x:\s*auto/.test(GLASS),
    'tables must scroll horizontally on small screens');
  assert.ok(GLASS.includes('.table-stack'),
    'a stacked-row presentation must be available for narrow screens');
});

const failed = results.filter(r => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===\n`);
process.exit(failed.length ? 1 : 0);
