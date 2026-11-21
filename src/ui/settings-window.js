/**
 * Settings panel.
 *
 * Every control maps 1:1 onto a key in settings.json. Changes save on change
 * (no explicit Save button) and the main process reconfigures the transcription
 * pipeline immediately.
 */

// id -> how to read/write the DOM element
const FIELDS = {
  transcriptRoot: 'text',
  folderNamePrefix: 'text',
  showTranscriptOnRecord: 'check',
  reorderWindowMs: 'number',
  autoStartRecording: 'check',
  autoUpdate: 'check',

  systemEnabled: 'check',
  micEnabled: 'check',
  systemSource: 'text',
  systemDeviceLabel: 'text',
  micDeviceLabel: 'text',
  voiceLabels: 'check',
  voiceMatchThreshold: 'number',
  labelSystem: 'text',
  labelMic: 'text',
  echoSuppress: 'check',
  echoSimilarity: 'number',

  whisperModel: 'text',
  whisperLanguage: 'text',
  whisperDevice: 'text',
  whisperComputeType: 'text',
  whisperPython: 'text',
  whisperWorkerCount: 'number',
  silenceHangoverMs: 'number',
  maxUtteranceMs: 'number',
  vadEnergyFloor: 'number',

  glossary: 'text',
  archiveAudio: 'check',
  liveTranscription: 'check',
  archiveFormat: 'text',
  offlinePassEnabled: 'check',
  offlineModel: 'text',
  offlineMode: 'text',
  offlineBeamSize: 'number',
  offlineCpuThreads: 'number',
  offlineWordConfidence: 'number',
  offlineDiffModel: 'text',

  transcriptFontSize: 'number',
  windowGap: 'number',
  startClickThrough: 'check',
  globalShortcuts: 'check'
};

// Settings that change what the model list shows.
// What a profile holds, in words, for the "You changed …" line.
const PROFILE_KEY_NAMES = {
  liveTranscription: 'the live transcript on/off',
  whisperModel: 'the live model',
  whisperLanguage: 'the language',
  offlineModel: 'the after-meeting model',
  offlinePassEnabled: 'the after-meeting transcript on/off',
  archiveAudio: 'keeping the audio',
  showTranscriptOnRecord: 'showing the transcript when recording',
  folderNamePrefix: 'the folder name',
  glossary: 'the glossary terms',
  glossarySet: 'the project glossaries'
};

const MODEL_SETTINGS = ['whisperModel', 'offlineModel', 'offlineDiffModel', 'offlineMode', 'offlineCpuThreads'];

const MODEL_GROUPS = [
  ['live', 'For the live transcript'],
  ['final', 'For the final pass']
];

// localStorage can be blocked or empty; the window must work without it.
function recall(key, fallback = null) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function remember(key, value) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* not persisted */ }
}


function chip(className, text) {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  return element;
}

/** "Speed ●●●○○" with the dots coloured. */
function rating(label, dots) {
  const element = document.createElement('span');
  element.className = 'model-rating';
  element.append(label + ' ');
  element.appendChild(chip('dots', dots));
  return element;
}

/** A filled bar, or a moving one when the total is unknown (percent null). */
function progressBar(percent) {
  const bar = document.createElement('div');
  bar.className = 'model-bar' + (percent === null ? ' indeterminate' : '');
  const fill = document.createElement('span');
  if (percent !== null) fill.style.width = Math.max(2, percent) + '%';
  bar.appendChild(fill);
  return bar;
}

// Flags come from src/ui/flags.js (window.MeetScribeFlags).

class SettingsWindow {
  constructor() {
    this.settings = null;
    this.applying = false;
    // repo -> message of the last failed download, shown on its row until dismissed.
    this.modelErrors = {};
    // Unknown until the first status arrives; Download buttons assume it is set up.
    this.whisperConfigured = true;

    this.bindTabs();
    this.bindFields();
    this.bindActions();
    this.bindVoice();
    this.bindEvents();
    this.bindProfileEditor();
    this.load();
    this.loadModels();
    this.loadProfiles();
    this.refreshVoice();
  }

