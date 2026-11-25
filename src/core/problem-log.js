/**
 * The warnings MeetScribe has shown, kept so they can be read in full and
 * copied (Settings > Problems). Pure: the caller does the reading and writing.
 *
 * Copied text tends to end up in chats and bug reports, so local paths and
 * meeting folder names are replaced before a message is stored.
 */

const MAX_PROBLEMS = 100;
// The same warning again within this time raises the count of the first one.
const REPEAT_MS = 10 * 60 * 1000;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A path as a pattern: either slash, any case. */
function pathPattern(value) {
  return String(value).replace(/[\\/]+$/, '').split(/[\\/]+/).map(escapeRegExp).join('[\\\\/]+');
}

// File names MeetScribe itself gives; safe to keep, and useful in a report.
const KNOWN_FILE = /[\\/]((?:mic|system|import|transcript|events|meta|timeline|glossary|corrections|meeting)(?:\.[a-z]+)+)['")\s.]*$/i;

/**
 * Replace the transcript folder and the home folder. Everything after the
 * transcript folder goes, to the end of the line: folder names may hold spaces
 * and quotes, so there is no telling where a meeting's name stops.
 */
function redact(message, { transcriptRoot = '', home = '' } = {}) {
  let text = String(message === undefined || message === null ? '' : message);
  if (transcriptRoot) {
    text = text.replace(new RegExp(pathPattern(transcriptRoot) + '([^\\r\\n]*)', 'gi'), (_match, rest) => {
      const file = KNOWN_FILE.exec(rest);
      return '<transcripts>' + (file ? '/<meeting>/' + file[1] : '');
    });
  }
  if (home) text = text.replace(new RegExp(pathPattern(home), 'gi'), '~');
  return text;
}

/** Add a message, newest first; returns a new list. */
function add(list, message, at) {
  const latest = list[0];
  if (latest && latest.message === message && at - latest.lastAt < REPEAT_MS) {
    return [{ ...latest, lastAt: at, count: latest.count + 1 }, ...list.slice(1)];
  }
  return [{ message, at, lastAt: at, count: 1 }, ...list].slice(0, MAX_PROBLEMS);
}

/** What a stored file holds, with anything malformed dropped. */
function normalize(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry.message === 'string' && Number.isFinite(entry.at))
    .map((entry) => ({
      message: entry.message,
      at: entry.at,
      lastAt: Number.isFinite(entry.lastAt) ? entry.lastAt : entry.at,
      count: Number.isInteger(entry.count) && entry.count > 0 ? entry.count : 1
    }))
    .slice(0, MAX_PROBLEMS);
}

const pad = (value) => String(value).padStart(2, '0');
function stamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Plain text for the clipboard. */
function toText(list, header = '') {
  const lines = list.map((entry) => `[${stamp(entry.lastAt)}]${entry.count > 1 ? ` (${entry.count}x)` : ''} ${entry.message}`);
  return [header, ...(lines.length ? lines : ['No problems.'])].filter(Boolean).join('\n');
}

module.exports = { add, normalize, redact, toText, MAX_PROBLEMS };
