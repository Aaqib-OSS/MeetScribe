const test = require('node:test');
const assert = require('node:assert/strict');

const { card, dots, formatBytes, status } = require('../src/ui/model-card');

test('ratings read as five dots', () => {
  assert.equal(dots(3), '●●●○○');
  assert.equal(dots(5), '●●●●●');
  assert.equal(dots(null), '');
  assert.equal(dots(9), '');
});

test('a card says what the model is for, in words', () => {
  const view = card({
    id: 'acme-small', repo: 'Acme/whisper-small', title: 'Acme · Fast', tech: 'small (Acme fine-tune)',
    language: 'Acme only', category: 'live', ratings: { speed: 4, accuracy: 3 }, url: 'https://huggingface.co/Acme/whisper-small',
    estimate: { minutes: 8.6 }, sizeMb: 465, bytes: 0
  });
  assert.equal(view.title, 'Acme · Fast');
  assert.equal(view.tech, 'small (Acme fine-tune)');
  assert.equal(view.purpose, 'Live transcript');
  assert.equal(view.speed, '●●●●○');
  assert.equal(view.minutes, '≈ 9 min per 1 h meeting');
  assert.equal(view.status, '465 MB download');
  assert.equal(view.progress, null);
});

test('download status shows a percentage when the size is known, bytes otherwise', () => {
  const known = card({ id: 'x', downloading: true, progress: 0.42, bytesDone: 342e6, total: 815e6 });
  assert.equal(known.progress.percent, 42);
  assert.equal(known.status, 'Downloading 42% · 342 MB of 815 MB');

  const unknown = card({ id: 'x', downloading: true, progress: null, bytesDone: 1.2e9, total: 0 });
  assert.equal(unknown.progress.percent, null);
  assert.equal(unknown.status, 'Downloading · 1.2 GB so far');

  assert.equal(card({ id: 'x', downloading: true, progress: 0, bytesDone: 0, total: 0 }).status, 'Downloading…');
});

test('finished and partial downloads say so', () => {
  assert.equal(status({ downloaded: true, bytes: 1.62e9 }), '✓ On this PC · 1.6 GB');
  assert.equal(status({ bytes: 3e6 }), 'Incomplete · 3 MB');
  assert.equal(formatBytes(0), '');
});
