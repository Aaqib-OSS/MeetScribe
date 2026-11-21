const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const WhisperWorkerService = require('../src/services/whisper-worker.service');

// Any Python runs the fake worker; skip where there is none.
const python = ['python3', 'python'].find((command) => spawnSync(command, ['--version']).status === 0);
const script = path.join(__dirname, 'fixtures', 'slow_worker.py');

function worker(env = {}) {
  const service = new WhisperWorkerService();
  service.configure({ pythonPath: python, scriptPath: script, env: { ...process.env, ...env } });
  // Python on PATH is not a file path; the check only matters for real setups.
  service.isConfigured = () => true;
  service.requestTimeoutMs = 400;
  service.loadTimeoutMs = 15000;
  return service;
}

test('a line spoken while the model is still loading waits for it instead of killing the worker', { skip: !python }, async () => {
  const service = worker({ FAKE_LOAD_SECONDS: '1.5' });
  try {
    // What starting a recording does: warm up, and the first utterance right behind it.
    const [warm, line] = await Promise.all([
      service.warmup({ model: 'small' }),
      service.transcribe('synthetic.wav', { model: 'small' })
    ]);
    assert.equal(warm.ok, true);
    assert.equal(line.text, 'synthetic');
    assert.equal(service.loaded, true);
  } finally {
    service.close();
  }
});

test('the first line without a warmup also gets the loading time', { skip: !python }, async () => {
  const service = worker({ FAKE_LOAD_SECONDS: '1' });
  try {
    const line = await service.transcribe('synthetic.wav', {});
    assert.equal(line.text, 'synthetic');
  } finally {
    service.close();
  }
});

test('once loaded, a wedged worker is still cut off quickly', { skip: !python }, async () => {
  const service = worker({ FAKE_LOAD_SECONDS: '0.1', FAKE_TRANSCRIBE_SECONDS: '3' });
  try {
    await service.warmup({});
    await assert.rejects(service.transcribe('synthetic.wav', {}), /timed out after 400ms/);
    // Killed and reset: the next request may load again.
    assert.equal(service.loaded, false);
  } finally {
    service.close();
  }
});
