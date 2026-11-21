const test = require('node:test');
const assert = require('node:assert/strict');

const { downloadCommand } = require('../src/services/model-store.service');

test('convert models run the converter with a private Hugging Face cache', () => {
  const paths = { modelDir: 'models', convertScript: 'convert_ct2.py', env: { PATH: 'x' } };

  const plain = downloadCommand({ repo: 'Acme/whisper-small', dir: 'd', convert: false, scratch: 's', paths });
  assert.equal(plain.args[0], '-c');
  assert.deepEqual(plain.args.slice(-2), ['Acme/whisper-small', 'models']);
  assert.equal(plain.env, paths.env);

  const converted = downloadCommand({ repo: 'Acme/whisper-large', dir: 'out', convert: true, scratch: 's', paths });
  assert.deepEqual(converted.args, ['-u', 'convert_ct2.py', 'Acme/whisper-large', 'out']);
  assert.equal(converted.env.HF_HUB_CACHE, 's');
  assert.equal(converted.env.PATH, 'x');
});

test('Hugging Face results keep only Whisper models faster-whisper can load or convert', () => {
  const { hubResults } = require('../src/services/model-store.service');
  const rows = hubResults([
    { id: 'Acme/whisper-small-acme-ct2', downloads: 5, tags: ['whisper', 'de'], siblings: [{ rfilename: 'model.bin' }, { rfilename: 'config.json' }] },
    { id: 'Acme/whisper-large-v3-acme', downloads: 9, tags: ['whisper', 'transformers'], siblings: [{ rfilename: 'model.safetensors' }] },
    { id: 'Acme/whisper-small-acme-onnx', tags: ['whisper', 'onnx'], siblings: [{ rfilename: 'onnx/encoder.onnx' }] },
    { id: 'Acme/wav2vec-acme', tags: ['wav2vec2'], siblings: [{ rfilename: 'model.safetensors' }] },
    { id: '../escape', tags: ['whisper'], siblings: [{ rfilename: 'model.bin' }] }
  ]);
  assert.deepEqual(rows.map((row) => [row.repo, row.format, row.category]), [
    ['Acme/whisper-small-acme-ct2', 'ct2', 'live'],
    ['Acme/whisper-large-v3-acme', 'transformers', 'final']
  ]);
  assert.deepEqual(rows[0].languages, ['de']);
});

test('the catalog has only the two lists: live and final pass', () => {
  const { CATALOG } = require('../src/services/model-store.service');
  for (const entry of CATALOG) assert.ok(['live', 'final'].includes(entry.category), entry.id);
});

test('every catalog model has the words a card needs to compare it', () => {
  const { CATALOG, describe } = require('../src/services/model-store.service');
  for (const entry of CATALOG) {
    const card = describe({ ...entry, custom: false });
    assert.ok(card.title && card.title !== entry.repo, entry.id + ' has a plain title');
    assert.ok(card.tech, entry.id + ' has a technical name');
    assert.ok(card.language, entry.id + ' has a language');
    assert.ok(card.ratings.speed >= 1 && card.ratings.speed <= 5, entry.id + ' speed rating');
    assert.ok(card.ratings.accuracy >= 1 && card.ratings.accuracy <= 5, entry.id + ' accuracy rating');
    assert.equal(card.url, 'https://huggingface.co/' + entry.repo);
  }
  const titles = CATALOG.map((entry) => entry.title);
  assert.equal(new Set(titles).size, titles.length, 'no two models share a title');
});

test('models added from Hugging Face show their own name and no invented ratings', () => {
  const { describe } = require('../src/services/model-store.service');
  const card = describe({ id: 'Acme/whisper-small-acme', repo: 'Acme/whisper-small-acme', speed: 0.2, custom: true });
  assert.equal(card.title, 'whisper-small-acme');
  assert.equal(card.tech, 'Acme/whisper-small-acme');
  assert.equal(card.ratings.speed, null);
  assert.equal(card.ratings.accuracy, null);
});

test('speed ratings follow the measured cost and links only go to valid repos', () => {
  const { speedRating, hfUrl } = require('../src/services/model-store.service');
  assert.deepEqual([0.08, 0.142, 0.248, 0.313, 0.7].map(speedRating), [5, 4, 3, 2, 1]);
  assert.equal(speedRating(0), null);
  assert.equal(hfUrl('Acme/whisper-tiny'), 'https://huggingface.co/Acme/whisper-tiny');
  assert.equal(hfUrl('../escape'), null);
  assert.equal(hfUrl('tiny'), null);
});

test('progress has a percentage only when the total is known', () => {
  const { progressPayload, repoBytes } = require('../src/services/model-store.service');
  assert.deepEqual(progressPayload({ id: 'a', repo: 'r', bytes: 50, total: 200 }),
    { id: 'a', repo: 'r', state: 'downloading', progress: 0.25, bytes: 50, total: 200 });
  // Never "done" before the process says so, never past the total.
  assert.equal(progressPayload({ id: 'a', repo: 'r', bytes: 500, total: 200 }).progress, 0.99);
  assert.equal(progressPayload({ id: 'a', repo: 'r', bytes: 500, total: 200 }).bytes, 200);
  const unknown = progressPayload({ id: 'a', repo: 'r', bytes: 70, total: 0 });
  assert.equal(unknown.progress, null);
  assert.equal(unknown.bytes, 70);
  assert.equal(repoBytes([{ type: 'file', size: 10 }, { type: 'directory', size: 99 }, { type: 'file', size: 5 }]), 15);
  assert.equal(repoBytes(null), 0);
});

test('cancel with nothing downloading says so', () => {
  const { ModelStore } = require('../src/services/model-store.service');
  const store = new ModelStore();
  assert.equal(store.cancel('tiny').ok, false);
});
