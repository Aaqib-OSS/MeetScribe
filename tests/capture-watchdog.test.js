const test = require('node:test');
const assert = require('node:assert/strict');

const { CaptureWatchdog } = require('../src/core/capture-watchdog');

test('audio that keeps arriving is never a stall', () => {
  const dog = new CaptureWatchdog({ stallMs: 8000 });
  dog.start(0);
  for (let t = 100; t <= 60000; t += 100) {
    dog.mark(t);
    if (t % 3000 === 0) assert.equal(dog.check(t), false);
  }
});

test('a capture that never delivers is reported on the second late check', () => {
  const dog = new CaptureWatchdog({ stallMs: 8000 });
  dog.start(0);
  assert.equal(dog.check(6000), false);
  assert.equal(dog.check(9000), false);
  assert.equal(dog.check(12000), true);
});

test('waking from sleep is not a stall when audio resumes', () => {
  const dog = new CaptureWatchdog({ stallMs: 8000 });
  dog.start(0);
  assert.equal(dog.check(3600000), false);
  dog.mark(3601000);
  assert.equal(dog.check(3603000), false);
});

test('nothing is reported when not recording', () => {
  const dog = new CaptureWatchdog({ stallMs: 8000 });
  assert.equal(dog.check(99999), false);
  dog.start(0);
  dog.stop();
  dog.mark(10);
  assert.equal(dog.check(99999), false);
  assert.equal(dog.check(199999), false);
});
