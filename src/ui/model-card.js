/**
 * What a model card says, in plain words. Settings and the Library both draw
 * their cards from this, so the two never describe a model differently; each
 * page only decides how it looks.
 *
 * Pure. Shared by Node (tests) and both pages: the Settings window loads this
 * file directly, the Library serves it as /model-card.js.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MeetScribeModelCard = api;
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value <= 0) return '';
    return value >= 1e9 ? (value / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(value / 1e6)) + ' MB';
  }

  /** 1-5 as filled and empty dots, e.g. 3 -> "●●●○○". Empty when unknown. */
  function dots(rating) {
    const value = Math.round(Number(rating));
    if (!(value >= 1 && value <= 5)) return '';
    return '●'.repeat(value) + '○'.repeat(5 - value);
  }

  /** "≈ 12 min per 1 h meeting", from the learned or prior estimate. */
  function minutesText(estimate) {
    if (!estimate || !(estimate.minutes > 0)) return '';
    const minutes = Math.max(1, Math.round(estimate.minutes));
    return '≈ ' + minutes + ' min per 1 h meeting';
  }

  /** Where the model is used, as words: "Live transcript", "Final pass". */
  function purpose(row) {
    return (row.category === 'live' ? 'live' : 'final') === 'live' ? 'Live transcript' : 'Final pass (after the meeting)';
  }

  /**
   * Download state as a label and an optional bar. `percent` is null for a
   * download of unknown size (the bar then just moves).
   */
  function progress(row) {
    if (!row.downloading) return null;
    const total = Number(row.total) || 0;
    const bytes = Number(row.bytesDone) || 0;
    const known = row.progress !== null && row.progress !== undefined && total > 0;
    const percent = known ? Math.round(Math.min(0.99, Number(row.progress) || 0) * 100) : null;
    let label = 'Downloading';
    if (known) label += ' ' + percent + '% · ' + formatBytes(bytes) + ' of ' + formatBytes(total);
    else if (bytes > 0) label += ' · ' + formatBytes(bytes) + ' so far';
    else label += '…';
    return { percent, label };
  }

  /** The status word on the right of a card. */
  function status(row) {
    if (row.downloading) return progress(row).label;
    if (row.downloaded) return '✓ On this PC · ' + formatBytes(row.bytes);
    // Picked for the live or final transcript but not on this PC: the one
    // state that stops a meeting from being transcribed, so it says so.
    if ((row.inUse || []).length) return 'Needed, not downloaded yet' + (row.sizeMb ? ' · ' + formatBytes(row.sizeMb * 1e6) : '');
    // A partial download resumes where it stopped.
    if (row.bytes > 0) return 'Incomplete · ' + formatBytes(row.bytes);
    return row.sizeMb ? formatBytes(row.sizeMb * 1e6) + ' download' : 'Not downloaded';
  }

  function card(row) {
    const ratings = row.ratings || {};
    return {
      title: row.title || row.label || row.id,
      tech: row.tech || row.repo || row.id,
      url: row.url || null,
      language: row.language || '',
      purpose: purpose(row),
      note: row.note || '',
      speed: dots(ratings.speed),
      accuracy: dots(ratings.accuracy),
      minutes: minutesText(row.estimate),
      status: status(row),
      progress: progress(row)
    };
  }

  return { card, dots, formatBytes, minutesText, progress, status, purpose };
});
