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
  startClickThrough: 'check'
};

// Settings that change what the model list shows.
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
      if (payload.state === 'downloading') return this.updateModelProgress(payload);
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

    document.getElementById('restartApp').addEventListener('click', () => {
      window.electronAPI.restartAppForStealth();
    });

    document.getElementById('quitApp').addEventListener('click', () => window.electronAPI.quitApp());
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

  renderProfiles({ active, profiles }) {
    this.activeProfile = active;
    const holder = document.getElementById('profileCards');
    holder.textContent = '';
    for (const profile of profiles) {
      const card = document.createElement('button');
      card.className = 'profile' + (profile.id === active ? ' active' : '');
      card.title = profile.label + (profile.summary ? ' · ' + profile.summary : '');
      const flag = document.createElement('span');
      flag.className = 'flag';
      flag.innerHTML = window.MeetScribeFlags.svg(profile.flag);
      const name = document.createElement('span');
      name.className = 'p-name';
      name.textContent = profile.label;
      const summary = document.createElement('span');
      summary.className = 'p-sum';
      summary.textContent = profile.summary;
      card.append(flag, name, summary);
      card.addEventListener('click', () => this.selectProfile(profile.id));
      holder.appendChild(card);
    }
    const reset = document.getElementById('resetProfile');
    const current = profiles.find((profile) => profile.id === active);
    reset.hidden = !(current && current.kind === 'builtin' && current.edited);
    document.getElementById('profileHint').textContent = !current || current.kind === 'none'
      ? 'No profile: the default multilingual settings. Change anything; save it as a profile in the Library.'
      : 'Changes you make are remembered by this profile.';
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
    const list = document.getElementById('modelList');
    list.textContent = '';

    // What is on disk comes first, by purpose; everything else hides under one fold.
    const have = rows.filter((row) => row.downloaded);
    const rest = rows.filter((row) => !row.downloaded);
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
    state.className = 'model-state' + (row.downloaded ? ' ok' : '');
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
    // The active profile just absorbed this edit (shows its "Reset" link).
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
