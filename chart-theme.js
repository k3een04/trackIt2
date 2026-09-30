/**
 * TrackIT chart design system — the single source of truth for bar-chart styling
 * across the coordinator and student dashboards.
 *
 * Goals, in the project's own terms:
 *   - ONE reusable recipe so every bar chart looks like part of the same product
 *     instead of a default chart-library output.
 *   - Keep the established TrackIT palette untouched. Colours are read from the
 *     CSS custom properties the theme already defines (`--teal`, `--teal-dark`,
 *     `--gold`, ...), so dark mode and light mode both get exactly the accent
 *     colours the rest of the UI uses - including the light-mode teal/gold
 *     variants the stylesheets already switch to.
 *   - Survive a live theme switch: every chart registers itself here and
 *     `refreshAll()` repaints the grid, ticks, legends and tooltips in place.
 *
 * Data, labels, sorting, filters and data sources stay where they were - this
 * module only produces `options` and dataset cosmetics.
 *
 * Compatible with Chart.js 3.x and 4.x (the coordinator page pins 3.9.1, the
 * student page loads the latest v4), so it deliberately sticks to the API subset
 * both versions support.
 */
(function (global) {
  'use strict';

  // ──────────────────────────────────────────────────────────────────────────
  // PALETTE
  //
  // Fallbacks for the exact hex values already used by the dashboards. At run
  // time the live values are read from the theme's CSS variables so light mode
  // picks up its own (darker, higher-contrast) teal/gold automatically.
  // ──────────────────────────────────────────────────────────────────────────
  var FALLBACK = {
    dark: {
      teal: '#00c8aa',
      tealDark: '#00967d',
      gold: '#f5c842',
      muted: '#6b7a99',
      surface: '#111827',
      border: 'rgba(255,255,255,0.08)',
      text: '#e2e8f0',
      tick: 'rgba(203,213,225,0.62)',
      tickStrong: 'rgba(203,213,225,0.9)',
      grid: 'rgba(255,255,255,0.06)',
      legend: 'rgba(203,213,225,0.85)',
      tooltipBg: 'rgba(17,24,39,0.96)',
      tooltipBorder: 'rgba(255,255,255,0.1)',
      tooltipText: '#e2e8f0',
      tooltipTitle: '#ffffff',
    },
    light: {
      teal: '#00a88f',
      tealDark: '#008573',
      gold: '#d97706',
      muted: '#64748b',
      surface: '#ffffff',
      border: 'rgba(0,0,0,0.1)',
      text: '#1e293b',
      tick: '#475569',
      tickStrong: '#1e293b',
      grid: 'rgba(15,23,42,0.08)',
      legend: '#334155',
      tooltipBg: 'rgba(255,255,255,0.98)',
      tooltipBorder: 'rgba(15,23,42,0.12)',
      tooltipText: '#1e293b',
      tooltipTitle: '#0f172a',
    },
  };

  // Non-theme accents already in use across the dashboards. Kept verbatim so no
  // chart changes hue.
  var ACCENT = {
    teal: '#00c8aa',
    green: '#22c55e',
    blue: '#3b82f6',
    purple: '#a855f7',
    gold: '#f5c842',
    slate: '#94a3b8',
  };

  function readCssVar(name) {
    try {
      var value = getComputedStyle(document.body).getPropertyValue(name);
      return value && value.trim() ? value.trim() : '';
    } catch (error) {
      return '';
    }
  }

  function isLightMode() {
    return !!(document.body && document.body.classList.contains('light-mode'));
  }

  /** Live theme tokens, resolved from the active theme's CSS custom properties. */
  function tokens() {
    var light = isLightMode();
    var base = light ? FALLBACK.light : FALLBACK.dark;
    var out = {};
    Object.keys(base).forEach(function (key) { out[key] = base[key]; });

    // Prefer whatever the stylesheet currently defines.
    var teal = readCssVar('--teal');
    var tealDark = readCssVar('--teal-dark');
    var gold = readCssVar('--gold');
    var muted = readCssVar('--muted');
    var surface = readCssVar('--navy-mid');
    var border = readCssVar('--border');
    if (teal) out.teal = teal;
    if (tealDark) out.tealDark = tealDark;
    if (gold) out.gold = gold;
    if (muted) out.muted = muted;
    if (surface) out.surface = surface;
    if (border) out.border = border;

    out.isLight = light;
    return out;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // COLOUR HELPERS
  // ──────────────────────────────────────────────────────────────────────────

  function parseColor(input) {
    var value = String(input || '').trim();
    var hex = value.replace('#', '');
    if (/^[0-9a-f]{3}$/i.test(hex)) {
      hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    }
    if (/^[0-9a-f]{6}$/i.test(hex)) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
      };
    }
    var rgb = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(value);
    if (rgb) {
      return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
    }
    return { r: 0, g: 200, b: 170 };
  }

  /** Same hue, chosen alpha - this is how the palette is reused without new colours. */
  function alpha(color, value) {
    var c = parseColor(color);
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + value + ')';
  }

  function darken(color, amount) {
    var c = parseColor(color);
    var factor = 1 - amount;
    return 'rgb(' + Math.round(c.r * factor) + ',' +
      Math.round(c.g * factor) + ',' + Math.round(c.b * factor) + ')';
  }

  function relativeLuminance(color) {
    var c = parseColor(color);
    var channel = function (value) {
      var v = value / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  }

  /**
   * The accent colours are tuned for bars on a dark navy background. Used as
   * *text* on the light theme they lose contrast, so for labels the same hue is
   * progressively darkened until it is readable. The hue is never replaced, and
   * dark mode keeps the accent exactly as-is.
   */
  function readableTextColor(accent, theme) {
    if (!theme.isLight) return accent;
    var step = 0.12;
    var amount = 0;
    var candidate = accent;
    while (relativeLuminance(candidate) > 0.28 && amount < 0.72) {
      amount += step;
      candidate = darken(accent, amount);
    }
    return candidate;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PLUGINS
  // ──────────────────────────────────────────────────────────────────────────

  var HOVER_KEY = '$trackitHoverIndex';

  /**
   * Dims every bar except the one under the cursor and brightens the selected
   * bar. Chart.js resolves scriptable colours during `update()`, so the index is
   * cached on the chart and a single no-animation update is issued when it
   * changes (the guard prevents any update loop).
   */
  var hoverHighlight = {
    id: 'trackitBarHover',
    beforeInit: function (chart) {
      chart[HOVER_KEY] = -1;
    },
    afterInit: function (chart) {
      var canvas = chart.canvas;
      if (!canvas) return;
      // make sure the emphasis clears when the pointer leaves the plot
      canvas.addEventListener('mouseleave', function () {
        if (chart[HOVER_KEY] !== -1) {
          chart[HOVER_KEY] = -1;
          chart.update('none');
        }
      });
    },
  };

  function datasetValue(dataset, index) {
    var value = dataset.data ? dataset.data[index] : null;
    return typeof value === 'number' ? value : Number(value);
  }

  function formatValue(value, formatter) {
    if (value === null || value === undefined || isNaN(value)) return '';
    return formatter ? formatter(value) : String(Math.round(value * 100) / 100);
  }

  /**
   * Draws the exact value next to the bar it belongs to.
   *
   * Clutter control:
   *   - all values are labelled only when the chart has few enough bars
   *     (`valueLabelMax`, default 12) and the dataset opts in;
   *   - zero values are never labelled;
   *   - segments without room for the text are skipped;
   *   - the bar being hovered is always labelled, in the accent colour.
   */
  var valueLabels = {
    id: 'trackitValueLabels',
    afterDatasetsDraw: function (chart) {
      var cfg = chart.options && chart.options.plugins && chart.options.plugins.trackitValueLabels;
      if (!cfg || cfg.enabled === false) return;
      if (chart[HOVER_KEY] === undefined) return;

      var ctx = chart.ctx;
      var theme = tokens();
      var hoverIndex = chart[HOVER_KEY];
      var formatter = cfg.formatter;
      var maxLabels = typeof cfg.max === 'number' ? cfg.max : 12;
      var hovered = hoverIndex >= 0 ? hoverIndex : -1;

      ctx.save();
      ctx.textBaseline = 'middle';

      chart.data.datasets.forEach(function (dataset, datasetIndex) {
        var meta = chart.getDatasetMeta(datasetIndex);
        if (!meta || meta.hidden) return;
        // Only bars get value captions; the line overlay in a mixed chart keeps
        // its own point styling.
        if (meta.type && meta.type !== 'bar') return;

        var isStacked = !!dataset.stack;
        // Show every value when the chart is small enough; otherwise only the
        // value the user is pointing at.
        var showAll = dataset.trackitValueLabels === true
          && chart.data.labels.length <= maxLabels
          && !isStacked;

        meta.data.forEach(function (element, index) {
          if (!element) return;
          // only draw once the element actually has geometry
          if (!isFinite(element.x) || !isFinite(element.y)) return;
          var isHovered = index === hovered;
          if (!showAll && !isHovered) return;

          var value = datasetValue(dataset, index);
          if (!isFinite(value) || value === 0) return;
          var text = formatValue(value, formatter);
          if (!text) return;

          var horizontal = element.horizontal === true;
          var barLength = horizontal ? element.width : element.height;
          // no room for the caption on a sliver of a bar (except when hovered)
          if (!isHovered && !(barLength >= 16)) return;

          var accent = dataset.trackitAccent || theme.teal;
          // The accent is only used for the bar under the cursor; every other
          // label uses the neutral tick colour so the chart stays quiet.
          var color = isHovered
            ? readableTextColor(accent, theme)
            : theme.tickStrong;

          ctx.font = (isHovered ? '600 11px ' : '500 11px ') +
            (cfg.fontFamily || "'DM Sans', sans-serif");
          var pad = isHovered ? 8 : 5;

          if (horizontal) {
            ctx.textAlign = 'left';
            ctx.fillStyle = color;
            ctx.fillText(text, element.x + pad, element.y);
          } else {
            ctx.textAlign = 'center';
            ctx.fillStyle = color;
            ctx.fillText(text, element.x, element.y - pad - 4);
          }
        });
      });

      ctx.restore();
    },
  };
  // ──────────────────────────────────────────────────────────────────────────
  // OPTIONS FACTORY
  // ──────────────────────────────────────────────────────────────────────────

  var FONT_FAMILY = "'DM Sans', system-ui, sans-serif";

  /** Shared spacing so every bar chart in the product has identical proportions. */
  var SPACING = {
    barPercentage: 0.78,
    categoryPercentage: 0.68,
  };

  /**
   * A category chart with many bars reads far better horizontally. Time-series
   * charts (weeks, months) must stay vertical regardless, so callers pass
   * `timeSeries: true` to opt out of the automatic flip.
   */
  var HORIZONTAL_THRESHOLD = 7;

  function resolveAxis(categoryCount, preferredIndexAxis, isTimeSeries) {
    if (preferredIndexAxis === 'y' || preferredIndexAxis === 'x') {
      return preferredIndexAxis;
    }
    if (isTimeSeries) return 'x';
    return categoryCount > HORIZONTAL_THRESHOLD ? 'y' : 'x';
  }

  function axisTitle(text, theme) {
    return {
      display: !!text,
      text: text || '',
      color: theme.tick,
      font: { family: FONT_FAMILY, size: 11, weight: '500' },
      padding: { top: 4, bottom: 4, left: 4, right: 4 },
    };
  }

  /**
   * Builds the options object for a bar chart. `config` accepts:
   *   horizontal / vertical  -> force the index axis
   *   timeSeries             -> never auto-flip to horizontal
   *   categoryCount          -> drives the auto-flip rule
   *   legend                 -> force the legend on/off (default: on when 2+ datasets)
   *   stacked                -> stack both axes
   *   showValues / valueMax / valueFormatter -> value-label behaviour
   *   yTitle / xTitle / secondaryTitle       -> axis captions
   *   tooltipAfterLabel      -> existing callback, preserved verbatim
   *   dualAxis               -> keep the two-value-axis arrangement
   */
  function barOptions(config) {
    var cfg = config || {};
    var theme = tokens();
    var indexAxis = resolveAxis(
      cfg.categoryCount || 0,
      cfg.horizontal ? 'y' : (cfg.vertical ? 'x' : undefined),
      cfg.timeSeries
    );
    var horizontal = indexAxis === 'y';
    var stacked = cfg.stacked === true;

    // The value axis carries the gridlines; the category axis stays clean. That
    // single rule is what keeps every chart uncluttered.
    var valueAxis = {
      beginAtZero: true,
      stacked: stacked,
      border: { display: false },
      grid: {
        color: theme.grid,
        lineWidth: 1,
        drawTicks: false,
        tickLength: 0,
        drawBorder: false, // Chart.js 3 spelling; harmless on v4
      },
      ticks: {
        color: theme.tick,
        font: { family: FONT_FAMILY, size: 11 },
        padding: 8,
        maxTicksLimit: 6,
        precision: 0,
      },
      title: axisTitle(horizontal ? cfg.xTitle : cfg.yTitle, theme),
    };

    var categoryAxis = {
      stacked: stacked,
      border: { display: false },
      grid: { display: false, drawBorder: false },
      ticks: {
        color: theme.tick,
        font: { family: FONT_FAMILY, size: 11 },
        padding: 8,
        autoSkip: false,
        maxRotation: horizontal ? 0 : ((cfg.categoryCount || 0) > 6 ? 30 : 0),
        minRotation: 0,
      },
      title: axisTitle(horizontal ? cfg.yTitle : cfg.xTitle, theme),
    };

    var scales = horizontal
      ? { x: valueAxis, y: categoryAxis }
      : { x: categoryAxis, y: valueAxis };

    if (cfg.dualAxis) {
      // Preserve the existing two-axis arrangement (hours left, records right)
      // while restyling it consistently.
      scales.y = valueAxis;
      scales.y1 = {
        beginAtZero: true,
        position: 'right',
        border: { display: false },
        grid: { display: false, drawBorder: false },
        ticks: {
          color: theme.tick,
          font: { family: FONT_FAMILY, size: 11 },
          padding: 8,
          maxTicksLimit: 6,
          precision: 0,
        },
        title: axisTitle(cfg.secondaryTitle, theme),
      };
      scales.x = {
        grid: { display: false, drawBorder: false },
        border: { display: false },
        ticks: {
          color: theme.tick,
          font: { family: FONT_FAMILY, size: 11 },
          padding: 8,
          autoSkip: false,
          maxRotation: (cfg.categoryCount || 0) > 6 ? 30 : 0,
        },
      };
    }

    return {
      indexAxis: indexAxis,
      responsive: true,
      maintainAspectRatio: false,
      // Head-room for the value captions drawn past the bar end.
      layout: {
        padding: { top: 12, right: horizontal ? 34 : 8, bottom: 0, left: 4 },
      },
      animation: { duration: 420, easing: 'easeOutQuart' },
      scales: scales,
      interaction: {
        mode: 'nearest',
        intersect: true,
        axis: horizontal ? 'y' : 'x',
      },
      datasets: {
        bar: {
          barPercentage: SPACING.barPercentage,
          categoryPercentage: SPACING.categoryPercentage,
          borderSkipped: false,
          borderRadius: 6,
          borderWidth: 0,
          maxBarThickness: horizontal ? 26 : 38,
        },
      },
      onHover: function (event, elements, chart) {
        var next = elements && elements.length ? elements[0].index : -1;
        if (chart[HOVER_KEY] !== next) {
          chart[HOVER_KEY] = next;
          chart.update('none');
        }
      },
      plugins: {
        legend: {
          display: cfg.legend !== undefined ? cfg.legend : (cfg.datasetCount || 0) > 1,
          position: cfg.legendPosition || 'bottom',
          align: 'center',
          labels: {
            color: theme.legend,
            boxWidth: 8,
            boxHeight: 8,
            usePointStyle: true,
            pointStyle: 'circle',
            padding: 14,
            font: { family: FONT_FAMILY, size: 11, weight: '500' },
          },
        },
        tooltip: {
          enabled: true,
          backgroundColor: theme.tooltipBg,
          titleColor: theme.tooltipTitle,
          bodyColor: theme.tooltipText,
          borderColor: theme.tooltipBorder,
          borderWidth: 1,
          cornerRadius: 8,
          padding: { top: 10, right: 12, bottom: 10, left: 12 },
          displayColors: true,
          boxWidth: 8,
          boxHeight: 8,
          boxPadding: 5,
          usePointStyle: true,
          titleFont: { family: FONT_FAMILY, size: 11, weight: '600' },
          bodyFont: { family: FONT_FAMILY, size: 12 },
          afterLabel: cfg.tooltipAfterLabel, // existing callback kept as-is
        },
        trackitValueLabels: {
          enabled: cfg.showValues !== false,
          max: typeof cfg.valueMax === 'number' ? cfg.valueMax : 12,
          formatter: cfg.valueFormatter,
          fontFamily: FONT_FAMILY,
        },
      },
    };
  }
  // ──────────────────────────────────────────────────────────────────────────
  // DATASET STYLING HELPERS
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * A bar fill in the established palette: a soft top-to-bottom gradient of the
   * same hue. No new colours and no heavy outline stroke - dropping the outline
   * is a large part of what removes the "default chart library" look.
   */
  function barFill(accent, theme, strong) {
    return function (context) {
      var chart = context.chart;
      var hovered = chart && chart[HOVER_KEY];
      var topAlpha;
      var bottomAlpha;

      if (hovered === undefined || hovered === -1) {
        topAlpha = strong ? 0.95 : 0.82;
        bottomAlpha = strong ? 0.72 : 0.5;
      } else if (hovered === context.dataIndex) {
        topAlpha = 1;
        bottomAlpha = 0.82;
      } else {
        topAlpha = 0.26;
        bottomAlpha = 0.14;
      }

      var area = chart && chart.chartArea;
      if (!area || !(area.bottom - area.top)) return alpha(accent, topAlpha);
      var gradient = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
      gradient.addColorStop(0, alpha(accent, topAlpha));
      gradient.addColorStop(1, alpha(accent, bottomAlpha));
      return gradient;
    };
  }

  /** A flat alpha fill, for charts that should not read as a gradient. */
  function flatFill(accent) {
    return function (context) {
      var chart = context.chart;
      var hovered = chart && chart[HOVER_KEY];
      if (hovered === undefined || hovered === -1) return alpha(accent, 0.8);
      return hovered === context.dataIndex ? alpha(accent, 0.95) : alpha(accent, 0.26);
    };
  }

  /** Applies the palette + value-label flag to a dataset in one call. */
  function styleDataset(dataset, options) {
    var opts = options || {};
    var theme = tokens();
    var accent = opts.accent || theme.teal;

    dataset.backgroundColor = opts.fill === 'flat'
      ? flatFill(accent)
      : barFill(accent, theme, opts.strong === true);
    dataset.hoverBackgroundColor = alpha(accent, 1);
    dataset.borderColor = alpha(accent, 1);
    dataset.borderWidth = 0;
    // Geometry already present on the dataset wins - that is how the stacked
    // chart rounds only the outer end of each stack instead of every segment.
    if (dataset.borderRadius === undefined) {
      dataset.borderRadius = opts.borderRadius === undefined ? 6 : opts.borderRadius;
    }
    if (dataset.borderSkipped === undefined) {
      dataset.borderSkipped = opts.borderSkipped === undefined ? false : opts.borderSkipped;
    }
    dataset.barPercentage = SPACING.barPercentage;
    dataset.categoryPercentage = SPACING.categoryPercentage;
    dataset.maxBarThickness = opts.maxBarThickness || 38;
    dataset.trackitValueLabels = opts.showValues !== false;
    dataset.trackitAccent = accent;
    return dataset;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // REGISTRY + LIVE THEME REFRESH
  // ──────────────────────────────────────────────────────────────────────────

  var registry = [];

  /** Re-derives every theme-dependent colour of one chart and repaints it. */
  function repaint(chart) {
    var theme = tokens();
    var options = chart.options;

    if (options.scales) {
      Object.keys(options.scales).forEach(function (key) {
        var scale = options.scales[key];
        if (!scale) return;
        if (scale.ticks) scale.ticks.color = theme.tick;
        if (scale.title) scale.title.color = theme.tick;
        // Only the gridline-bearing (value) axis is tinted; the category axis
        // has no grid at all.
        if (scale.grid && scale.grid.color) scale.grid.color = theme.grid;
        scale.borderColor = theme.border;
      });
    }

    if (options.plugins) {
      if (options.plugins.legend && options.plugins.legend.labels) {
        options.plugins.legend.labels.color = theme.legend;
      }
      var tooltip = options.plugins.tooltip;
      if (tooltip) {
        tooltip.backgroundColor = theme.tooltipBg;
        tooltip.titleColor = theme.tooltipTitle;
        tooltip.bodyColor = theme.tooltipText;
        tooltip.borderColor = theme.tooltipBorder;
      }
    }

    // A theme flip must not animate - it would read as a redraw glitch.
    chart.update('none');
  }

  /** Repaints every registered bar chart. Call this from the theme toggle. */
  function refreshAll() {
    prune();
    registry.forEach(function (chart) {
      try {
        repaint(chart);
      } catch (error) {
        if (window.console) console.warn('[TrackITCharts] repaint skipped:', error.message);
      }
    });
  }

  /** Register a chart so a later theme switch can restyle it in place. */
  function register(chart) {
    if (!chart) return chart;
    if (registry.indexOf(chart) === -1) registry.push(chart);

    var originalDestroy = chart.destroy;
    chart.destroy = function () {
      var index = registry.indexOf(chart);
      if (index !== -1) registry.splice(index, 1);
      return originalDestroy.apply(this, arguments);
    };
    return chart;
  }

  /** A chart is only live while its canvas is in the DOM (tab switches). */
  function prune() {
    registry = registry.filter(function (chart) {
      return chart && chart.canvas && document.body.contains(chart.canvas);
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PUBLIC API
  // ──────────────────────────────────────────────────────────────────────────

  var PLUGIN_SET = [hoverHighlight, valueLabels];

  global.TrackITCharts = {
    tokens: tokens,
    alpha: alpha,
    accent: ACCENT,
    barOptions: barOptions,
    styleDataset: styleDataset,
    barFill: barFill,
    flatFill: flatFill,
    resolveAxis: resolveAxis,
    register: register,
    refreshAll: refreshAll,
    prune: prune,
    repaint: repaint,
    hoverIndexKey: HOVER_KEY,
    plugins: PLUGIN_SET,

    /**
     * Attaches the shared plugins to a chart config without registering the same
     * plugin id twice (which would draw the value labels on top of each other).
     */
    withPlugins: function (config) {
      var merged = Object.assign({}, config || {});
      var existing = Array.isArray(merged.plugins) ? merged.plugins.slice() : [];
      PLUGIN_SET.forEach(function (plugin) {
        var already = existing.some(function (entry) {
          return entry && entry.id === plugin.id;
        });
        if (!already) existing.push(plugin);
      });
      merged.plugins = existing;
      return merged;
    },

    /**
     * The single entry point used by every bar chart:
     * styles the datasets, builds the themed options, attaches the plugins,
     * creates the chart and registers it for future theme switches.
     */
    createBar: function (canvas, config) {
      var cfg = config || {};
      var chart = new global.Chart(canvas, this.withPlugins({
        type: 'bar',
        data: cfg.data,
        options: cfg.options,
      }));
      return register(chart);
    },
  };
})(window);
