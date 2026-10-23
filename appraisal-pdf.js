/**
 * Official Performance Appraisal PDF builder (shared by the supervisor and
 * OJT dashboards).
 *
 * Method: the uploaded official form (Performance_Appraisal_All_Borders_Black.pdf)
 * is rendered as a background with pdf.js, then every value is overlaid at the
 * exact cell coordinates extracted from that template with jsPDF — the same
 * proven approach as the weekly-journal PDF.
 *
 * Coordinates below are in the template's own bottom-up point space
 * (page 612 x 1224); jsPDF uses top-down Y, converted via `jsY(pt) = 1224 - pt`.
 *
 * Rules honoured here:
 * - Values come ONLY from an authenticated, ownership-checked API record.
 * - Totals are whatever the server computed; this module never recalculates.
 * - A missing/unscored rating prints "—" (an incomplete evaluation is shown as
 *   incomplete — it never fabricates a grade).
 * - Empty info fields print blank; nothing is invented.
 * - The supervisor signature image is printed only when one was actually
 *   recorded at submit time.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AppraisalPDF = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const TEMPLATE_URL = 'Performance_Appraisal_All_Borders_Black.pdf';
  const PAGE_W = 612;
  const PAGE_H = 1224;

  let templateBackgroundCache = null;

  /** Bottom-up pt -> jsPDF top-down Y. */
  function jsY(pt) {
    return PAGE_H - pt;
  }

  // ── Template geometry (extracted from the official PDF) ──────────────────

  // Trainee-information cells: value baselines + value x/max width per field.
  const INFO_VALUE_ROWS = [
    {
      baseline: 1024.5,
      fields: [
        { key: 'lastName', x: 59.8, maxW: 159.3 },
        { key: 'firstName', x: 227.8, maxW: 243.7 },
        { key: 'mi', x: 480.2, maxW: 75.3 },
      ],
    },
    {
      baseline: 993.7,
      fields: [
        { key: 'stiCampus', x: 59.8, maxW: 159.3 },
        { key: 'program', x: 227.8, maxW: 117.6 },
        { key: 'yearLevel', x: 354.1, maxW: 117.4 },
        { key: 'section', x: 480.2, maxW: 75.3 },
      ],
    },
    {
      baseline: 963.2,
      fields: [
        { key: 'hostTrainingEstablishment', x: 59.8, maxW: 285.6 },
        { key: 'departmentAssigned', x: 354.1, maxW: 201.4 },
      ],
    },
    {
      baseline: 932.5,
      fields: [
        { key: 'ojtSupervisor', x: 59.8, maxW: 159.3 },
        { key: 'designation', x: 227.8, maxW: 117.6 },
        { key: 'evaluationPeriodLabel', x: 354.1, maxW: 117.4 },
        { key: 'totalHours', x: 480.2, maxW: 75.3 },
      ],
    },
  ];

  // The template ships with example values ("STI West Negros University",
  // "BSIT", "4th Year", "CICT", "Administrative Assistant") baked into these
  // cells; they are masked with white before our values are printed.
  const INFO_MASKS = [
    { x: 55.8, y: 988.5, w: 165.3, h: 15 },
    { x: 223.9, y: 988.5, w: 123.5, h: 15 },
    { x: 350.1, y: 988.5, w: 123.4, h: 15 },
    { x: 55.8, y: 957.7, w: 291.6, h: 15 },
    { x: 350.1, y: 957.7, w: 207.4, h: 15 },
    { x: 223.9, y: 927.2, w: 123.5, h: 15 },
  ];

  // Evaluation table: one entry per official indicator, in printed order.
  // `ratingBaseline` aligns with the printed row; `rowBottom` bounds remarks.
  const EVAL_ROWS = [
    { key: 'technical_1', ratingBaseline: 771.1, rowBottom: 752.2 },
    { key: 'technical_2', ratingBaseline: 727.4, rowBottom: 708.4 },
    { key: 'attitude_1', ratingBaseline: 665.9, rowBottom: 646.9 },
    { key: 'attitude_2', ratingBaseline: 621.9, rowBottom: 602.9 },
    { key: 'attitude_3', ratingBaseline: 578.1, rowBottom: 559.4 },
    { key: 'quality_1', ratingBaseline: 517.1, rowBottom: 497.9 },
    { key: 'quality_2', ratingBaseline: 479.9, rowBottom: 467.1 },
    { key: 'attendance_1', ratingBaseline: 431.6, rowBottom: 419.1 },
    { key: 'attendance_2', ratingBaseline: 400.8, rowBottom: 388.3 },
  ];

  // Category label rows (merged, full width) — the subtotal is printed at the
  // right end of each row, aligned with the printed category label baseline.
  const CATEGORY_ROWS = [
    { key: 'technical', baseline: 801.9 },
    { key: 'attitude', baseline: 696.6 },
    { key: 'quality', baseline: 547.9 },
    { key: 'attendance', baseline: 455.6 },
  ];

  const RATING_CENTER_X = 341.25; // centre of the printed RATING column
  const REMARKS_X = 371; // left edge of the printed REMARKS column
  const REMARKS_MAX_W = 183.2;
  const TOTAL_BASELINE = 372.1;

  // "Other Comments/Remarks" box (left box of the lower section).
  const COMMENTS = { x: 59.8, firstBaseline: 311, lineHeight: 9.5, maxW: 231.5, maxLines: 12 };

  // Rating-equivalent table rows (bottom-up y + height) for the earned-row box.
  const EQUIV_ROW_GEOMETRY = {
    Excellent: { y: 269.5, h: 18.5 },
    'Very Good': { y: 250.8, h: 18.2 },
    Satisfactory: { y: 231.8, h: 18.5 },
    Fair: { y: 213.1, h: 18.2 },
    Fail: { y: 194.6, h: 18 },
  };
  const EQUIV_BOX = { x: 303.1, w: 242.9 };

  // "Reviewed by:" signature cell: image box, printed name and date.
  const SIGNATURE = {
    imgX: 57, imgY: 116, imgW: 155, imgH: 34, // bottom-up 116..150
    nameX: 122, nameMaxW: 89.1, nameBaseline: 154.8,
    dateX: 219.8, dateMaxW: 76.3,
  };

  const EM_DASH = '\u2014';

  // ── Text helpers ─────────────────────────────────────────────────────────

  function fitLine(doc, text, maxWidth, fontSize, minSize) {
    const value = String(text == null ? '' : text);
    if (!value) return '';
    let size = fontSize;
    doc.setFontSize(size);
    if (doc.getTextWidth(value) <= maxWidth) return value;
    while (size > minSize && doc.getTextWidth(value) > maxWidth) {
      size -= 0.5;
      doc.setFontSize(size);
    }
    if (doc.getTextWidth(value) <= maxWidth) return value;
    let cut = value;
    while (cut.length > 1 && doc.getTextWidth(cut + '\u2026') > maxWidth) cut = cut.slice(0, -1);
    return cut + '\u2026';
  }

  function wrapLines(doc, text, maxWidth, maxLines) {
    const value = String(text == null ? '' : text);
    if (!value) return [];
    const lines = doc.splitTextToSize(value, maxWidth) || [];
    if (lines.length <= maxLines) return lines;
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last.length > 1 && doc.getTextWidth(last + '\u2026') > maxWidth) last = last.slice(0, -1);
    kept[maxLines - 1] = last + '\u2026';
    return kept;
  }

  function formatScore(score) {
    if (typeof score !== 'number' || Number.isNaN(score)) return EM_DASH;
    return Number.isInteger(score) ? String(score) : String(Math.round(score * 100) / 100);
  }

  function formatDate(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString('en-US');
  }

  /** Map-typed Mongoose subdocs arrive as plain objects over JSON; be lenient. */
  function plain(value) {
    if (!value) return {};
    if (typeof value.toJSON === 'function') return value.toJSON();
    return value;
  }

  // ── Background rendering ─────────────────────────────────────────────────

  async function loadTemplateBackground() {
    if (templateBackgroundCache) return templateBackgroundCache;
    const pdfjsLib = root.pdfjsLib;
    if (!pdfjsLib) throw new Error('PDF library is not loaded yet. Please try again in a moment.');
    if (pdfjsLib.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.mjs';
    }
    const response = await fetch(TEMPLATE_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error('Unable to load the appraisal form template.');
    const bytes = await response.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const page = await pdf.getPage(1);
    const scale = 2;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    templateBackgroundCache = canvas.toDataURL('image/png');
    return templateBackgroundCache;
  }

  // ── Overlay drawing ──────────────────────────────────────────────────────

  function drawInfo(doc, info) {
    doc.setFont('times', 'normal');
    doc.setTextColor(0, 0, 0);
    for (const row of INFO_VALUE_ROWS) {
      for (const field of row.fields) {
        const value = String(info[field.key] || '').trim();
        if (!value) continue; // empty fields print blank — never invented
        const text = fitLine(doc, value, field.maxW, 11, 7);
        doc.text(text, field.x, jsY(row.baseline));
      }
    }
  }

  function drawMaskedExamples(doc) {
    doc.setFillColor(255, 255, 255);
    for (const mask of INFO_MASKS) {
      doc.rect(mask.x, jsY(mask.y + mask.h), mask.w, mask.h, 'F');
    }
  }

  function drawRatings(doc, ratings) {
    doc.setFont('times', 'normal');
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(10);
    for (const row of EVAL_ROWS) {
      const entry = ratings[row.key] || {};
      const score = entry.score;
      const text = score === null || score === undefined ? EM_DASH : formatScore(score);
      doc.text(text, RATING_CENTER_X, jsY(row.ratingBaseline), { align: 'center' });

      // Per-indicator remark, wrapped inside the row's REMARKS cell.
      const remark = String(entry.remarks || '').trim();
      if (remark) {
        doc.setFontSize(8);
        const firstBaseline = row.ratingBaseline + 7;
        const maxLines = Math.max(1, Math.min(3,
          Math.floor((firstBaseline - (row.rowBottom + 3)) / 8.5) + 1));
        const lines = wrapLines(doc, remark, REMARKS_MAX_W, maxLines);
        lines.forEach((line, index) => {
          doc.text(line, REMARKS_X, jsY(firstBaseline - index * 8.5));
        });
        doc.setFontSize(10);
      }
    }
  }

  function drawSubtotals(doc, subtotals, categories) {
    doc.setFont('times', 'normal');
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(10);
    for (const row of CATEGORY_ROWS) {
      const category = categories.find((c) => c.key === row.key);
      const max = category ? category.max : '';
      const subtotal = subtotals ? subtotals[row.key] : null;
      const text = subtotal === null || subtotal === undefined
        ? EM_DASH
        : `${formatScore(subtotal)} / ${max}`;
      doc.text(text, 552, jsY(row.baseline), { align: 'right' });
    }
  }

  function drawTotal(doc, summary) {
    doc.setFont('times', 'bold');
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(11);
    const total = summary.isComplete && typeof summary.totalScore === 'number'
      ? formatScore(summary.totalScore)
      : EM_DASH;
    doc.text(total, RATING_CENTER_X, jsY(TOTAL_BASELINE), { align: 'center' });

    doc.setFont('times', 'normal');
    doc.setFontSize(10);
    const equivalent = summary.isComplete && summary.ratingEquivalent
      ? `Rating Equivalent: ${summary.ratingEquivalent}`
      : 'Rating Equivalent: ' + EM_DASH;
    doc.text(fitLine(doc, equivalent, REMARKS_MAX_W, 10, 7), REMARKS_X, jsY(TOTAL_BASELINE));
  }

  function drawComments(doc, remarks) {
    const text = String(remarks || '').trim();
    if (!text) return;
    doc.setFont('times', 'normal');
    doc.setTextColor(0, 0, 0);
    doc.setFontSize(9);
    const lines = wrapLines(doc, text, COMMENTS.maxW, COMMENTS.maxLines);
    lines.forEach((line, index) => {
      doc.text(line, COMMENTS.x, jsY(COMMENTS.firstBaseline - index * COMMENTS.lineHeight));
    });
  }

  function drawEquivalentHighlight(doc, ratingEquivalent) {
    const geometry = EQUIV_ROW_GEOMETRY[ratingEquivalent];
    if (!geometry) return; // incomplete evaluation highlights nothing
    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(1.4);
    doc.rect(EQUIV_BOX.x, jsY(geometry.y + geometry.h), EQUIV_BOX.w, geometry.h, 'S');
  }

  async function drawSignature(doc, signature, submittedAt) {
    const sig = signature || {};
    doc.setFont('times', 'normal');
    doc.setTextColor(0, 0, 0);

    // Printed reviewer name + submission date (facts, not a signature claim).
    if (sig.signedByName) {
      doc.setFontSize(10);
      doc.text(
        fitLine(doc, sig.signedByName, SIGNATURE.nameMaxW, 10, 7),
        SIGNATURE.nameX,
        jsY(SIGNATURE.nameBaseline)
      );
    }
    const dateText = formatDate(sig.signedAt || submittedAt);
    if (dateText) {
      doc.setFontSize(10);
      doc.text(
        fitLine(doc, dateText, SIGNATURE.dateMaxW, 10, 7),
        SIGNATURE.dateX,
        jsY(SIGNATURE.nameBaseline)
      );
    }

    // The signature image is printed ONLY when one was recorded at submit.
    if (!sig.dataUrl) return;
    let props;
    try {
      props = doc.getImageProperties(sig.dataUrl);
    } catch (error) {
      return; // unreadable image: leave the signature area blank
    }
    if (!props || !props.width || !props.height) return;
    const scale = Math.min(SIGNATURE.imgW / props.width, SIGNATURE.imgH / props.height);
    const w = props.width * scale;
    const h = props.height * scale;
    const x = SIGNATURE.imgX + (SIGNATURE.imgW - w) / 2;
    const y = jsY(SIGNATURE.imgY + SIGNATURE.imgH) + (SIGNATURE.imgH - h) / 2;
    const format = /^data:image\/jpe?g/i.test(sig.dataUrl) ? 'JPEG' : 'PNG';
    try {
      doc.addImage(sig.dataUrl, format, x, y, w, h);
    } catch (error) {
      // A corrupt signature must never break the whole PDF.
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Build the official PDF for a saved appraisal record.
   * @param {object} record   Full record from GET /api/appraisal/record/:id
   * @param {object} [options] { backgroundDataUrl, jsPDF, categories }
   * @returns {Promise<object>} jsPDF document
   */
  async function build(record, options = {}) {
    const JsPDF = options.jsPDF || (root.jspdf && root.jspdf.jsPDF);
    if (!JsPDF) throw new Error('PDF library is not loaded yet. Please try again in a moment.');
    // `backgroundDataUrl: undefined` renders the real template; any explicit
    // value (including null/false) is a test seam that skips pdf.js rendering.
    const background = options.backgroundDataUrl !== undefined
      ? options.backgroundDataUrl
      : await loadTemplateBackground();

    const info = plain(record.info);
    const ratings = plain(record.ratings);
    const subtotals = plain(record.subtotals);
    const summary = {
      isComplete: !!record.isComplete,
      totalScore: record.totalScore,
      ratingEquivalent: record.ratingEquivalent,
    };
    const categories = options.categories || [
      { key: 'technical', max: 30 },
      { key: 'attitude', max: 30 },
      { key: 'quality', max: 25 },
      { key: 'attendance', max: 15 },
    ];

    const doc = new JsPDF({ orientation: 'portrait', unit: 'pt', format: [PAGE_W, PAGE_H] });
    if (background) doc.addImage(background, 'PNG', 0, 0, PAGE_W, PAGE_H);

    drawMaskedExamples(doc);
    drawInfo(doc, info);
    drawRatings(doc, ratings);
    drawSubtotals(doc, subtotals, categories);
    drawTotal(doc, summary);
    drawComments(doc, record.overallRemarks);
    if (summary.isComplete) drawEquivalentHighlight(doc, summary.ratingEquivalent);
    await drawSignature(doc, record.supervisorSignature, record.submittedAt);

    return doc;
  }

  /** `Performance_Appraisal_LastName_FirstName_YYYY-MM.pdf` */
  function pdfFilename(record) {
    const info = plain(record.info);
    const safe = (value) => String(value || '').trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const last = safe(info.lastName) || 'Trainee';
    const first = safe(info.firstName) || 'Student';
    return `Performance_Appraisal_${last}_${first}_${record.period}.pdf`;
  }

  async function download(record, options) {
    const doc = await build(record, options);
    doc.save(pdfFilename(record));
  }

  return {
    build,
    download,
    pdfFilename,
    // Exposed for automated tests: draws a record onto a blank background.
    docFromRecord: build,
    _internals: { jsY, formatScore, fitLine, wrapLines, INFO_VALUE_ROWS, EVAL_ROWS },
  };
});
