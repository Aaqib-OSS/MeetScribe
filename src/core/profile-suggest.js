/**
 * From plain answers to profile values. The "New profile" questions (meeting
 * language, live transcript yes/no, accurate transcript after yes/no, speed or
 * quality) become the models, language and switches a profile stores, so
 * nobody has to know what "large-v3-turbo" is to make one.
 *
 * Pure. Shared by Node (tests) and both pages: the Settings window loads this
 * file directly, the Library serves it as /profile-suggest.js.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MeetScribeProfileSuggest = api;
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  // What the questions offer. `code` is the whisperLanguage setting.
  const LANGUAGES = [
    { value: 'en', label: 'English', flag: 'us' },
    { value: 'de', label: 'German', flag: 'de' },
    { value: 'tn', label: 'Tunisian Arabic (Derja)', flag: 'tn' },
    { value: 'fr', label: 'French', flag: 'fr' },
    { value: 'es', label: 'Spanish', flag: 'es' },
    { value: 'it', label: 'Italian', flag: 'custom' },
    { value: 'nl', label: 'Dutch', flag: 'custom' },
    { value: 'pt', label: 'Portuguese', flag: 'custom' },
    { value: 'pl', label: 'Polish', flag: 'custom' },
    { value: 'tr', label: 'Turkish', flag: 'custom' },
    { value: 'ru', label: 'Russian', flag: 'custom' },
    { value: 'ar', label: 'Arabic', flag: 'custom' },
    { value: 'auto', label: 'Several languages / detect automatically', flag: 'custom' }
  ];

  const PREFERENCES = [
    { value: 'speed', label: 'Speed — for an older or slower PC' },
    { value: 'balanced', label: 'Balanced (recommended)' },
    { value: 'quality', label: 'Quality — best text, takes longer after each meeting' }
  ];

  // Catalog ids (src/services/model-store.service.js).
  const MODELS = {
    live: {
      default: { speed: 'base', balanced: 'small', quality: 'small' },
      en: { speed: 'base', balanced: 'small.en', quality: 'small.en' },
      de: { speed: 'scheidti/whisper-tiny-german-1224-ct2', balanced: 'small', quality: 'small' }
    },
    final: {
      default: { speed: 'large-v3-turbo', balanced: 'large-v3-turbo', quality: 'large-v3' },
      de: {
        speed: 'cstr/whisper-large-v3-turbo-german-int8_float32',
        balanced: 'cstr/whisper-large-v3-turbo-german-int8_float32',
        quality: 'tnfru/whisper-large-v3-german-ct2'
      },
      // The only Tunisian model is a large one; there is nothing faster to offer.
      tn: { speed: 'medyas/FarukSTT', balanced: 'medyas/FarukSTT', quality: 'medyas/FarukSTT' }
    }
  };

  /**
   * @param {object} answers  { language, live, final, preference }
   * @returns {object} profile values: whisperLanguage, liveTranscription,
   *   whisperModel, offlinePassEnabled, offlineModel
   */
  function suggest({ language = 'auto', live = true, final = true, preference = 'balanced' } = {}) {
    if (!live && !final) throw new Error('Pick at least one: the live transcript or the one after the meeting');
    const known = LANGUAGES.some((entry) => entry.value === language);
    const lang = known ? language : 'auto';
    const pref = PREFERENCES.some((entry) => entry.value === preference) ? preference : 'balanced';
    const pickFrom = (table) => (table[lang] || table.default)[pref];
    return {
      // Whisper has no Tunisian code; the fine-tune expects Arabic.
      whisperLanguage: lang === 'tn' ? 'ar' : lang,
      liveTranscription: Boolean(live),
      // Still set with the live transcript off: the setting cannot be empty.
      whisperModel: pickFrom(MODELS.live),
      offlinePassEnabled: Boolean(final),
      offlineModel: pickFrom(MODELS.final)
    };
  }

  /** The answers that would produce these values, to prefill the questions when editing. */
  function answersFor(values = {}) {
    const language = values.offlineModel === 'medyas/FarukSTT' ? 'tn' : (values.whisperLanguage || 'auto');
    const live = values.liveTranscription !== false;
    const final = values.offlinePassEnabled !== false;
    let preference = 'balanced';
    for (const candidate of ['balanced', 'speed', 'quality']) {
      const made = suggest({ language, live: true, final: true, preference: candidate });
      if (made.offlineModel === values.offlineModel && (!live || made.whisperModel === values.whisperModel)) {
        preference = candidate;
        break;
      }
    }
    return { language, live, final, preference };
  }

  return { LANGUAGES, PREFERENCES, suggest, answersFor };
});
