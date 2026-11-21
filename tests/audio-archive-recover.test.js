const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const archive = require('../src/services/audio-archive.service');

/** A WAV as the recorder writes it before a clean stop: sizes still zero. */
function unpatchedWav(file, dataBytes) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  fs.writeFileSync(file, Buffer.concat([header, Buffer.alloc(dataBytes)]));
}

function meetingFolder() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'meetscribe-recover-'));
  fs.mkdirSync(path.join(folder, 'audio'));
  return folder;
}

test('a recording cut off by a crash is described from the files on disk', () => {
  const folder = meetingFolder();
  const audio = path.join(folder, 'audio');
  unpatchedWav(path.join(audio, 'system.wav'), 32000 * 3);
  unpatchedWav(path.join(audio, 'mic.wav'), 32000 * 2);
  fs.writeFileSync(path.join(audio, 'timeline.jsonl'), [
    { event: 'start', t: 1000 },
    { event: 'open', stream: 'system', t: 1100 },
    { event: 'open', stream: 'mic', t: 1200 },
    { event: 'mark', stream: 'system', t: 4000, bytes: 96000 }
  ].map((line) => JSON.stringify(line)).join('\n'));

  const meta = archive.recover(folder, { mic: 'Me' });
  assert.equal(meta.interrupted, true);
  assert.equal(meta.startedAt, 1000);
  const byStream = Object.fromEntries(meta.streams.map((entry) => [entry.stream, entry]));
  assert.equal(byStream.system.durationMs, 3000);
  assert.equal(byStream.mic.durationMs, 2000);
  assert.equal(byStream.mic.startedAt, 1200);
  assert.equal(byStream.mic.label, 'Me');
  // The header now carries the real length.
  assert.equal(fs.readFileSync(path.join(audio, 'system.wav')).readUInt32LE(40), 96000);
  assert.ok(fs.existsSync(path.join(audio, 'meta.json')));
  fs.rmSync(folder, { recursive: true, force: true });
});

test('a cleanly stopped recording is left alone, and an empty one gives nothing', () => {
  const folder = meetingFolder();
  fs.writeFileSync(path.join(folder, 'audio', 'meta.json'), JSON.stringify({ version: 1, streams: [] }));
  assert.equal(archive.recover(folder), null);
  const empty = meetingFolder();
  assert.equal(archive.recover(empty), null);
  fs.rmSync(folder, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
});
