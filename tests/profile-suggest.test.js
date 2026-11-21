const test = require('node:test');
const assert = require('node:assert/strict');

const { suggest, answersFor, LANGUAGES } = require('../src/core/profile-suggest');
const { CATALOG } = require('../src/services/model-store.service');
const profiles = require('../src/core/profiles');

const catalogIds = new Set(CATALOG.map((entry) => entry.id));

test('every answer leads to models that are in the catalog and fit their role', () => {
  for (const { value: language } of LANGUAGES) {
    for (const preference of ['speed', 'balanced', 'quality']) {
      const values = suggest({ language, preference });
      const live = CATALOG.find((entry) => entry.id === values.whisperModel);
      const final = CATALOG.find((entry) => entry.id === values.offlineModel);
      assert.ok(live && live.roles.includes('live'), `${language}/${preference} live ${values.whisperModel}`);
      assert.ok(final && final.roles.includes('final'), `${language}/${preference} final ${values.offlineModel}`);
      assert.ok(catalogIds.has(values.whisperModel) && catalogIds.has(values.offlineModel));
    }
  }
});

test('plain answers become a profile', () => {
  assert.deepEqual(suggest({ language: 'en', live: true, final: true, preference: 'balanced' }), {
    whisperLanguage: 'en', liveTranscription: true, whisperModel: 'small.en', offlinePassEnabled: true, offlineModel: 'large-v3-turbo'
  });
  const tunisian = suggest({ language: 'tn', live: false, final: true });
  assert.equal(tunisian.whisperLanguage, 'ar');
  assert.equal(tunisian.liveTranscription, false);
  assert.equal(tunisian.offlineModel, 'medyas/FarukSTT');
  assert.equal(suggest({ language: 'de', preference: 'quality' }).offlineModel, 'tnfru/whisper-large-v3-german-ct2');
  assert.equal(suggest({ language: 'xx' }).whisperLanguage, 'auto');
  assert.throws(() => suggest({ live: false, final: false }), /at least one/);
});

test('the built-in profiles read back as the answers that make them', () => {
  for (const profile of profiles.BUILTIN) {
    const answers = answersFor(profile.values);
    const made = suggest({ ...answers, live: true, final: true });
    assert.equal(made.offlineModel, profile.values.offlineModel, profile.id);
  }
});

test('a profile shows which of its values the current settings changed', () => {
  const german = profiles.getProfile('german', {}, {});
  assert.deepEqual(profiles.changedKeys(german, { ...german.values }), []);
  assert.deepEqual(profiles.changedKeys(german, { ...german.values, whisperLanguage: 'en', windowGap: 3 }), ['whisperLanguage']);
  assert.deepEqual(profiles.changedKeys(null, {}), []);
  const none = profiles.listProfiles({}, { whisperModel: 'small', glossary: '' })[0];
  assert.deepEqual(profiles.changedKeys(none, { whisperModel: 'small', glossary: 'Acme', glossarySet: [] }), []);
});