  bindTabs() {
    const show = (tab) => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`page-${tab.dataset.page}`).classList.add('active');
    };
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        show(tab);
        remember('settings.tab', tab.dataset.page);
      });
    });
    const last = document.querySelector('.tab[data-page="' + (recall('settings.tab') || '') + '"]');
    if (last) show(last);

    // Collapsible sections remember whether the user left them open.
    const open = recall('settings.sections', {});
    document.querySelectorAll('details.section').forEach((section) => {
      const key = section.dataset.key;
      if (key in open) section.open = Boolean(open[key]);
      section.addEventListener('toggle', () => {
        remember('settings.sections', { ...recall('settings.sections', {}), [key]: section.open });
      });
    });
  }

  bindFields() {
    for (const id of Object.keys(FIELDS)) {
      const element = document.getElementById(id);
      if (!element) continue;
      const eventName = element.tagName === 'SELECT' || element.type === 'checkbox' ? 'change' : 'input';
      element.addEventListener(eventName, () => {
        if (this.applying) return;
        this.save({ [id]: this.readField(id) });
        if (id === 'systemSource') this.updateSystemSourceVisibility();
        if (id === 'echoSimilarity') this.updateEchoLabel();
        if (id === 'offlineWordConfidence') this.updateConfidenceLabel();
      });
    }
  }

  bindActions() {
    document.getElementById('browseFolder').addEventListener('click', async () => {
      const result = await window.electronAPI.pickFolder();
      if (result.ok) {
        document.getElementById('transcriptRoot').value = result.path;
        this.save({ transcriptRoot: result.path });
      }
    });

    document.getElementById('openFolder').addEventListener('click', () => {
      window.electronAPI.openMeetingFolder();
    });

    document.getElementById('openManager').addEventListener('click', () => {
      window.electronAPI.openManager();
    });

    document.getElementById('browsePython').addEventListener('click', async () => {
      const result = await window.electronAPI.pickPython();
      if (result.ok) {
        document.getElementById('whisperPython').value = result.path;
        this.save({ whisperPython: result.path });
        this.refreshWhisperStatus();
      }
    });

    document.getElementById('resetProfile').addEventListener('click', async () => {
      const result = await window.electronAPI.resetProfile(this.activeProfile);
      if (result.settings) this.apply(result.settings);
      if (result.profiles) this.renderProfiles(result);
    });

    document.getElementById('installWhisper').addEventListener('click', () => this.installWhisper());

    document.getElementById('updateCheck').addEventListener('click', async () => {
      this.renderUpdate(await window.electronAPI.checkForUpdates());
    });
    document.getElementById('updateInstall').addEventListener('click', async () => {
      const result = await window.electronAPI.installUpdate();
      if (result && result.ok === false) {
        document.getElementById('updateText').textContent = result.error;
      }
    });
    window.electronAPI.onUpdateStatus((status) => this.renderUpdate(status));
    window.electronAPI.getUpdateStatus().then((status) => this.renderUpdate(status)).catch(() => {});
    document.getElementById('openSetup').addEventListener('click', () => window.electronAPI.openSetup());

    const customModel = document.getElementById('offlineModelCustom');
    customModel.addEventListener('input', () => {
      if (this.applying) return;
      const typed = customModel.value.trim();
      this.save({ offlineModel: typed || document.getElementById('offlineModel').value });
    });

    document.getElementById('rerunFinal').addEventListener('click', async () => {
      const status = document.getElementById('finalPassStatus');
      const result = await window.electronAPI.pickAndRerunFinalPass();
      if (result.canceled) return;
      status.textContent = result.ok
        ? 'Re-transcribing ' + result.folder + '…'
        : 'Could not start: ' + result.error;
    });

    window.electronAPI.onModelProgress((payload) => {
      this.onProfileDownloadProgress(payload);
      if (payload.state === 'downloading') {
        this.updateModelProgress(payload);
        // The profile prompt shows the same download.
        return this.renderMissingModels((this.profileList || []).find((profile) => profile.id === this.activeProfile));
      }
      // A failure must stay on screen until it is read, not vanish with the
      // next re-render.
      if (payload.state === 'failed') this.modelErrors[payload.repo] = payload.error || 'Download failed';
      else delete this.modelErrors[payload.repo];
      this.loadModels();
    });

    window.electronAPI.onFinalPass((payload) => {
      const status = document.getElementById('finalPassStatus');
      if (!status || !payload) return;
      status.textContent = payload.message || payload.state || '';
    });

    document.getElementById('restartApp').addEventListener('click', (event) => {
      this.confirmIfBusy(event.currentTarget, 'Restart', () => window.electronAPI.restartAppForStealth());
    });

    document.getElementById('quitApp').addEventListener('click', (event) => {
      this.confirmIfBusy(event.currentTarget, 'Quit', () => window.electronAPI.quitApp());
    });
    document.getElementById('closeBtn').addEventListener('click', () => window.electronAPI.closeSettings());

    document.querySelectorAll('.icon-choice').forEach((choice) => {
      choice.addEventListener('click', () => {
        const icon = choice.dataset.icon;
        document.querySelectorAll('.icon-choice').forEach((c) => c.classList.remove('selected'));
        choice.classList.add('selected');
        window.electronAPI.updateAppIcon(icon);
      });
    });
  }

  bindEvents() {
    window.electronAPI.onLoadSettings((settings) => this.apply(settings));
    window.electronAPI.onSettingsWindowShown(() => {
      this.load();
      this.refreshDevices();
      // Models may have been downloaded or deleted from the Library meanwhile.
      this.loadModels();
    });

    window.electronAPI.onAudioLevel(({ streamId, rms }) => {
      const meter = document.getElementById(streamId === 'system' ? 'meterSystem' : 'meterMic');
      if (meter) meter.style.width = `${Math.min(100, Math.round(Math.sqrt(rms) * 180))}%`;
    });

    window.electronAPI.onInstallProgress((line) => this.appendLog(line));
  }

  async refreshVoice() {
    const status = document.getElementById('voiceStatus');
    try {
      const voice = await window.electronAPI.getVoiceStatus();
      this.voice = voice;
      const ready = voice.packageReady && voice.modelReady;
      document.getElementById('voiceSetup').hidden = ready;
      document.getElementById('voiceEnroll').hidden = !ready;
      document.getElementById('voiceEnroll').textContent = voice.enrolled ? 'Record again' : 'Record my voice (25 s)';
      document.getElementById('voiceDelete').hidden = !voice.enrolled;
      if (!ready) status.textContent = 'Not set up yet.';
      else if (!voice.enrolled) status.textContent = 'Ready. Record your voice to start labelling.';
      else status.textContent = 'Your voice is saved' + (voice.enrolledAt ? ' (' + voice.enrolledAt.slice(0, 10) + ')' : '') + '.';
    } catch (_) {
      status.textContent = 'Status unknown.';
    }
  }

  bindVoice() {
    const status = document.getElementById('voiceStatus');
    const busy = (button, on) => { button.disabled = on; };
    window.electronAPI.onVoiceProgress((line) => { status.textContent = String(line); });

    document.getElementById('voiceSetup').addEventListener('click', async (event) => {
      busy(event.target, true);
      status.textContent = 'Setting up…';
      const result = await window.electronAPI.setupVoice();
      busy(event.target, false);
      if (!result.ok) status.textContent = 'Setup failed: ' + result.error;
      else await this.refreshVoice();
    });

    document.getElementById('voiceEnroll').addEventListener('click', async (event) => {
      busy(event.target, true);
      const result = await window.electronAPI.enrollVoice(25);
      busy(event.target, false);
      if (result.ok) {
        await this.refreshVoice();
        status.textContent = 'Voice saved (' + result.clips + ' clips, consistency ' + result.consistency + ').';
      } else {
        status.textContent = result.error;
      }
    });

    document.getElementById('voiceDelete').addEventListener('click', async (event) => {
      const button = event.target;
      // Two clicks, like deleting a model.
      if (button.dataset.armed !== '1') {
        button.dataset.armed = '1';
        button.textContent = 'Confirm?';
        setTimeout(() => { button.dataset.armed = ''; button.textContent = 'Delete my voice'; }, 4000);
        return;
      }
      button.dataset.armed = '';
      button.textContent = 'Delete my voice';
      await window.electronAPI.deleteVoice();
      this.refreshVoice();
    });
  }

  async loadProfiles() {
    try {
      this.renderProfiles(await window.electronAPI.listProfiles());
    } catch (_) { /* main process not ready; the next open retries */ }
  }

  renderProfiles({ active, profiles, changed, hiddenBuiltins }) {
    this.activeProfile = active;
    document.getElementById('restoreProfiles').hidden = !hiddenBuiltins;
    this.profileList = profiles || [];
    this.profileChanged = changed || [];
    const holder = document.getElementById('profileCards');
    holder.textContent = '';
    for (const profile of this.profileList) {
      const card = document.createElement('button');
      const modified = profile.id === active && profile.kind !== 'none' && this.profileChanged.length > 0;
      card.className = 'profile' + (profile.id === active ? ' active' : '') + (modified ? ' modified' : '');
      card.title = profile.label + (modified ? ' · changed, not saved yet' : '');
      const flag = document.createElement('span');
      flag.className = 'flag';
      flag.innerHTML = window.MeetScribeFlags.svg(profile.flag);
      const name = document.createElement('span');
      name.className = 'p-name';
      name.textContent = profile.label;
      card.append(flag, name);
      card.addEventListener('click', () => this.selectProfile(profile.id));
      holder.appendChild(card);
    }
    const add = document.createElement('button');
    add.className = 'profile add';
    add.textContent = '+ New';
    add.title = 'Make a profile by answering a few questions';
    add.addEventListener('click', () => this.openProfileEditor(null));
    holder.appendChild(add);
    this.renderProfileDetail();
  }

  /** The active profile in words, its unsaved changes, and any models it still needs. */
  renderProfileDetail() {
    const current = (this.profileList || []).find((profile) => profile.id === this.activeProfile) || null;
    const detail = document.getElementById('profileDetail');
    detail.textContent = '';
    if (current) {
      const head = document.createElement('div');
      head.className = 'pd-head';
      const flag = document.createElement('span');
      flag.className = 'profile';
      flag.style.cssText = 'border:none;background:none;padding:0;flex:none;cursor:default';
      const flagBox = document.createElement('span');
      flagBox.className = 'flag';
      flagBox.innerHTML = window.MeetScribeFlags.svg(current.flag);
      flag.appendChild(flagBox);
      const title = document.createElement('b');
      title.textContent = current.label;
      head.append(flag, title);
      if (current.kind !== 'none') {
        const edit = document.createElement('button');
        edit.className = 'action';
        edit.textContent = 'Edit';
        edit.addEventListener('click', () => this.openProfileEditor(current));
        head.appendChild(edit);
      }
      detail.appendChild(head);

      const values = current.values || {};
      const language = (window.MeetScribeProfileSuggest.LANGUAGES.find((entry) => entry.value === values.whisperLanguage) || {}).label;
      const rows = [
        ['Language', language || values.whisperLanguage || 'Detect automatically'],
        ['Live', values.liveTranscription === false ? 'Off' : this.modelWords(values.whisperModel)],
        ['After meeting', values.offlinePassEnabled === false ? 'Off' : this.modelWords(values.offlineModel)]
      ];
      if (values.folderNamePrefix) rows.push(['Folder name', values.folderNamePrefix]);
      const list = document.createElement('dl');
      for (const [term, value] of rows) {
        const dt = document.createElement('dt');
        dt.textContent = term;
        const dd = document.createElement('dd');
        if (value instanceof Node) dd.appendChild(value);
        else dd.textContent = value;
        list.append(dt, dd);
      }
      detail.appendChild(list);
    }

    this.renderProfileChanged(current);
    this.renderMissingModels(current);
    const reset = document.getElementById('resetProfile');
    reset.hidden = !(current && current.kind === 'builtin' && current.edited);
    document.getElementById('profileHint').textContent = !current || current.kind === 'none'
      ? 'No profile: the default settings. Change anything, then keep it with "+ New".'
      : 'Changes on the other tabs show up here until you save them.';
  }

  /** "German · Accurate", plus "needs download" when it is not on this PC. */
  modelWords(id) {
    const row = (this.modelRows || []).find((candidate) => candidate.id === id || candidate.repo === id);
    const span = document.createElement('span');
    span.textContent = row ? row.title || row.label : id || '?';
    if (row && !row.downloaded) {
      const need = document.createElement('span');
      need.className = 'need';
      need.textContent = row.downloading ? ' · downloading' : ' · needs download';
      span.appendChild(need);
    }
    return span;
  }

  renderProfileChanged(current) {
    const box = document.getElementById('profileChanged');
    box.textContent = '';
    const changed = this.profileChanged || [];
    if (!current || current.kind === 'none' || !changed.length) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const text = document.createElement('span');
    text.textContent = 'You changed ' + changed.map((key) => PROFILE_KEY_NAMES[key] || key).join(', ') +
      '. This is not saved in “' + current.label + '” yet.';
    const actions = document.createElement('div');
    actions.className = 'notice-actions';
    const save = document.createElement('button');
    save.className = 'action primary';
    save.textContent = 'Save to “' + current.label + '”';
    save.addEventListener('click', async () => {
      const values = {};
      for (const key of Object.keys(PROFILE_KEY_NAMES)) if (this.settings && key in this.settings) values[key] = this.settings[key];
      const result = await window.electronAPI.updateProfile(current.id, values, {});
      if (result && result.ok === false) return this.showProfileError(box, result.error);
      if (result.settings) this.apply(result.settings);
      this.loadProfiles();
    });
    const saveNew = document.createElement('button');
    saveNew.className = 'action';
    saveNew.textContent = 'Save as new profile…';
    saveNew.addEventListener('click', () => this.openProfileEditor(null, { fromCurrent: true }));
    const undo = document.createElement('button');
    undo.className = 'action';
    undo.textContent = 'Undo changes';
    undo.addEventListener('click', () => this.selectProfile(current.id));
    actions.append(save, saveNew, undo);
    box.append(text, actions);
  }

  showProfileError(box, message) {
    const error = document.createElement('span');
    error.style.color = '#ffcfcb';
    error.textContent = message;
    box.appendChild(error);
  }

  /** The models a profile uses that are not on this PC: [{ role, row }]. */
  missingModels(profile) {
    if (!profile || !this.modelRows) return [];
    const values = profile.values || {};
    const wanted = [];
    if (values.liveTranscription !== false && values.whisperModel) wanted.push(['live', values.whisperModel]);
    if (values.offlinePassEnabled !== false && values.offlineModel) wanted.push(['final', values.offlineModel]);
    const out = [];
    for (const [role, id] of wanted) {
      const row = this.modelRows.find((candidate) => candidate.id === id || candidate.repo === id);
      if (row && !row.downloaded && !out.some((entry) => entry.row.repo === row.repo)) out.push({ role, row });
    }
    return out;
  }

  /**
   * "This profile needs X (815 MB). Download now?" with a bar and Cancel.
   * Downloads run one after another (the model store does one at a time).
   */
  renderMissingModels(current) {
    const box = document.getElementById('profileMissing');
    box.textContent = '';
    this.missingDismissed = this.missingDismissed || new Set();
    const missing = this.missingModels(current);
    if (!current || !missing.length || (this.missingDismissed.has(current.id) && !this.profileQueue)) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const total = missing.reduce((sum, { row }) => sum + (row.sizeMb || 0) * 1e6, 0);
    const text = document.createElement('span');
    const names = missing.map(({ row }) => (row.title || row.label) + (row.sizeMb ? ' (' + window.MeetScribeModelCard.formatBytes(row.sizeMb * 1e6) + ')' : '')).join(' and ');
    text.textContent = '“' + current.label + '” needs ' + names + ', not on this PC yet.';
    box.appendChild(text);

    const downloading = missing.find(({ row }) => row.downloading);
    if (downloading || this.profileQueue) {
      const row = downloading ? downloading.row : missing[0].row;
      const card = window.MeetScribeModelCard.card(row);
      const line = document.createElement('div');
      line.className = 'dl-line';
      const label = document.createElement('span');
      label.textContent = (card.title) + ': ' + (card.progress ? card.progress.label : 'Starting…');
      line.appendChild(label);
      line.appendChild(progressBar(card.progress ? card.progress.percent : null));
      box.appendChild(line);
      const actions = document.createElement('div');
      actions.className = 'notice-actions';
      const cancel = document.createElement('button');
      cancel.className = 'action';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', async () => {
        this.profileQueue = null;
        cancel.disabled = true;
        cancel.textContent = 'Cancelling…';
        await window.electronAPI.cancelModelDownload(row.id);
      });
      actions.appendChild(cancel);
      box.appendChild(actions);
      return;
    }

    const actions = document.createElement('div');
    actions.className = 'notice-actions';
    if (!this.whisperConfigured) {
      const setup = document.createElement('button');
      setup.className = 'action primary';
      setup.textContent = 'Run the setup assistant first';
      setup.addEventListener('click', () => window.electronAPI.openSetup());
      actions.appendChild(setup);
    } else {
      const download = document.createElement('button');
      download.className = 'action primary';
      download.textContent = 'Download now' + (total ? ' (' + window.MeetScribeModelCard.formatBytes(total) + ')' : '');
      download.addEventListener('click', () => {
        this.profileQueue = missing.map(({ row }) => row.id);
        this.nextProfileDownload(box);
      });
      actions.appendChild(download);
    }
    const later = document.createElement('button');
    later.className = 'action';
    later.textContent = 'Not now';
    later.addEventListener('click', () => {
      this.missingDismissed.add(current.id);
      box.hidden = true;
    });
    actions.appendChild(later);
    box.appendChild(actions);
  }

  async nextProfileDownload(box) {
    const id = this.profileQueue && this.profileQueue.shift();
    if (!id) {
      this.profileQueue = null;
      return this.loadModels();
    }
    const result = await window.electronAPI.downloadModel(id);
    if (!result.ok) {
      this.profileQueue = null;
      this.renderProfileDetail();
      this.showProfileError(document.getElementById('profileMissing'), result.error);
    }
  }

  /** Model progress for the profile prompt: redraw it, and start the next download when one ends. */
  onProfileDownloadProgress(payload) {
    if (!this.profileQueue && payload.state !== 'downloading') return;
    if (payload.state === 'done' && this.profileQueue) {
      // The list reload below redraws the prompt with the next model.
      setTimeout(() => this.nextProfileDownload(), 300);
    } else if (payload.state === 'failed' || payload.state === 'cancelled') {
      this.profileQueue = null;
    }
  }

  // ── New / edit profile ──

  /**
   * @param {object|null} profile  null for a new one
   * @param {object} options       fromCurrent: start from the current settings (Save as new)
   */
  openProfileEditor(profile, { fromCurrent = false } = {}) {
    const suggestApi = window.MeetScribeProfileSuggest;
    this.editingProfile = profile;
    const mine = profile && profile.kind === 'mine';
    document.getElementById('peTitle').textContent = profile ? 'Edit “' + profile.label + '”' : fromCurrent ? 'Save as a new profile' : 'New profile';
    const name = document.getElementById('peName');
    name.value = profile ? profile.label : '';
    name.disabled = Boolean(profile && !mine);
    name.title = name.disabled ? 'Built-in profiles keep their name' : '';
    // Built-ins can be deleted too; "Restore built-in profiles" brings them back.
    document.getElementById('peDelete').hidden = !profile || profile.kind === 'none';
    document.getElementById('peError').hidden = true;

    const values = profile ? profile.values : this.settings || {};
    const answers = suggestApi.answersFor(values);
    if (!profile && !fromCurrent && !values.whisperLanguage) answers.language = 'auto';

    // Flags
    this.editingFlag = profile ? profile.flag : 'custom';
    // A new profile's flag follows its language until one is picked by hand.
    this.flagTouched = Boolean(profile);
    const flags = document.getElementById('peFlags');
    flags.textContent = '';
    for (const code of window.MeetScribeFlags.codes) {
      const button = document.createElement('button');
      button.type = 'button';
      button.title = window.MeetScribeFlags.label(code);
      button.className = code === this.editingFlag ? 'selected' : '';
      button.innerHTML = window.MeetScribeFlags.svg(code);
      button.dataset.code = code;
      button.addEventListener('click', () => {
        this.editingFlag = code;
        this.flagTouched = true;
        flags.querySelectorAll('button').forEach((node) => node.classList.toggle('selected', node === button));
      });
      flags.appendChild(button);
    }

    const fill = (select, options, value) => {
      select.textContent = '';
      for (const option of options) {
        const element = document.createElement('option');
        element.value = option.value;
        element.textContent = option.label;
        select.appendChild(element);
      }
      select.value = value;
    };
    fill(document.getElementById('peLanguage'), suggestApi.LANGUAGES, answers.language);
    fill(document.getElementById('pePreference'), suggestApi.PREFERENCES, answers.preference);
    const rows = this.modelRows || [];
    const label = (row) => (row.downloaded ? '✓ ' : '') + (row.title || row.label) + (row.tech && row.tech !== row.title ? ' (' + row.tech + ')' : '');
    fill(document.getElementById('peLiveModel'), rows.filter((row) => (row.roles || []).includes('live')).map((row) => ({ value: row.id, label: label(row) })), values.whisperModel);
    fill(document.getElementById('peFinalModel'), rows.filter((row) => (row.roles || []).includes('final')).map((row) => ({ value: row.id, label: label(row) })), values.offlineModel);
    document.getElementById('peFolder').value = values.folderNamePrefix || '';
    document.getElementById('peAdvanced').open = false;

    this.setSeg('live', answers.live);
    this.setSeg('final', answers.final);
    // A new profile starts from the suggestion for its answers; an edited one keeps its models.
    if (!profile && !fromCurrent) this.applySuggestion();
    else this.renderEditorPlan();

    document.getElementById('profileView').hidden = true;
    document.getElementById('profileEditor').hidden = false;
    if (!name.disabled) name.focus();
  }

  setSeg(name, on) {
    const seg = document.querySelector('.seg[data-name="' + name + '"]');
    seg.dataset.value = on ? 'yes' : 'no';
    seg.querySelectorAll('button').forEach((button) => button.classList.toggle('on', button.dataset.value === seg.dataset.value));
  }

  segValue(name) {
    return document.querySelector('.seg[data-name="' + name + '"]').dataset.value === 'yes';
  }

  /** The answers decide the models (the Advanced section can still override them). */
  applySuggestion() {
    if (!this.flagTouched) {
      const language = window.MeetScribeProfileSuggest.LANGUAGES.find((entry) => entry.value === document.getElementById('peLanguage').value);
      this.editingFlag = (language && language.flag) || 'custom';
      document.querySelectorAll('#peFlags button').forEach((node) => node.classList.toggle('selected', node.dataset.code === this.editingFlag));
    }
    let values;
    try {
      values = window.MeetScribeProfileSuggest.suggest({
        language: document.getElementById('peLanguage').value,
        live: this.segValue('live'),
        final: this.segValue('final'),
        preference: document.getElementById('pePreference').value
      });
    } catch (_) {
      return this.renderEditorPlan();
    }
    const setIfOffered = (select, value) => {
      if (Array.from(select.options).some((option) => option.value === value)) select.value = value;
    };
    setIfOffered(document.getElementById('peLiveModel'), values.whisperModel);
    setIfOffered(document.getElementById('peFinalModel'), values.offlineModel);
    this.renderEditorPlan();
  }

  renderEditorPlan() {
    const plan = document.getElementById('pePlan');
    plan.textContent = '';
    const live = this.segValue('live');
    const final = this.segValue('final');
    if (!live && !final) {
      plan.textContent = 'Pick at least one: the live transcript or the one after the meeting.';
      return;
    }
    const line = (label, id, on) => {
      const row = (this.modelRows || []).find((candidate) => candidate.id === id);
      const element = document.createElement('div');
      element.append(label + ': ');
      const strong = document.createElement('b');
      strong.textContent = on ? (row ? row.title || row.label : id) : 'off';
      element.appendChild(strong);
      if (on && row) {
        element.append(row.downloaded ? ' · on this PC' : row.sizeMb ? ' · ' + window.MeetScribeModelCard.formatBytes(row.sizeMb * 1e6) + ' download' : ' · download needed');
      }
      return element;
    };
    plan.append(
      line('Live', document.getElementById('peLiveModel').value, live),
      line('After the meeting', document.getElementById('peFinalModel').value, final)
    );
  }

  closeProfileEditor() {
    document.getElementById('profileEditor').hidden = true;
    document.getElementById('profileView').hidden = false;
    this.editingProfile = null;
  }

  async saveProfileEditor() {
    const error = document.getElementById('peError');
    error.hidden = true;
    const fail = (message) => {
      error.textContent = message;
      error.hidden = false;
    };
    const profile = this.editingProfile;
    const mine = profile && profile.kind === 'mine';
    const label = document.getElementById('peName').value.trim();
    if ((!profile || mine) && !label) return fail('Give the profile a name.');
    const live = this.segValue('live');
    const final = this.segValue('final');
    if (!live && !final) return fail('Pick at least one: the live transcript or the one after the meeting.');
    const language = document.getElementById('peLanguage').value;
    const values = {
      whisperLanguage: language === 'tn' ? 'ar' : language,
      liveTranscription: live,
      offlinePassEnabled: final,
      whisperModel: document.getElementById('peLiveModel').value,
      offlineModel: document.getElementById('peFinalModel').value,
      folderNamePrefix: document.getElementById('peFolder').value.trim()
    };
    let result;
    if (profile) {
      result = await window.electronAPI.updateProfile(profile.id, values, mine ? { label, flag: this.editingFlag } : {});
      if (result && result.ok !== false && profile.id !== this.activeProfile) result = await window.electronAPI.selectProfile(profile.id);
    } else {
      result = await window.electronAPI.createProfile({ label, flag: this.editingFlag, values, activate: true });
    }
    if (!result || result.ok === false) return fail((result && result.error) || 'Could not save the profile.');
    if (result.settings) this.apply(result.settings);
    this.closeProfileEditor();
    await this.loadModels();
    this.loadProfiles();
  }

  async deleteEditedProfile() {
    const profile = this.editingProfile;
    if (!profile) return;
    const button = document.getElementById('peDelete');
    if (button.dataset.armed !== '1') {
      button.dataset.armed = '1';
      button.textContent = 'Click again to delete';
      setTimeout(() => { button.dataset.armed = ''; button.textContent = 'Delete profile'; }, 4000);
      return;
    }
    button.dataset.armed = '';
    button.textContent = 'Delete profile';
    const result = await window.electronAPI.deleteProfile(profile.id);
    if (result && result.ok === false) {
      const error = document.getElementById('peError');
      error.textContent = result.error;
      error.hidden = false;
      return;
    }
    this.closeProfileEditor();
    this.loadProfiles();
  }

  bindProfileEditor() {
    document.getElementById('restoreProfiles').addEventListener('click', async () => {
      const result = await window.electronAPI.restoreBuiltinProfiles();
      if (result && result.settings) this.apply(result.settings);
      this.loadProfiles();
    });
    document.getElementById('peCancel').addEventListener('click', () => this.closeProfileEditor());
    document.getElementById('peSave').addEventListener('click', () => this.saveProfileEditor());
    document.getElementById('peDelete').addEventListener('click', () => this.deleteEditedProfile());
    for (const id of ['peLanguage', 'pePreference']) {
      document.getElementById(id).addEventListener('change', () => this.applySuggestion());
    }
    for (const id of ['peLiveModel', 'peFinalModel']) {
      document.getElementById(id).addEventListener('change', () => this.renderEditorPlan());
    }
    document.querySelectorAll('.seg').forEach((seg) => {
      seg.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => {
        this.setSeg(seg.dataset.name, button.dataset.value === 'yes');
        this.applySuggestion();
      }));
    });
  }

  async selectProfile(id) {
    const result = await window.electronAPI.selectProfile(id);
    if (!result.ok) return;
    this.apply(result.settings);
    this.renderProfiles(result);
    this.loadModels();
  }

  async load() {
    const settings = await window.electronAPI.getSettings();
    this.apply(settings);
    this.refreshDevices();
    this.loadGlossaries();
  }

  /** Project glossaries (made in the Library) as chips; ticked ones go into new meetings. */
  async loadGlossaries() {
    try {
      this.glossaryList = await window.electronAPI.listGlossaries();
    } catch (_) {
      this.glossaryList = [];
    }
    this.glossaryNames = this.glossaryList.map((glossary) => glossary.name);
    this.renderGlossarySet();
  }

  /** "About N of M terms reach the model" for the ticked glossaries. */
  renderGlossaryFit() {
    const line = document.getElementById('glossaryFit');
    const budget = window.MeetScribeGlossaryBudget;
    if (!line || !budget) return;
    const chosen = new Set(((this.settings && this.settings.glossarySet) || []).map((name) => name.toLowerCase()));
    const texts = (this.glossaryList || [])
      .filter((glossary) => chosen.has(glossary.name.toLowerCase()))
      .map((glossary) => glossary.text || '');
    line.textContent = budget.describe(budget.forTexts(texts));
  }

  renderGlossarySet() {
    const holder = document.getElementById('glossarySet');
    if (!holder || !this.glossaryNames || !this.glossaryNames.length) return;
    const chosen = new Set(((this.settings && this.settings.glossarySet) || []).map((name) => name.toLowerCase()));
    holder.textContent = '';
    for (const name of this.glossaryNames) {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = chosen.has(name.toLowerCase());
      const label = document.createElement('label');
      label.className = box.checked ? 'on' : '';
      label.append(box, document.createTextNode(name));
      box.addEventListener('change', () => {
        label.className = box.checked ? 'on' : '';
        const set = [...holder.querySelectorAll('label')]
          .filter((item) => item.querySelector('input').checked)
          .map((item) => item.textContent);
        this.settings.glossarySet = set;
        this.save({ glossarySet: set });
        this.renderGlossaryFit();
      });
      holder.appendChild(label);
    }
    this.renderGlossaryFit();
  }

  readField(id) {
    const element = document.getElementById(id);
    const kind = FIELDS[id];
    if (kind === 'check') return element.checked;
    if (kind === 'number') return Number(element.value);
    return element.value;
  }

  apply(settings) {
    if (!settings) return;
    this.settings = settings;
    // Guard so programmatic writes don't re-trigger a save per field.
    this.applying = true;

    for (const [id, kind] of Object.entries(FIELDS)) {
      const element = document.getElementById(id);
      if (!element || settings[id] === undefined) continue;
      if (kind === 'check') element.checked = !!settings[id];
      else element.value = settings[id];
    }

    document.querySelectorAll('.icon-choice').forEach((choice) => {
      choice.classList.toggle('selected', choice.dataset.icon === settings.appIcon);
    });

    document.getElementById('meterLabelThem').textContent = settings.labelSystem || 'Them';
    document.getElementById('meterLabelYou').textContent = settings.labelMic || 'You';

    this.updateSystemSourceVisibility();
    this.updateEchoLabel();
    this.updateConfidenceLabel();
    this.applyCustomModel(settings);
    this.renderGlossarySet();
    this.renderWhisperStatus(settings.whisper);
    this.populateDevices(settings.audioInputs || []);

    this.applying = false;
  }

  updateConfidenceLabel() {
    const element = document.getElementById('confValue');
    if (element) {
      element.textContent = Number(document.getElementById('offlineWordConfidence').value).toFixed(2);
    }
  }

  /**
   * The dropdown holds the stock models; anything else (a German fine-tune, a
   * local conversion) is typed into the text box. One setting backs both, so
   * the box wins whenever it holds a value the dropdown does not offer.
   */
  applyCustomModel(settings) {
    const select = document.getElementById('offlineModel');
    const custom = document.getElementById('offlineModelCustom');
    if (!select || !custom) return;
    const value = settings.offlineModel || '';
    const known = Array.from(select.options).some((option) => option.value === value);
    custom.value = known ? '' : value;
    if (!known && value) select.value = 'large-v3-turbo';
  }

  updateSystemSourceVisibility() {
    const isDevice = document.getElementById('systemSource').value === 'device';
    document.getElementById('systemDeviceLabel').style.display = isDevice ? '' : 'none';
  }

  updateEchoLabel() {
    document.getElementById('echoValue').textContent =
      Number(document.getElementById('echoSimilarity').value).toFixed(2);
  }

  async refreshDevices() {
    try {
      const devices = await window.electronAPI.listAudioDevices();
      this.populateDevices(devices.inputs || []);
    } catch (_) {
      /* enumeration needs the audio window; ignore while starting up */
    }
  }

  populateDevices(inputs) {
    for (const id of ['micDeviceLabel', 'systemDeviceLabel']) {
      const select = document.getElementById(id);
      if (!select) continue;
      const current = (this.settings && this.settings[id]) || '';
      select.innerHTML = '';

      const auto = document.createElement('option');
      auto.value = '';
      auto.textContent = id === 'micDeviceLabel' ? 'System default' : 'Choose a device…';
      select.appendChild(auto);

      for (const input of inputs) {
        if (!input.label) continue;
        const option = document.createElement('option');
        option.value = input.label;
        option.textContent = input.label;
        select.appendChild(option);
      }
      select.value = current;
    }
  }

  renderWhisperStatus(status) {
    const element = document.getElementById('whisperStatus');
    if (!status) {
      element.textContent = 'Status unknown';
      return;
    }
    const wasConfigured = this.whisperConfigured;
    this.whisperConfigured = Boolean(status.configured);
    // Download buttons depend on this.
    if (wasConfigured !== this.whisperConfigured) this.loadModels();
    if (!status.configured) {
      element.textContent = 'Not set up — click "Install / Repair Whisper".';
      const install = document.querySelector('details.section[data-key="install"]');
      if (install) install.open = true; // the one thing to do next must not be hidden
      return;
    }
    const parts = ['Ready'];
    if (status.model) parts.push(status.model);
    if (status.device) parts.push(status.device);
    parts.push(`queue ${status.queueDepth ?? 0}`);
    if (status.lastLatencyMs) parts.push(`last ${status.lastLatencyMs} ms`);
    element.textContent = parts.join(' · ');
    if (status.lastError) element.textContent += ` · ${status.lastError}`;
  }

  async refreshWhisperStatus() {
    try {
      this.renderWhisperStatus(await window.electronAPI.getWhisperStatus());
    } catch (_) { /* ignore */ }
  }

  async installWhisper() {
    const button = document.getElementById('installWhisper');
    const log = document.getElementById('installLog');
    const banner = document.getElementById('installResult');
    log.textContent = '';
    log.classList.add('show');
    banner.hidden = true;
    button.disabled = true;
    button.textContent = 'Installing…';

    try {
      const result = await window.electronAPI.installWhisper({
        gpu: document.getElementById('installGpu').checked,
        model: document.getElementById('whisperModel').value
      });
      banner.hidden = false;
      if (result.ok) {
        document.getElementById('whisperPython').value = result.python;
        banner.className = 'notice ok';
        banner.textContent = 'Whisper is installed. You can download more models below.';
      } else {
        banner.className = 'notice error';
        banner.textContent = 'Install failed: ' + (result.message || result.error || 'unknown error') +
          '. The log below has the details.';
      }
      this.refreshWhisperStatus();
      // Setup downloads the live model; its row must not still say "Not downloaded".
      this.loadModels();
    } catch (error) {
      banner.hidden = false;
      banner.className = 'notice error';
      banner.textContent = 'Install failed: ' + error.message;
    } finally {
      button.disabled = false;
      button.textContent = 'Install / Repair Whisper';
    }
  }

  appendLog(line) {
    const log = document.getElementById('installLog');
    log.classList.add('show');
    log.textContent += `${line}\n`;
    log.scrollTop = log.scrollHeight;
  }

  async loadModels() {
    try {
      this.renderModels(await window.electronAPI.listModels());
    } catch (error) {
      document.getElementById('modelList').textContent = 'Could not list models: ' + error.message;
    }
  }

  renderModels(rows) {
    this.modelRows = rows;
    // Model names and "needs download" on the profile page come from these rows.
    if (this.profileList) this.renderProfileDetail();
    const list = document.getElementById('modelList');
    list.textContent = '';

    // What is on disk comes first, by purpose; everything else hides under one fold.
    // On disk, or picked for use (and then needing a download): shown first.
    const shown = (row) => row.downloaded || (row.inUse || []).length > 0;
    const have = rows.filter(shown);
    const rest = rows.filter((row) => !shown(row));
    for (const [category, title] of MODEL_GROUPS) {
      const group = have.filter((row) => (row.category === 'live' ? 'live' : 'final') === category);
      if (!group.length) continue;
      const heading = document.createElement('div');
      heading.className = 'model-group';
      heading.textContent = title;
      list.appendChild(heading);
      for (const row of group) list.appendChild(this.renderModel(row));
    }
    if (!have.length) {
      const none = document.createElement('div');
      none.className = 'hint';
      none.textContent = 'No models downloaded yet.';
      list.appendChild(none);
    }

    if (rest.length) {
      const more = document.createElement('details');
      more.className = 'model-more';
      more.open = Boolean(this.availableOpen) || rest.some((row) => row.downloading);
      more.addEventListener('toggle', () => { this.availableOpen = more.open; });
      const summary = document.createElement('summary');
      summary.textContent = 'Available to download (' + rest.length + ')';
      more.appendChild(summary);
      const body = document.createElement('div');
      body.className = 'models';
      for (const row of rest) body.appendChild(this.renderModel(row));
      more.appendChild(body);
      list.appendChild(more);
    }
    this.markDownloaded(rows);
  }

  renderModel(row) {
    const card = window.MeetScribeModelCard.card(row);
    const item = document.createElement('div');
    item.className = 'model' + (row.downloaded ? ' have' : '');
    item.dataset.repo = row.repo;

    const main = document.createElement('div');
    main.className = 'model-main';

    const name = document.createElement('div');
    name.className = 'model-name';
    name.append(card.title);
    if (card.language) name.appendChild(chip('model-lang', card.language));
    for (const role of row.inUse) {
      name.appendChild(chip('model-tag', role === 'live' ? 'in use: live' : role === 'final' ? 'in use: final pass' : 'in use: cross-check'));
    }

    // The technical name links to the model's page, for anyone who wants the details.
    const tech = document.createElement('div');
    tech.className = 'model-tech';
    if (card.url) {
      const link = document.createElement('a');
      link.href = card.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = 'Open this model on Hugging Face';
      link.textContent = card.tech + ' ↗';
      tech.appendChild(link);
    } else {
      tech.append(card.tech);
    }
    tech.append(' · ' + card.purpose);

    const ratings = document.createElement('div');
    ratings.className = 'model-ratings';
    if (card.speed) ratings.appendChild(rating('Speed', card.speed));
    if (card.accuracy) ratings.appendChild(rating('Accuracy', card.accuracy));
    if (card.minutes) ratings.appendChild(chip('model-minutes', card.minutes));

    const note = document.createElement('div');
    note.className = 'model-meta';
    note.textContent = card.note;

    main.append(name, tech);
    if (ratings.childNodes.length) main.appendChild(ratings);
    if (card.note) main.appendChild(note);

    const state = document.createElement('span');
    const needed = !row.downloaded && (row.inUse || []).length > 0;
    state.className = 'model-state' + (row.downloaded ? ' ok' : needed ? ' needed' : '');
    state.textContent = card.status;

    const error = document.createElement('div');
    error.className = 'notice error model-error';
    error.hidden = true;

    const button = document.createElement('button');
    button.className = 'action' + (row.downloaded ? ' danger' : '');
    if (row.downloading) {
      button.textContent = 'Cancel';
      button.addEventListener('click', async () => {
        button.disabled = true;
        button.textContent = 'Cancelling…';
        const result = await window.electronAPI.cancelModelDownload(row.id);
        if (!result.ok) { button.disabled = false; button.textContent = 'Cancel'; }
      });
    } else if (row.downloaded) {
      // Two clicks, not a dialog: a stray click must not cost a 3 GB re-download.
      button.textContent = 'Delete';
      button.addEventListener('click', async () => {
        if (button.dataset.armed !== '1') {
          button.dataset.armed = '1';
          button.textContent = 'Confirm?';
          setTimeout(() => { button.dataset.armed = ''; button.textContent = 'Delete'; }, 4000);
          return;
        }
        const result = await window.electronAPI.deleteModel(row.id);
        if (!result.ok) this.showModelError(row.repo, error, result.error);
        else this.loadModels();
      });
    } else if (!this.whisperConfigured) {
      // Downloading runs through the Whisper environment, so it cannot start yet.
      button.textContent = 'Install Whisper first';
      button.className = 'action primary';
      button.addEventListener('click', () => this.showInstaller());
    } else {
      button.textContent = 'Download';
      button.className = 'action primary';
      button.addEventListener('click', async () => {
        delete this.modelErrors[row.repo];
        error.hidden = true;
        button.disabled = true;
        const result = await window.electronAPI.downloadModel(row.id);
        if (!result.ok) {
          button.disabled = false;
          this.showModelError(row.repo, error, result.error);
        }
        // Otherwise the first progress event redraws this card with a bar.
      });
    }

    if (this.modelErrors[row.repo]) this.showModelError(row.repo, error, this.modelErrors[row.repo]);

    const line = document.createElement('div');
    line.className = 'model-line';
    line.append(main, state, button);
    item.appendChild(line);
    if (card.progress) item.appendChild(progressBar(card.progress.percent));
    item.appendChild(error);
    return item;
  }

  /** Redraw one card from a progress event, without re-listing every model. */
  updateModelProgress(payload) {
    const row = (this.modelRows || []).find((candidate) => candidate.repo === payload.repo);
    const element = document.querySelector('.model[data-repo="' + CSS.escape(payload.repo) + '"]');
    if (!row || !element) return this.loadModels();
    Object.assign(row, { downloading: true, progress: payload.progress, bytesDone: payload.bytes || 0, total: payload.total || 0 });
    // A download started from the Library may be hiding under the fold.
    const fold = element.closest('details.model-more');
    if (fold) fold.open = true;
    element.replaceWith(this.renderModel(row));
  }

  /** Settings → updates: the version, what the updater is doing, and Restart when one is ready. */
  renderUpdate(status) {
    if (!status) return;
    const text = document.getElementById('updateText');
    const box = document.getElementById('updateBox');
    const check = document.getElementById('updateCheck');
    const install = document.getElementById('updateInstall');
    const bar = document.getElementById('updateBar');
    const current = 'Version ' + (status.current || '?');
    box.classList.toggle('ready', status.state === 'ready');
    install.hidden = status.state !== 'ready';
    check.hidden = status.state === 'ready';
    check.disabled = status.state === 'checking' || status.state === 'downloading';
    bar.hidden = status.state !== 'downloading';
    if (status.state === 'downloading') bar.firstChild.style.width = Math.max(2, status.percent || 0) + '%';
    const when = status.checkedAt ? ' (checked ' + new Date(status.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ')' : '';
    text.textContent = {
      checking: current + ' · checking for updates…',
      none: current + ' · up to date' + when,
      downloading: current + ' · downloading ' + (status.version || 'the update') + '… ' + (status.percent || 0) + '%',
      ready: 'Version ' + status.version + ' is ready. Restart to update (takes a few seconds).',
      error: current + ' · ' + (status.error || 'the update check failed'),
      unsupported: current + ' · ' + (status.error || 'updates work in the installed app')
    }[status.state] || current;
  }

  /**
   * Quit and Restart: straight away when nothing is running; otherwise the
   * button first says what it would interrupt and needs a second click. A
   * recording is stopped properly first either way (its final pass resumes on
   * the next launch).
   */
  async confirmIfBusy(button, verb, action) {
    if (button.dataset.armed === '1') {
      button.dataset.armed = '';
      return action();
    }
    let busy = {};
    try { busy = await window.electronAPI.getBusyState(); } catch (_) { /* unknown: just do it */ }
    if (!busy.recording && !busy.finalPass) return action();
    const what = busy.recording ? 'Stops the recording' : 'The final pass starts over next time';
    const label = button.textContent;
    button.dataset.armed = '1';
    button.textContent = what + ' · click again to ' + verb.toLowerCase();
    setTimeout(() => {
      if (button.dataset.armed !== '1') return;
      button.dataset.armed = '';
      button.textContent = label;
    }, 5000);
  }

  /** A failed download, in words someone can act on, with a way to dismiss it. */
  showModelError(repo, element, message) {
    this.modelErrors[repo] = message;
    element.textContent = '';
    const text = document.createElement('span');
    text.textContent = /python environment was not found/i.test(message)
      ? 'Whisper is not installed yet, so models cannot be downloaded. Install Whisper first.'
      : message;
    const close = document.createElement('button');
    close.className = 'notice-close';
    close.textContent = '✕';
    close.title = 'Dismiss';
    close.addEventListener('click', () => {
      delete this.modelErrors[repo];
      element.hidden = true;
    });
    element.append(text, close);
    element.hidden = false;
  }

  /** Transcription tab, installer section open and in view. */
  showInstaller() {
    const tab = document.querySelector('.tab[data-page="whisper"]');
    if (tab) tab.click();
    const install = document.querySelector('details.section[data-key="install"]');
    if (!install) return;
    install.open = true;
    install.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const button = document.getElementById('installWhisper');
    button.classList.add('pulse');
    setTimeout(() => button.classList.remove('pulse'), 2400);
  }

  /**
   * The model dropdowns use the same names as the cards: every catalog model
   * that fits the role is offered, labelled "German · Accurate (large-v3-turbo
   * (German fine-tune))", with "✓" when it is already on disk.
   */
  markDownloaded(rows) {
    for (const [id, role] of [['whisperModel', 'live'], ['offlineModel', 'final']]) {
      const select = document.getElementById(id);
      if (!select) continue;
      for (const row of rows) {
        if (row.custom || !(row.roles || []).includes(role)) continue;
        if (Array.from(select.options).some((option) => option.value === row.id)) continue;
        const option = document.createElement('option');
        option.value = row.id;
        select.appendChild(option);
      }
      for (const option of select.options) {
        const row = rows.find((candidate) => candidate.id === option.value || candidate.repo === option.value);
        if (!row) continue;
        const label = row.title && row.title !== row.tech ? row.title + ' (' + row.tech + ')' : row.title || row.label;
        option.textContent = (row.downloaded ? '✓ ' : '') + label;
      }
      // A saved choice that only now has an option shows up selected.
      const saved = this.settings && this.settings[id];
      if (saved && select.value !== saved && Array.from(select.options).some((option) => option.value === saved)) {
        select.value = saved;
      }
    }
    if (this.settings) this.applyCustomModel(this.settings);
  }

  async save(patch) {
    await window.electronAPI.saveSettings(patch);
    // "In use" tags and the time estimates depend on these.
    if (MODEL_SETTINGS.some((key) => key in patch)) this.loadModels();
    // The active profile now shows what changed against it.
    if (this.activeProfile) this.loadProfiles();
    const saved = document.getElementById('saved');
    saved.classList.add('show');
    clearTimeout(this.savedTimer);
    this.savedTimer = setTimeout(() => saved.classList.remove('show'), 1200);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.settingsWindow = new SettingsWindow();
});
