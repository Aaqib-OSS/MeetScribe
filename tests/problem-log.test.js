const test = require('node:test');
const assert = require('node:assert/strict');

const problemLog = require('../src/core/problem-log');

test('newest first, capped, and a repeat only raises the count', () => {
  let list = [];
  list = problemLog.add(list, 'A', 1000);
  list = problemLog.add(list, 'A', 2000);
  list = problemLog.add(list, 'B', 3000);
  assert.deepEqual(list.map((entry) => [entry.message, entry.count]), [['B', 1], ['A', 2]]);
  assert.equal(list[1].at, 1000);
  assert.equal(list[1].lastAt, 2000);
  list = problemLog.add(list, 'B', 3000 + 60 * 60 * 1000);
  assert.equal(list.length, 3);
  for (let i = 0; i < 300; i++) list = problemLog.add(list, 'm' + i, i);
  assert.equal(list.length, problemLog.MAX_PROBLEMS);
});

test('meeting names and the home folder are not stored', () => {
  const options = { transcriptRoot: 'D:\\Rec\\Meetings', home: 'C:\\Users\\sam' };
  assert.equal(
    problemLog.redact("ENOENT: open 'D:\\Rec\\Meetings\\Acme sync_2026-01-02_10-00\\audio\\mic.wav'", options),
    "ENOENT: open '<transcripts>/<meeting>/mic.wav"
  );
  assert.equal(problemLog.redact("EACCES 'd:/rec/meetings'", options), "EACCES '<transcripts>");
  assert.equal(
    problemLog.redact("Could not start: open 'D:\\Rec\\Meetings\\Acme sync\\audio\\mic.wav'.", options),
    "Could not start: open '<transcripts>/<meeting>/mic.wav"
  );
  // Moved into a group folder, with a quote in the name.
  const nested = problemLog.redact("EPERM 'D:\\Rec\\Meetings\\Acme\\Sam's call\\notes.txt' while saving", options);
  assert.equal(nested, "EPERM '<transcripts>");
  assert.equal(problemLog.redact('at c:/users/sam/AppData/x', options), 'at ~/AppData/x');
  assert.equal(problemLog.redact('plain', {}), 'plain');
  assert.equal(problemLog.redact(undefined, options), '');
});

test('a damaged file gives an empty list, odd entries are dropped', () => {
  assert.deepEqual(problemLog.normalize({}), []);
  assert.deepEqual(problemLog.normalize([null, { message: 1 }, { message: 'x', at: 5 }]), [
    { message: 'x', at: 5, lastAt: 5, count: 1 }
  ]);
});

test('the copied text has the header, time and count', () => {
  const list = problemLog.add(problemLog.add([], 'Broken', 0), 'Broken', 1000);
  const text = problemLog.toText(list, 'MeetScribe 1.0.0');
  assert.match(text, /^MeetScribe 1\.0\.0\n\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\] \(2x\) Broken$/);
  assert.equal(problemLog.toText([], 'H'), 'H\nNo problems.');
});
