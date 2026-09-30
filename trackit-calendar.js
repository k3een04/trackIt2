/* ══════════════════════════════════════════════════════════════════════════
   TrackIT Calendar — reusable date / month picker
   ---------------------------------------------------------------------------
   Vanilla ES5-compatible, no dependencies. Enhances the TrackIT date/month
   fields in place:

     <input type="date"  data-trackit-cal="date"  ...>
     <input type="month" data-trackit-cal="month" ...>

   CONTRACT WITH EXISTING PAGE CODE (unchanged behaviour):
     • the original <input> stays in the DOM and stays the source of truth;
       .value keeps its native format (YYYY-MM-DD / YYYY-MM)
     • the input's `input` and `change` events are re-dispatched after a pick,
       so inline onchange="..." handlers and addEventListener('change')
       listeners both still fire
     • values written programmatically (setTodayDate(), the supervisor month
       default) are picked up, because the field is re-read on every open

   The native `type` is switched to "text" purely to suppress the OS-drawn
   popup, which cannot be styled. `readOnly` + `inputmode="none"` mean the
   field is only ever populated through the calendar.

   Public API:
     TrackITCalendar.enhance(el)      → instance for one field
     TrackITCalendar.init(root)       → enhance every field under a root
     TrackITCalendar.setDayMeta(fn)   → opt-in per-day state hook
                                         fn(Date) → {disabled, booked, event,
                                                     inRange, rangeStart,
                                                     rangeEnd} | null
     TrackITCalendar.parse(v, mode)   → {y,m,d} | null
     TrackITCalendar.format(o, mode)  → native value string
   ══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  var DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  var DOW_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday',
    'Friday', 'Saturday'];

  var COLS = 3;             // month + year grids are three columns
  var YEAR_SPAN = 12;       // years shown per year-view page
  var YEARS_LEAD = 5;       // puts the active year on the second row

  var dayMetaHook = null;

  /* ── small date helpers (values are plain {y,m,d} objects) ─────────────── */

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }

  function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }

  function toParts(dt) {
    return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
  }

  function toDate(o) { return new Date(o.y, o.m - 1, o.d); }

  function sameDay(a, b) {
    return !!a && !!b && a.y === b.y && a.m === b.m && a.d === b.d;
  }

  function today() { return toParts(new Date()); }

  function shiftDays(o, delta) {
    return toParts(new Date(o.y, o.m - 1, o.d + delta));
  }

  function shiftMonths(o, delta) {
    var y = o.y;
    var m = o.m + delta;
    while (m < 1) { m += 12; y -= 1; }
    while (m > 12) { m -= 12; y += 1; }
    return { y: y, m: m, d: clamp(o.d, 1, daysInMonth(y, m)) };
  }

  function parseValue(v, mode) {
    if (v === null || v === undefined) return null;
    var re = mode === 'month' ? /^(\d{4})-(\d{2})$/ : /^(\d{4})-(\d{2})-(\d{2})$/;
    var g = re.exec(String(v).trim());
    if (!g) return null;
    var o = { y: +g[1], m: +g[2], d: g[3] ? +g[3] : 1 };
    if (o.m < 1 || o.m > 12) return null;
    if (o.d < 1 || o.d > daysInMonth(o.y, o.m)) return null;
    return o;
  }

  function formatValue(o, mode) {
    return mode === 'month'
      ? o.y + '-' + pad(o.m)
      : o.y + '-' + pad(o.m) + '-' + pad(o.d);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  /* ── instance ─────────────────────────────────────────────────────────── */

  function Calendar(input, mode) {
    this.input = input;
    this.mode = mode;
    this.view = mode === 'month' ? 'month' : 'day';
    this.cursor = { y: 2000, m: 1, d: 1 };
    this.yearBase = 2000;
    this.selected = null;
    this.focusDate = null;
    this.openState = false;
    this.pop = null;
    this.days = [];
    this.dayParts = [];
    this.opts = [];
    this.optParts = [];
    this._bind();
  }

  /* ── field wiring ─────────────────────────────────────────────────────── */

  Calendar.prototype._bind = function () {
    var self = this;
    var input = this.input;

    input.type = 'text';
    input.readOnly = true;
    input.setAttribute('inputmode', 'none');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('spellcheck', 'false');
    input.classList.add('tk-cal-field');
    input.setAttribute('aria-haspopup', 'dialog');
    input.setAttribute('aria-expanded', 'false');

    input.addEventListener('click', function () { self.toggle(); });

    input.addEventListener('keydown', function (e) {
      var k = e.key;
      if (k === 'Enter' || k === ' ' || k === 'Spacebar' ||
          k === 'ArrowDown' || k === 'ArrowUp') {
        e.preventDefault();
        self.toggle();
      }
    });

    // Page code may write .value directly without raising an event — open()
    // re-reads the field, so this only keeps the cached selection honest.
    input.addEventListener('change', function () { self.sync(); });
    input.addEventListener('input', function () { self.sync(); });
  };

  Calendar.prototype.sync = function () {
    this.selected = parseValue(this.input.value, this.mode);
    return this.selected;
  };

  /* ── popover construction ─────────────────────────────────────────────── */

  Calendar.prototype._build = function () {
    var self = this;
    var pop = el('div', 'tk-cal-pop');
    pop.hidden = true;
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label',
      this.mode === 'month' ? 'Choose a month' : 'Choose a date');

    /* header: ‹  October 2026  › */
    var head = el('div', 'tk-cal-head');

    var prev = el('button', 'tk-cal-nav tk-cal-nav--prev');
    prev.type = 'button';
    prev.setAttribute('aria-label', 'Previous');
    prev.addEventListener('click', function () { self.step(-1); });

    var title = el('button', 'tk-cal-title');
    title.type = 'button';
    title.addEventListener('click', function () {
      if (self.view === 'day') self.setView('month', 0, -4);
      else if (self.view === 'month') self.setView('year', 0, -4);
    });

    var next = el('button', 'tk-cal-nav tk-cal-nav--next');
    next.type = 'button';
    next.setAttribute('aria-label', 'Next');
    next.addEventListener('click', function () { self.step(1); });

    head.appendChild(prev);
    head.appendChild(title);
    head.appendChild(next);
    pop.appendChild(head);

    /* day view */
    var viewDay = el('div', 'tk-cal-view');
    var wk = el('div', 'tk-cal-weekdays');
    wk.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < 7; i++) wk.appendChild(el('span', null, DOW[i]));
    viewDay.appendChild(wk);

    var gridDay = el('div', 'tk-cal-grid');
    gridDay.setAttribute('role', 'group');
    gridDay.setAttribute('aria-label', 'Days');
    viewDay.appendChild(gridDay);
    pop.appendChild(viewDay);

    /* month view */
    var viewMonth = el('div', 'tk-cal-view');
    var gridMonth = el('div', 'tk-cal-grid tk-cal-grid--month');
    gridMonth.setAttribute('role', 'group');
    gridMonth.setAttribute('aria-label', 'Months');
    viewMonth.appendChild(gridMonth);
    pop.appendChild(viewMonth);

    /* year view */
    var viewYear = el('div', 'tk-cal-view');
    var gridYear = el('div', 'tk-cal-grid tk-cal-grid--year');
    gridYear.setAttribute('role', 'group');
    gridYear.setAttribute('aria-label', 'Years');
    viewYear.appendChild(gridYear);
    pop.appendChild(viewYear);

    gridDay.addEventListener('keydown', function (e) { self._dayKey(e); });
    gridMonth.addEventListener('keydown', function (e) { self._optKey(e); });
    gridYear.addEventListener('keydown', function (e) { self._optKey(e); });

    document.body.appendChild(pop);

    this.pop = pop;
    this.el = {
      prev: prev, next: next, title: title,
      viewDay: viewDay, gridDay: gridDay,
      viewMonth: viewMonth, gridMonth: gridMonth,
      viewYear: viewYear, gridYear: gridYear
    };

    /* global handlers — bound once, attached only while open */
    this._down = function (e) {
      if (pop.contains(e.target) || e.target === self.input) return;
      self.close(false);
    };
    this._key = function (e) {
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.preventDefault();
        e.stopPropagation();
        self.close(true);
      }
    };
    this._focusin = function (e) {
      var t = e.target;
      if (t === document.body) return;   /* clicked non-focusable padding */
      if (pop.contains(t) || t === self.input) return;
      self.close(false);
    };
    this._viewport = function () { self.position(); };

    /* Focus leaving the panel for a real element (Tab out) closes it. A
       null relatedTarget means focus landed nowhere — keep it open. */
    pop.addEventListener('focusout', function (e) {
      var to = e.relatedTarget;
      if (!to || pop.contains(to) || to === self.input) return;
      self.close(false);
    });
  };

  /* ── open / close / position ──────────────────────────────────────────── */

  Calendar.prototype.toggle = function () {
    if (this.openState) this.close(true); else this.open();
  };

  Calendar.prototype.open = function () {
    if (this.openState) return;
    if (!this.pop) this._build();

    this.sync();

    var base = this.selected || today();
    this.cursor = { y: base.y, m: base.m, d: base.d };
    this.focusDate = this.selected
      ? { y: base.y, m: base.m, d: base.d }
      : today();
    this.yearBase = clamp(base.y - YEARS_LEAD, 1, 9000);
    this.view = this.mode === 'month' ? 'month' : 'day';

    this.openState = true;
    this.pop.hidden = false;
    this.render();
    this.position();

    var self = this;
    requestAnimationFrame(function () {
      if (self.openState) self.pop.classList.add('is-open');
    });

    this.input.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', this._down, true);
    document.addEventListener('keydown', this._key, true);
    document.addEventListener('focusin', this._focusin, true);
    document.addEventListener('scroll', this._viewport, true);
    global.addEventListener('resize', this._viewport);
    this.focusActive();
  };

  Calendar.prototype.close = function (refocus) {
    if (!this.openState) return;
    this.openState = false;
    this.pop.classList.remove('is-open');
    this.pop.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', this._down, true);
    document.removeEventListener('keydown', this._key, true);
    document.removeEventListener('focusin', this._focusin, true);
    document.removeEventListener('scroll', this._viewport, true);
    global.removeEventListener('resize', this._viewport);
    if (refocus) this.input.focus();
  };

  Calendar.prototype.position = function () {
    var pop = this.pop;
    if (!pop || pop.hidden) return;
    var r = this.input.getBoundingClientRect();
    var w = pop.offsetWidth;
    var h = pop.offsetHeight;
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    var left = r.left;
    var top = r.bottom + 6;

    if (left + w > vw - 8) left = vw - w - 8;
    if (left < 8) left = 8;
    if (top + h > vh - 8) {
      var above = r.top - 6 - h;
      top = above >= 8 ? above : Math.max(8, vh - h - 8);
    }
    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.round(top) + 'px';
  };

  /* ── view switching ───────────────────────────────────────────────────── */

  Calendar.prototype.setView = function (name, dx, dy) {
    if (this.view === name) return;
    if (name === 'year') this.yearBase = clamp(this.cursor.y - YEARS_LEAD, 1, 9000);
    this.view = name;
    this.render(dx || 0, dy || 0);
    this.focusActive();
  };

  /* ‹ › — meaning follows the active view */
  Calendar.prototype.step = function (dir) {
    if (this.view === 'day') {
      var keep = this.focusDate ? this.focusDate.d : this.cursor.d || 1;
      this.cursor = shiftMonths(
        { y: this.cursor.y, m: this.cursor.m, d: keep }, dir);
      this.focusDate = {
        y: this.cursor.y, m: this.cursor.m, d: this.cursor.d
      };
      this.render(dir * 6, 0);
      this.focusActive();
    } else if (this.view === 'month') {
      this.cursor.y += dir;
      this.render(dir * 6, 0);
      this.focusActive();
    } else {
      this.yearBase += dir * YEAR_SPAN;
      this.render(dir * 6, 0);
      this.focusActive();
    }
  };

  Calendar.prototype.render = function (dx, dy) {
    var v = this.view;
    var i;

    this._renderTitle();

    this.el.prev.setAttribute('aria-label', v === 'day'
      ? 'Previous month' : (v === 'month' ? 'Previous year' : 'Previous years'));
    this.el.next.setAttribute('aria-label', v === 'day'
      ? 'Next month' : (v === 'month' ? 'Next year' : 'Next years'));

    var views = [this.el.viewDay, this.el.viewMonth, this.el.viewYear];
    for (i = 0; i < views.length; i++) views[i].classList.remove('is-active');

    var target;
    if (v === 'day') { this._renderDays(); target = this.el.viewDay; }
    else if (v === 'month') { this._renderMonths(); target = this.el.viewMonth; }
    else { this._renderYears(); target = this.el.viewYear; }

    target.style.setProperty('--tk-cal-dx', (dx || 0) + 'px');
    target.style.setProperty('--tk-cal-dy', (dy || 0) + 'px');
    /* force a reflow so the entrance animation restarts on every switch */
    void this.pop.offsetWidth;
    target.classList.add('is-active');
  };

  Calendar.prototype._renderTitle = function () {
    var t = this.el.title;
    t.textContent = '';
    var isYear = this.view === 'year';
    t.classList.toggle('is-static', isYear);
    t.disabled = isYear;

    if (this.view === 'day') {
      t.appendChild(document.createTextNode(MONTHS[this.cursor.m - 1]));
      t.appendChild(document.createTextNode(' '));
      t.appendChild(el('span', 'tk-cal-year', String(this.cursor.y)));
      t.setAttribute('aria-label', 'Choose month and year. Currently ' +
        MONTHS[this.cursor.m - 1] + ' ' + this.cursor.y);
    } else if (this.view === 'month') {
      t.appendChild(el('span', 'tk-cal-year', String(this.cursor.y)));
      t.setAttribute('aria-label', 'Choose year. Currently ' + this.cursor.y);
    } else {
      t.appendChild(el('span', 'tk-cal-year',
        this.yearBase + ' – ' + (this.yearBase + YEAR_SPAN - 1)));
      t.setAttribute('aria-label', 'Years ' + this.yearBase +
        ' to ' + (this.yearBase + YEAR_SPAN - 1));
    }
  };

  /* ── day grid: six rows, always ───────────────────────────────────────── */

  Calendar.prototype._renderDays = function () {
    var grid = this.el.gridDay;
    var y = this.cursor.y;
    var m = this.cursor.m;
    var now = today();
    var i;

    grid.textContent = '';
    this.days.length = 0;
    this.dayParts.length = 0;

    var lead = new Date(y, m - 1, 1).getDay();
    var start = new Date(y, m - 1, 1 - lead);

    /* keep the roving tab stop inside the month being shown */
    if (!this.focusDate || this.focusDate.y !== y || this.focusDate.m !== m) {
      this.focusDate = (this.selected && this.selected.y === y && this.selected.m === m)
        ? { y: y, m: m, d: this.selected.d }
        : (now.y === y && now.m === m ? now : { y: y, m: m, d: 1 });
    }

    for (i = 0; i < 42; i++) {
      var dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      var part = toParts(dt);
      var btn = el('button', 'tk-cal-day', String(part.d));
      btn.type = 'button';
      btn.tabIndex = -1;

      if (dt.getMonth() !== m - 1) btn.classList.add('is-outside');
      if (sameDay(part, now)) {
        btn.classList.add('is-today');
        btn.setAttribute('aria-current', 'date');
      }
      if (sameDay(part, this.selected)) {
        btn.classList.add('is-selected');
        btn.setAttribute('aria-pressed', 'true');
      }

      var meta = dayMetaHook ? dayMetaHook(dt) : null;
      if (meta) {
        if (meta.booked) btn.classList.add('is-booked');
        if (meta.event) btn.classList.add('has-event');
        if (meta.inRange) btn.classList.add('is-in-range');
        if (meta.rangeStart) btn.classList.add('is-range-start');
        if (meta.rangeEnd) btn.classList.add('is-range-end');
        if (meta.disabled) {
          btn.disabled = true;
          btn.classList.add('is-disabled');
        }
      }

      btn.setAttribute('aria-label',
        DOW_FULL[dt.getDay()] + ', ' + MONTHS[dt.getMonth()] + ' ' +
        part.d + ', ' + part.y);

      this._wireDay(btn, part);

      grid.appendChild(btn);
      this.days.push(btn);
      this.dayParts.push(part);
    }

    this._setRoving(this._indexOf(this.focusDate), false);
  };

  Calendar.prototype._wireDay = function (btn, part) {
    var self = this;
    btn.addEventListener('click', function () { self.pick(part); });
  };

  Calendar.prototype._indexOf = function (part) {
    if (!part) return 0;
    for (var i = 0; i < this.dayParts.length; i++) {
      if (sameDay(this.dayParts[i], part)) return i;
    }
    return 0;
  };

  Calendar.prototype._setRoving = function (idx, moveFocus) {
    if (!this.days.length) return;
    idx = clamp(idx, 0, this.days.length - 1);
    for (var i = 0; i < this.days.length; i++) this.days[i].tabIndex = -1;
    this.days[idx].tabIndex = 0;
    this.focusDate = this.dayParts[idx];
    if (moveFocus) this.days[idx].focus();
  };

  /* ── month / year grids ───────────────────────────────────────────────── */

  Calendar.prototype._renderMonths = function () {
    var grid = this.el.gridMonth;
    var now = today();
    var i;

    grid.textContent = '';
    this.opts.length = 0;
    this.optParts.length = 0;

    for (i = 0; i < 12; i++) {
      var m = i + 1;
      var btn = el('button', 'tk-cal-opt', MONTHS[i]);
      btn.type = 'button';
      btn.tabIndex = -1;
      btn.setAttribute('aria-label', MONTHS[i] + ' ' + this.cursor.y);
      if (now.y === this.cursor.y && now.m === m) {
        btn.classList.add('is-current');
        btn.setAttribute('aria-current', 'date');
      }
      if (this.selected && this.selected.y === this.cursor.y &&
          this.selected.m === m) {
        btn.classList.add('is-selected');
        btn.setAttribute('aria-pressed', 'true');
      }
      this._wireMonth(btn, m);
      grid.appendChild(btn);
      this.opts.push(btn);
      this.optParts.push(m);
    }
  };

  Calendar.prototype._wireMonth = function (btn, m) {
    var self = this;
    btn.addEventListener('click', function () { self.pickMonth(m); });
  };

  Calendar.prototype._renderYears = function () {
    var grid = this.el.gridYear;
    var now = today();
    var i;

    grid.textContent = '';
    this.opts.length = 0;
    this.optParts.length = 0;

    for (i = 0; i < YEAR_SPAN; i++) {
      var year = this.yearBase + i;
      var btn = el('button', 'tk-cal-opt', String(year));
      btn.type = 'button';
      btn.tabIndex = -1;
      btn.setAttribute('aria-label', String(year));
      if (now.y === year) {
        btn.classList.add('is-current');
        btn.setAttribute('aria-current', 'date');
      }
      if (this.selected && this.selected.y === year) {
        btn.classList.add('is-selected');
        btn.setAttribute('aria-pressed', 'true');
      }
      this._wireYear(btn, year);
      grid.appendChild(btn);
      this.opts.push(btn);
      this.optParts.push(year);
    }
  };

  Calendar.prototype._wireYear = function (btn, year) {
    var self = this;
    btn.addEventListener('click', function () { self.pickYear(year); });
  };

  Calendar.prototype._optRoving = function (idx, moveFocus) {
    if (!this.opts.length) return;
    idx = clamp(idx, 0, this.opts.length - 1);
    for (var i = 0; i < this.opts.length; i++) this.opts[i].tabIndex = -1;
    this.opts[idx].tabIndex = 0;
    if (moveFocus) this.opts[idx].focus();
  };

  /* ── selection ────────────────────────────────────────────────────────── */

  Calendar.prototype.pick = function (part) {
    var meta = dayMetaHook ? dayMetaHook(toDate(part)) : null;
    if (meta && meta.disabled) return;

    if (part.y !== this.cursor.y || part.m !== this.cursor.m) {
      this.cursor = { y: part.y, m: part.m, d: part.d };
    }
    this._commit(part);
  };

  Calendar.prototype.pickMonth = function (m) {
    var sel = this.selected || today();
    var part = {
      y: this.cursor.y,
      m: m,
      d: Math.min(sel.d, daysInMonth(this.cursor.y, m))
    };

    if (this.mode === 'month') { this._commit(part); return; }

    this.cursor = { y: part.y, m: part.m, d: part.d };
    this.focusDate = part;
    this.setView('day', 0, 4);
  };

  Calendar.prototype.pickYear = function (y) {
    this.cursor.y = y;
    this.setView('month', 0, 4);
  };

  Calendar.prototype._commit = function (part) {
    var value = formatValue(part, this.mode);
    this.selected = part;

    if (String(this.input.value) !== value) {
      this.input.value = value;
      this.input.dispatchEvent(new Event('input', { bubbles: true }));
      this.input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    this.close(true);
  };

  /* ── keyboard ─────────────────────────────────────────────────────────── */

  Calendar.prototype._dayKey = function (e) {
    if (!this.days.length) return;
    var k = e.key;
    var cur = this.focusDate || this.dayParts[0];
    var w = toDate(cur).getDay();
    var next = null;
    var dir = 0;

    if (k === 'ArrowLeft') { next = shiftDays(cur, -1); dir = -1; }
    else if (k === 'ArrowRight') { next = shiftDays(cur, 1); dir = 1; }
    else if (k === 'ArrowUp') { next = shiftDays(cur, -7); }
    else if (k === 'ArrowDown') { next = shiftDays(cur, 7); }
    else if (k === 'Home') { next = shiftDays(cur, -w); dir = -1; }
    else if (k === 'End') { next = shiftDays(cur, 6 - w); dir = 1; }
    else if (k === 'PageUp') { next = shiftMonths(cur, -1); dir = -1; }
    else if (k === 'PageDown') { next = shiftMonths(cur, 1); dir = 1; }
    else return;

    e.preventDefault();

    if (next.y !== this.cursor.y || next.m !== this.cursor.m) {
      this.cursor = { y: next.y, m: next.m, d: next.d };
      this.focusDate = next;
      this.render(dir * 6, 0);
      this._setRoving(this._indexOf(next), true);
    } else {
      this._setRoving(this._indexOf(next), true);
    }
  };

  Calendar.prototype._optKey = function (e) {
    if (!this.opts.length) return;
    var k = e.key;
    var idx = 0;
    var i;

    for (i = 0; i < this.opts.length; i++) {
      if (this.opts[i].tabIndex === 0) { idx = i; break; }
    }

    if (k === 'ArrowLeft') idx -= 1;
    else if (k === 'ArrowRight') idx += 1;
    else if (k === 'ArrowUp') idx -= COLS;
    else if (k === 'ArrowDown') idx += COLS;
    else if (k === 'Home') idx = idx - (idx % COLS);
    else if (k === 'End') idx = idx - (idx % COLS) + (COLS - 1);
    else if (k === 'PageUp') { e.preventDefault(); this.step(-1); return; }
    else if (k === 'PageDown') { e.preventDefault(); this.step(1); return; }
    else return;

    e.preventDefault();
    this._optRoving(idx, true);
  };

  /* Move focus to whatever the active view considers current. */
  Calendar.prototype.focusActive = function () {
    if (this.view === 'day') {
      this._setRoving(this._indexOf(this.focusDate), true);
      return;
    }
    var target = this.view === 'month' ? this.cursor.m : this.cursor.y;
    var idx = -1;
    for (var i = 0; i < this.optParts.length; i++) {
      if (this.optParts[i] === target) { idx = i; break; }
    }
    this._optRoving(idx >= 0 ? idx : 0, true);
  };

  /* ── public API ───────────────────────────────────────────────────────── */

  function enhance(node) {
    if (!node) return null;
    if (node.__tkCal) return node.__tkCal;
    var mode = node.getAttribute('data-trackit-cal');
    if (mode !== 'date' && mode !== 'month') return null;
    var inst = new Calendar(node, mode);
    node.__tkCal = inst;
    return inst;
  }

  function init(root) {
    var scope = root || document;
    if (!scope || !scope.querySelectorAll) return;
    var list = scope.querySelectorAll('[data-trackit-cal]');
    for (var i = 0; i < list.length; i++) enhance(list[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { init(); });
  } else {
    init();
  }

  global.TrackITCalendar = {
    enhance: enhance,
    init: init,
    setDayMeta: function (fn) { dayMetaHook = typeof fn === 'function' ? fn : null; },
    parse: parseValue,
    format: formatValue,
    MONTHS: MONTHS.slice(),
    WEEKDAYS: DOW.slice()
  };
})(window);
