/**
 * TrackIT VerificationModal
 *
 * Shared confirmation -> loading -> success/error workflow that replaces the
 * browser's native confirm()/alert()/prompt() dialogs for irreversible actions
 * (journal signing, DTR verification, appraisal signing).
 *
 * The loading state is tied to the real request returned by `onConfirm`:
 *   - `onConfirm` returns a Promise -> modal shows the loading state until it
 *     settles (rejected / thrown value becomes the error message).
 *   - `onConfirm` returns synchronously -> no request to wait for, so the modal
 *     moves straight to the success state (never fakes a delay).
 *
 *   VerificationModal.open({
 *     type: 'journal' | 'dtr' | 'appraisal',
 *     title, subtitle, description, warning, confirmLabel,   // optional overrides
 *     summary: [{ label, value }],                           // verification summary
 *     list: { rows: [{ title, meta, status, tone }], more }, // bulk entry list
 *     loading: { title, text },
 *     success: { title, text, badge, doneLabel },
 *     successSummary: [{ label, value }],
 *     error: { title, text, retryLabel },
 *     onConfirm: async () => { ... },   // returns { warning } for partial success
 *     onSuccess: (result) => { ... },
 *     onCancel: () => { ... }
 *   });
 */

(function (global) {
  'use strict';

  var STATE = {
    CONFIRM: 'confirm',
    LOADING: 'loading',
    SUCCESS: 'success',
    ERROR: 'error'
  };

  var REQUEST_TIMEOUT_MS = 30000;
  var AUTO_CLOSE_MS = 1500;

  var ICONS = {
    shield:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      '<path d="M12 3l7.5 3v5.2c0 4.7-3.2 8.7-7.5 10.3C7.7 19.9 4.5 15.9 4.5 11.2V6L12 3z"/>' +
      '<path d="M8.8 12.2l2.3 2.3 4.1-4.4"/></svg>',
    check:
      '<svg class="vm-check" viewBox="0 0 52 52" fill="none" aria-hidden="true" focusable="false">' +
      '<circle class="vm-check__circle" cx="26" cy="26" r="23" stroke="currentColor" stroke-width="2.5"/>' +
      '<path class="vm-check__mark" d="M15.5 27l7.3 7.3L37 19.5" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    error:
      '<svg class="vm-error" viewBox="0 0 52 52" fill="none" aria-hidden="true" focusable="false">' +
      '<circle cx="26" cy="26" r="23" stroke="currentColor" stroke-width="2.5"/>' +
      '<path d="M26 15v14" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>' +
      '<path d="M26 36.5h.01" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/></svg>',
    warn:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      '<path d="M10.3 3.9L1.9 18a2 2 0 001.7 3h16.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/>' +
      '<path d="M12 9v4"/><path d="M12 17h.01"/></svg>'
  };

  var PRESETS = {
    journal: {
      title: 'Verify & Sign Journal',
      subtitle: 'Please review this action before continuing.',
      description:
        'This journal will be digitally signed and marked as verified. Once signed, this action cannot be undone.',
      warning:
        'Once verified, this record will be digitally signed and cannot be modified through the verification workflow.',
      confirmLabel: 'Verify & Sign',
      loading: {
        title: 'Verifying Journal...',
        text: 'Please wait while TrackIT processes the digital signature.'
      },
      success: {
        title: 'Verification Successful',
        text: 'The journal has been digitally signed and verified successfully.',
        badge: 'Journal Verified',
        doneLabel: 'Done'
      },
      error: {
        title: 'Verification Failed',
        text: 'TrackIT could not complete the verification. Please try again.',
        retryLabel: 'Try Again'
      }
    },

    dtr: {
      title: 'Verify DTR Entry',
      subtitle: 'Please review this action before continuing.',
      description:
        'This DTR entry will be marked as verified and recorded as an official attendance record. Once verified, this action cannot be undone.',
      warning:
        'Once verified, this record will be digitally signed and cannot be modified through the verification workflow.',
      confirmLabel: 'Verify DTR',
      loading: {
        title: 'Verifying DTR...',
        text: 'Please wait while TrackIT processes the attendance verification.'
      },
      success: {
        title: 'Verification Successful',
        text: 'The DTR entry has been verified successfully.',
        badge: 'DTR Verified',
        doneLabel: 'Done'
      },
      error: {
        title: 'Verification Failed',
        text: 'TrackIT could not complete the verification. Please try again.',
        retryLabel: 'Try Again'
      }
    },

    appraisal: {
      title: 'Sign Performance Appraisal',
      subtitle: 'Please review this action before continuing.',
      description:
        'This appraisal will be submitted and digitally signed. Once signed, this action cannot be undone.',
      warning:
        'Once signed, this appraisal is submitted as an official record and cannot be modified through the appraisal workflow.',
      confirmLabel: 'Sign & Submit',
      loading: {
        title: 'Signing Appraisal...',
        text: 'Please wait while TrackIT processes the digital signature.'
      },
      success: {
        title: 'Verification Successful',
        text: 'The appraisal has been submitted and digitally signed.',
        badge: 'Appraisal Signed',
        doneLabel: 'Done'
      },
      error: {
        title: 'Verification Failed',
        text: 'TrackIT could not complete the signing. Please try again.',
        retryLabel: 'Try Again'
      }
    }
  };

  // ── state ──────────────────────────────────────────────────────────────────
  var overlay = null;
  var panelHost = null;
  var liveRegion = null;
  var cfg = null;
  var state = STATE.CONFIRM;
  var stateDetail = '';
  var lastResult = null;
  var succeeded = false;
  var settled = false;
  var lastFocused = null;
  var prevBodyOverflow = '';
  var autoCloseTimer = null;
  var requestTimer = null;

  // ── helpers ────────────────────────────────────────────────────────────────
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function copy(source, target) {
    Object.keys(source || {}).forEach(function (key) {
      target[key] = source[key];
    });
    return target;
  }

  function mergeConfig(options) {
    var preset = PRESETS[options.type] || PRESETS.journal;
    var merged = copy(preset, {});
    copy(options, merged);
    merged.loading = copy(preset.loading, {});
    copy(options.loading, merged.loading);
    merged.success = copy(preset.success, {});
    copy(options.success, merged.success);
    merged.error = copy(preset.error, {});
    copy(options.error, merged.error);
    return merged;
  }

  function canDismiss(currentState) {
    return currentState !== STATE.LOADING;
  }

  function stateAnnouncement() {
    if (state === STATE.LOADING) return cfg.loading.title + ' ' + cfg.loading.text;
    if (state === STATE.SUCCESS) return cfg.success.title + '. ' + cfg.success.text;
    if (state === STATE.ERROR) {
      return cfg.error.title + '. ' + cfg.error.text + (stateDetail ? ' ' + stateDetail : '');
    }
    return cfg.title + '. ' + (cfg.subtitle || '') + ' ' + (cfg.description || '');
  }

  // ── markup ─────────────────────────────────────────────────────────────────
  function summaryRowsDl(rows) {
    if (!rows || !rows.length) return '';
    var html = '<dl class="vm__summary">';
    rows.forEach(function (row) {
      html +=
        '<div class="vm__row"><dt>' +
        esc(row.label) +
        '</dt><dd>' +
        esc(row.value) +
        '</dd></div>';
    });
    return html + '</dl>';
  }

  function listMarkup(list) {
    if (!list || !list.rows || !list.rows.length) return '';
    var html = '<ul class="vm__list">';
    list.rows.forEach(function (row) {
      html +=
        '<li class="vm__item">' +
        '<div class="vm__item-main">' +
        '<p class="vm__item-title">' +
        esc(row.title) +
        '</p>' +
        (row.meta ? '<p class="vm__item-meta">' + esc(row.meta) + '</p>' : '') +
        '</div>' +
        (row.status
          ? '<span class="vm__pill vm__pill--' + esc(row.tone || 'neutral') + '">' + esc(row.status) + '</span>'
          : '') +
        '</li>';
    });
    html += '</ul>';
    if (list.more > 0) {
      html += '<p class="vm__more">+ ' + list.more + ' more entr' + (list.more === 1 ? 'y' : 'ies') + '</p>';
    }
    return html;
  }

  function infoPanel(label, rows) {
    if (!rows || !rows.length) return '';
    return (
      '<div class="vm__info"><p class="vm__info-label">' +
      esc(label || 'Verification summary') +
      '</p>' +
      summaryRowsDl(rows) +
      '</div>'
    );
  }

  function infoMarkup(c) {
    var rows = c.summary || [];
    var list = c.list;
    var hasList = list && list.rows && list.rows.length;
    if (!rows.length && !hasList) return '';
    return (
      '<div class="vm__info"><p class="vm__info-label">Verification summary</p>' +
      summaryRowsDl(rows) +
      (hasList ? listMarkup(list) : '') +
      '</div>'
    );
  }

  function warnMarkup(c) {
    if (!c.warning) return '';
    return (
      '<div class="vm__warn" id="vm-warn">' +
      '<span class="vm__warn-icon">' + ICONS.warn + '</span>' +
      '<div class="vm__warn-body">' +
      '<p class="vm__warn-title">This action cannot be undone.</p>' +
      '<p class="vm__warn-text">' + esc(c.warning) + '</p>' +
      '</div></div>'
    );
  }

  function footMarkup(c, buttons) {
    var html = '<div class="vm__foot">';
    buttons.forEach(function (btn) {
      html +=
        '<button type="button" class="vm__btn vm__btn--' +
        btn.variant +
        '" data-vm-action="' +
        btn.action +
        '"' +
        (btn.disabled ? ' disabled' : '') +
        '>' +
        esc(btn.label) +
        '</button>';
    });
    return html + '</div>';
  }

  function confirmMarkup(c) {
    return (
      '<div class="vm__scroll">' +
      '<div class="vm__head">' +
      '<span class="vm__badge">' + ICONS.shield + '</span>' +
      '<h2 class="vm__title" id="vm-title">' + esc(c.title) + '</h2>' +
      (c.subtitle ? '<p class="vm__subtitle" id="vm-subtitle">' + esc(c.subtitle) + '</p>' : '') +
      '</div>' +
      '<p class="vm__desc" id="vm-desc">' + esc(c.description) + '</p>' +
      infoMarkup(c) +
      warnMarkup(c) +
      '</div>' +
      footMarkup(c, [
        { action: 'cancel', label: 'Cancel', variant: 'ghost' },
        { action: 'confirm', label: c.confirmLabel, variant: 'primary' }
      ])
    );
  }

  function loadingMarkup(c) {
    return (
      '<div class="vm__scroll vm__scroll--center">' +
      '<div class="vm__state">' +
      '<span class="vm__spinner" aria-hidden="true"></span>' +
      '<h2 class="vm__title" id="vm-title">' + esc(c.loading.title) + '</h2>' +
      '<p class="vm__desc" id="vm-loading-text">' + esc(c.loading.text) + '</p>' +
      '</div></div>' +
      footMarkup(c, [
        { action: 'cancel', label: 'Cancel', variant: 'ghost', disabled: true },
        { action: 'confirm', label: c.confirmLabel, variant: 'primary', disabled: true }
      ])
    );
  }

  function successMarkup(c, context) {
    var result = context && context.result;
    var partial = result && result.warning;
    var rows =
      typeof c.successSummary === 'function'
        ? c.successSummary(result)
        : c.successSummary || c.summary || [];
    var info = infoPanel('Confirmation summary', rows);
    var body =
      '<div class="vm__scroll vm__scroll--center">' +
      '<div class="vm__state">' +
      '<span class="vm__state-icon vm__state-icon--ok">' + ICONS.check + '</span>' +
      '<h2 class="vm__title" id="vm-title">' + esc(c.success.title) + '</h2>' +
      '<p class="vm__desc" id="vm-success-text">' + esc(c.success.text) + '</p>' +
      '</div>' +
      (c.success.badge
        ? '<p class="vm__ok"><span class="vm__ok-mark" aria-hidden="true">&#10003;</span>' + esc(c.success.badge) + '</p>'
        : '') +
      info +
      (partial
        ? '<div class="vm__warn vm__warn--partial" id="vm-warning">' +
          '<span class="vm__warn-icon">' + ICONS.warn + '</span>' +
          '<div class="vm__warn-body"><p class="vm__warn-text">' + esc(partial) + '</p></div></div>'
        : '') +
      '</div>';

    var buttons = partial
      ? [
          { action: 'cancel', label: c.success.doneLabel || 'Done', variant: 'ghost' },
          { action: 'confirm', label: c.error.retryLabel || 'Try Again', variant: 'primary' }
        ]
      : [{ action: 'cancel', label: c.success.doneLabel || 'Done', variant: 'primary' }];

    return body + footMarkup(c, buttons);
  }

  function errorMarkup(c, context) {
    var detail = context && context.detail ? context.detail : '';
    if (detail === c.error.text) detail = '';
    return (
      '<div class="vm__scroll vm__scroll--center">' +
      '<div class="vm__state">' +
      '<span class="vm__state-icon vm__state-icon--err">' + ICONS.error + '</span>' +
      '<h2 class="vm__title" id="vm-title">' + esc(c.error.title) + '</h2>' +
      '<p class="vm__desc" id="vm-error-text">' + esc(c.error.text) + '</p>' +
      (detail ? '<p class="vm__detail" id="vm-error-detail">' + esc(detail) + '</p>' : '') +
      '</div></div>' +
      footMarkup(c, [
        { action: 'cancel', label: 'Cancel', variant: 'ghost' },
        { action: 'confirm', label: c.error.retryLabel || 'Try Again', variant: 'primary' }
      ])
    );
  }

  function renderMarkup(currentState, config, context) {
    if (currentState === STATE.LOADING) return loadingMarkup(config);
    if (currentState === STATE.SUCCESS) return successMarkup(config, context);
    if (currentState === STATE.ERROR) return errorMarkup(config, context);
    return confirmMarkup(config);
  }

  function describedBy(currentState, config, context) {
    var result = context && context.result;
    var detail = context && context.detail;
    if (currentState === STATE.LOADING) return 'vm-title vm-loading-text';
    if (currentState === STATE.SUCCESS) {
      return result && result.warning ? 'vm-title vm-success-text vm-warning' : 'vm-title vm-success-text';
    }
    if (currentState === STATE.ERROR) {
      return detail && detail !== config.error.text
        ? 'vm-title vm-error-text vm-error-detail'
        : 'vm-title vm-error-text';
    }
    return config.warning ? 'vm-title vm-desc vm-warn' : 'vm-title vm-desc';
  }

  // ── dom ────────────────────────────────────────────────────────────────────
  function ensureRoot() {
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.className = 'vm';
    overlay.id = 'verification-modal-root';

    panelHost = document.createElement('div');
    panelHost.className = 'vm__panel';

    liveRegion = document.createElement('p');
    liveRegion.className = 'vm__sr';
    liveRegion.setAttribute('role', 'status');
    liveRegion.setAttribute('aria-live', 'polite');

    overlay.appendChild(panelHost);
    overlay.appendChild(liveRegion);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', function (event) {
      var target = event.target;
      var actionEl = target && target.closest ? target.closest('[data-vm-action]') : null;
      if (actionEl) {
        handleAction(actionEl.getAttribute('data-vm-action'));
        return;
      }
      if (target === overlay && canDismiss(state)) attemptClose();
    });

    return overlay;
  }

  function paint() {
    if (!overlay) return;
    var context = { result: lastResult, detail: stateDetail };
    panelHost.innerHTML = renderMarkup(state, cfg, context);
    panelHost.setAttribute('role', 'dialog');
    panelHost.setAttribute('aria-modal', 'true');
    panelHost.setAttribute('aria-labelledby', 'vm-title');
    panelHost.setAttribute('aria-describedby', describedBy(state, cfg, context));
    panelHost.setAttribute('tabindex', '-1');
    if (state === STATE.LOADING) panelHost.setAttribute('aria-busy', 'true');
    else panelHost.removeAttribute('aria-busy');

    if (liveRegion) liveRegion.textContent = stateAnnouncement();

    var active = document.activeElement;
    if (!active || !overlay.contains(active)) {
      panelHost.focus({ preventScroll: true });
    }
  }

  function focusables() {
    if (!panelHost) return [];
    var nodes = panelHost.querySelectorAll('button:not([disabled])');
    return Array.prototype.slice.call(nodes);
  }

  function onKeydown(event) {
    if (!overlay) return;

    if (event.key === 'Escape' || event.key === 'Esc') {
      if (!canDismiss(state)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      attemptClose();
      return;
    }

    if (event.key !== 'Tab') return;

    var items = focusables();
    if (!items.length) {
      event.preventDefault();
      panelHost.focus({ preventScroll: true });
      return;
    }

    var first = items[0];
    var last = items[items.length - 1];
    var active = document.activeElement;
    var inside = active && panelHost.contains(active);

    if (event.shiftKey) {
      if (!inside || active === first) {
        event.preventDefault();
        last.focus();
      }
    } else if (!inside || active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // ── transitions ────────────────────────────────────────────────────────────
  function clearTimers() {
    if (autoCloseTimer) {
      clearTimeout(autoCloseTimer);
      autoCloseTimer = null;
    }
    if (requestTimer) {
      clearTimeout(requestTimer);
      requestTimer = null;
    }
  }

  function armRequestTimeout() {
    settled = false;
    if (requestTimer) clearTimeout(requestTimer);
    requestTimer = setTimeout(function () {
      if (state !== STATE.LOADING) return;
      settled = true;
      showError(new Error('The request timed out. Please check your connection and try again.'));
    }, REQUEST_TIMEOUT_MS);
  }

  function scheduleAutoClose() {
    if (lastResult && lastResult.warning) return;
    if (autoCloseTimer) clearTimeout(autoCloseTimer);
    autoCloseTimer = setTimeout(function () {
      attemptClose();
    }, AUTO_CLOSE_MS);
  }

  function transition(nextState) {
    state = nextState;
    paint();
  }

  function showSuccess(result) {
    settled = true;
    if (requestTimer) {
      clearTimeout(requestTimer);
      requestTimer = null;
    }
    lastResult = result || null;
    succeeded = true;
    transition(STATE.SUCCESS);
    if (typeof cfg.onSuccess === 'function') {
      try {
        cfg.onSuccess(result);
      } catch (error) {
        console.error('VerificationModal onSuccess failed:', error);
      }
    }
    scheduleAutoClose();
  }

  function showError(error) {
    settled = true;
    if (requestTimer) {
      clearTimeout(requestTimer);
      requestTimer = null;
    }
    var message = '';
    if (error) {
      if (typeof error === 'string') message = error;
      else if (error.message) message = error.message;
    }
    stateDetail = message || '';
    transition(STATE.ERROR);
    if (autoCloseTimer) {
      clearTimeout(autoCloseTimer);
      autoCloseTimer = null;
    }
  }

  function runConfirm() {
    if (state === STATE.LOADING) return;
    // A partial success keeps the modal on screen so "Try Again" can re-run it.
    if (state === STATE.SUCCESS && !(lastResult && lastResult.warning)) return;

    clearTimers();
    if (state === STATE.SUCCESS) succeeded = false;

    var outcome;
    try {
      outcome = typeof cfg.onConfirm === 'function' ? cfg.onConfirm() : undefined;
    } catch (error) {
      showError(error);
      return;
    }

    if (outcome && typeof outcome.then === 'function') {
      transition(STATE.LOADING);
      armRequestTimeout();
      outcome.then(
        function (result) {
          if (settled) return;
          showSuccess(result);
        },
        function (error) {
          if (settled) return;
          showError(error);
        }
      );
      return;
    }

    // No request to wait for: never fake a delay, go straight to the result.
    showSuccess(outcome);
  }

  function handleAction(action) {
    if (action === 'confirm') {
      if (state === STATE.LOADING) return;
      if (state === STATE.SUCCESS && !(lastResult && lastResult.warning)) return;
      runConfirm();
      return;
    }
    if (action === 'cancel') attemptClose();
  }

  function attemptClose() {
    if (!overlay || !canDismiss(state)) return;
    close();
  }

  function close() {
    if (!overlay) return;

    var runCancel = !succeeded && cfg && typeof cfg.onCancel === 'function' ? cfg.onCancel : null;
    var restoreTo = lastFocused;

    clearTimers();
    document.removeEventListener('keydown', onKeydown, true);
    document.body.style.overflow = prevBodyOverflow;

    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);

    overlay = null;
    panelHost = null;
    liveRegion = null;
    cfg = null;
    lastResult = null;
    succeeded = false;
    settled = false;
    lastFocused = null;
    state = STATE.CONFIRM;
    stateDetail = '';

    if (restoreTo && document.contains(restoreTo) && typeof restoreTo.focus === 'function') {
      try {
        restoreTo.focus({ preventScroll: true });
      } catch (error) {
        /* element may no longer be focusable */
      }
    }

    if (runCancel) {
      try {
        runCancel();
      } catch (error) {
        console.error('VerificationModal onCancel failed:', error);
      }
    }
  }

  // ── public api ─────────────────────────────────────────────────────────────
  function open(options) {
    options = options || {};
    if (overlay) close();

    cfg = mergeConfig(options);
    state = STATE.CONFIRM;
    stateDetail = '';
    lastResult = null;
    succeeded = false;
    settled = false;
    lastFocused = document.activeElement;
    prevBodyOverflow = document.body.style.overflow;

    ensureRoot();
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeydown, true);

    paint();

    if (typeof options.onOpen === 'function') options.onOpen();
    return cfg;
  }

  var api = {
    open: open,
    close: close,
    isOpen: function () {
      return !!overlay;
    },
    state: function () {
      return state;
    },
    presets: PRESETS,
    __internals: {
      STATE: STATE,
      mergeConfig: mergeConfig,
      renderMarkup: renderMarkup,
      canDismiss: canDismiss,
      esc: esc,
      describedBy: describedBy
    }
  };

  global.VerificationModal = api;
})(typeof window !== 'undefined' ? window : globalThis);
