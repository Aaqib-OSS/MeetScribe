/**
 * The first-run setup assistant (setup.html).
 *
 * Welcome -> Python check (one-click install through winget) -> meeting
 * language (picks a built-in profile and with it the live and final models) ->
 * install with a checklist -> done. The speech engine is installed by
 * scripts/setup-whisper.js (its "STEP" lines tick the checklist); the models
 * are downloaded through the model store, so they get the same progress bar
 * and cancel as in Settings.
 */

const STEPS = ['welcome', 'python', 'language', 'install', 'done'];

// Meeting languages offered, each backed by a built-in profile (src/core/profiles.js).
const LANGUAGES = [
  { profile: 'english', flag: 'us', title: 'English', text: 'Live transcript, plus a more accurate one after the meeting.' },
  { profile: 'german', flag: 'de', title: 'German', text: 'Models trained for German. Live transcript plus an accurate one after.' },
  { profile: 'tunisian', flag: 'tn', title: 'Tunisian Arabic (Derja)', text: 'No live transcript; one accurate transcript after the meeting. Large download.' },
  { profile: 'none', flag: null, title: 'Another language, or several', text: 'Detects the language by itself. Works for most languages.' }
];

// Rough sizes of what pip installs, for the "what will be downloaded" summary.
const ENGINE_BYTES = 250e6;
const CUDA_BYTES = 1.1e9;

const $ = (id) => document.getElementById(id);
const fmt = (bytes) => window.MeetScribeModelCard.formatBytes(bytes);

class SetupAssistant {
  constructor() {
    this.step = 0;
    this.check = null;
    this.choice = null;
    this.profiles = [];
    this.models = [];
    this.running = false;
    this.finished = false;
    this.tasks = new Map();
    // repo -> resolve, for the model download the install step is waiting on.
    this.waiting = new Map();

    $('next').addEventListener('click', () => this.next());
    $('back').addEventListener('click', () => this.go(this.step - 1));
    $('later').addEventListener('click', () => window.electronAPI.closeSetup());
    $('installPython').addEventListener('click', () => this.installPython());
    $('recheckPython').addEventListener('click', () => this.runCheck());
    $('gpu').addEventListener('change', () => this.renderPlan());

    window.electronAPI.onInstallProgress((line) => this.onLine(line));
    window.electronAPI.onModelProgress((payload) => this.onModelProgress(payload));

    this.go(0);
  }

  // ── Navigation ──

  go(index) {
    this.step = Math.max(0, Math.min(STEPS.length - 1, index));
    STEPS.forEach((name, i) => $('step-' + name).classList.toggle('active', i === this.step));
    Array.from($('steps').children).forEach((bar, i) => bar.classList.toggle('on', i <= this.step));
    const name = STEPS[this.step];
    if (name === 'python' && !this.check) this.runCheck();
    if (name === 'language') this.loadChoices();
    this.renderFooter();
  }

  renderFooter() {
    const name = STEPS[this.step];
    const back = $('back');
    const next = $('next');
    const later = $('later');
    back.hidden = name === 'welcome' || name === 'done';
    back.disabled = this.running;
    later.hidden = name === 'done' || this.running;
    next.disabled = false;
    if (name === 'welcome') next.textContent = 'Start setup';
    if (name === 'python') {
      next.textContent = 'Continue';
      next.disabled = !(this.check && (this.check.python || this.check.engine));
    }
    if (name === 'language') {
      next.textContent = 'Install';
      next.disabled = !this.choice;
    }
    if (name === 'install') {
      next.textContent = this.finished ? 'Finish' : this.failed ? 'Try again' : 'Installing…';
      next.disabled = this.running;
    }
    if (name === 'done') next.textContent = 'Close';
  }

  next() {
    const name = STEPS[this.step];
    if (name === 'install') {
      if (this.finished) return this.go(this.step + 1);
      return this.install();
    }
    if (name === 'language') {
      this.go(this.step + 1);
      return this.install();
    }
    if (name === 'done') {
      window.electronAPI.completeSetup().finally(() => window.electronAPI.closeSetup());
      return;
    }
    this.go(this.step + 1);
  }

  // ── Python ──

  async runCheck() {
    const box = $('pythonCheck');
    box.className = 'check busy';
    $('pythonTitle').textContent = 'Looking for Python…';
    $('pythonDetail').textContent = '';
    $('pythonActions').hidden = true;
    $('pythonError').hidden = true;
    this.renderFooter();

    const check = await window.electronAPI.checkSetup();
    this.check = check.ok ? check : null;
    const mark = box.querySelector('.mark');
    const good = check.ok && Boolean(check.python || check.engine);
    mark.textContent = good ? '✓' : '!';
    if (!check.ok) {
      box.className = 'check bad';
      $('pythonTitle').textContent = 'The check did not work';
      $('pythonDetail').textContent = check.error || '';
      $('pythonActions').hidden = false;
      $('installPython').hidden = true;
      return this.renderFooter();
    }

    if (check.python || check.engine) {
      box.className = 'check ok';
      $('pythonTitle').textContent = check.engine ? 'The speech engine is already installed' : 'Python ' + check.python.version + ' found';
      $('pythonDetail').textContent = 'All good. Continue to choose your meeting language.';
    } else {
      box.className = 'check bad';
      const wrong = check.rejected && check.rejected.length
        ? 'Python ' + check.rejected.join(', ') + ' is installed, but MeetScribe needs 3.11, 3.12 or 3.13. '
        : 'Python is not installed. ';
      $('pythonTitle').textContent = 'Python is needed';
      $('pythonDetail').textContent = wrong + (check.winget
        ? 'MeetScribe can install Python 3.12 for you (about 30 MB, no admin rights needed). It does not change any Python you already have.'
        : 'Download Python 3.12 from python.org, run the installer with "Add python.exe to PATH" ticked, then click Check again.');
      $('pythonActions').hidden = false;
      $('installPython').hidden = !check.winget;
      if (!check.winget) this.addPythonLink();
    }
    this.renderFooter();
  }

  addPythonLink() {
    if ($('pythonLink')) return;
    const link = document.createElement('a');
    link.id = 'pythonLink';
    link.href = 'https://www.python.org/downloads/release/python-3120/';
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Open python.org';
    link.style.alignSelf = 'center';
    $('pythonActions').prepend(link);
  }

  async installPython() {
    const button = $('installPython');
    button.disabled = true;
    button.textContent = 'Installing Python…';
    $('recheckPython').disabled = true;
    $('pythonCheck').className = 'check busy';
    $('pythonTitle').textContent = 'Installing Python 3.12…';
    $('pythonDetail').textContent = 'This takes a minute or two.';
    $('pythonError').hidden = true;
    const result = await window.electronAPI.installPython();
    button.disabled = false;
    button.textContent = 'Install Python for me';
    $('recheckPython').disabled = false;
    if (!result.ok) {
      $('pythonError').hidden = false;
      $('pythonError').textContent = 'Python could not be installed automatically (' + result.error + '). ' +
        'Download it from python.org instead, then click Check again.';
      this.addPythonLink();
    }
    this.runCheck();
  }

  // ── Language ──

  async loadChoices() {
    if (!this.profiles.length) {
      const [profiles, models] = await Promise.all([window.electronAPI.listProfiles(), window.electronAPI.listModels()]);
      this.profiles = (profiles && profiles.profiles) || [];
      this.models = models || [];
    }
    const box = $('choices');
    box.textContent = '';
    for (const language of LANGUAGES) {
      const button = document.createElement('button');
      button.className = 'choice' + (this.choice === language ? ' selected' : '');
      const flag = document.createElement('span');
      flag.className = 'flag';
      if (language.flag) flag.innerHTML = window.MeetScribeFlags.svg(language.flag);
      else flag.textContent = '🌐';
      const text = document.createElement('span');
      const title = document.createElement('b');
      title.textContent = language.title;
      const small = document.createElement('small');
      small.textContent = language.text;
      text.append(title, small);
      button.append(flag, text);
      button.addEventListener('click', () => {
        this.choice = language;
        this.loadChoices();
        this.renderFooter();
      });
      box.appendChild(button);
    }
    this.renderPlan();
  }

  /** The models a choice needs: [{ role, row }], skipping roles that are switched off. */
  modelsFor(choice) {
    const profile = this.profiles.find((candidate) => candidate.id === choice.profile);
    const values = (profile && profile.values) || {};
    const find = (id) => this.models.find((row) => row.id === id || row.repo === id) ||
      { id, repo: id, title: id, sizeMb: 0, downloaded: false };
    const out = [];
    if (values.liveTranscription !== false && values.whisperModel) out.push({ role: 'live', row: find(values.whisperModel) });
    if (values.offlinePassEnabled !== false && values.offlineModel) out.push({ role: 'final', row: find(values.offlineModel) });
    return out;
  }

  renderPlan() {
    const plan = $('plan');
    plan.textContent = '';
    if (!this.choice) {
      plan.hidden = true;
      return;
    }
    plan.hidden = false;
    const lines = [];
    const engineInstalled = this.check && this.check.engine;
    let total = 0;
    if (!engineInstalled) {
      lines.push(['Speech engine', fmt(ENGINE_BYTES)]);
      total += ENGINE_BYTES;
    }
    if ($('gpu').checked) {
      lines.push(['NVIDIA graphics card support', fmt(CUDA_BYTES)]);
      total += CUDA_BYTES;
    }
    for (const { role, row } of this.modelsFor(this.choice)) {
      const label = (role === 'live' ? 'Live model: ' : 'After-meeting model: ') + (row.title || row.id);
      const bytes = (row.sizeMb || 0) * 1e6;
      lines.push([label, row.downloaded ? 'already on this PC' : fmt(bytes) || 'unknown size']);
      if (!row.downloaded) total += bytes;
    }
    lines.push(['Total download', 'about ' + (fmt(total) || '0 MB')]);
    lines.forEach(([left, right], i) => {
      const line = document.createElement('div');
      if (i === lines.length - 1) line.className = 'total';
      const a = document.createElement('span');
      a.textContent = left;
      const b = document.createElement('span');
      b.textContent = right;
      line.append(a, b);
      plan.appendChild(line);
    });
  }

  // ── Install ──

  task(key, title) {
    if (this.tasks.has(key)) return this.tasks.get(key);
    const box = document.createElement('div');
    box.className = 'check';
    const mark = document.createElement('span');
    mark.className = 'mark';
    const body = document.createElement('div');
    body.className = 'body';
    const name = document.createElement('b');
    name.textContent = title;
    const detail = document.createElement('small');
    body.append(name, detail);
    const side = document.createElement('div');
    side.className = 'side';
    box.append(mark, body, side);
    $('tasks').appendChild(box);
    const handle = {
      box, body, detail, side, bar: null,
      set(state, text) {
        box.className = 'check' + (state === 'busy' ? ' busy' : state === 'ok' ? ' ok' : state === 'bad' ? ' bad' : '');
        mark.textContent = state === 'ok' ? '✓' : state === 'bad' ? '!' : state === 'skip' ? '–' : '';
        if (text !== undefined) detail.textContent = text;
      },
      progress(percent) {
        if (!handle.bar) {
          handle.bar = document.createElement('div');
          handle.bar.appendChild(document.createElement('span'));
          body.appendChild(handle.bar);
        }
        handle.bar.className = 'bar' + (percent === null ? ' indeterminate' : '');
        handle.bar.firstChild.style.width = percent === null ? '' : Math.max(2, percent) + '%';
      },
      clearProgress() {
        if (handle.bar) handle.bar.remove();
        handle.bar = null;
      }
    };
    this.tasks.set(key, handle);
    return handle;
  }

  async install() {
    this.running = true;
    this.failed = false;
    this.finished = false;
    $('installError').hidden = true;
    $('installTitle').textContent = 'Setting things up';
    $('installHint').textContent = "You can keep working meanwhile. Don't close this window.";
    $('tasks').textContent = '';
    this.tasks.clear();
    this.renderFooter();

    const gpu = $('gpu').checked;
    // Fresh, so "Try again" does not fetch a model the last attempt finished.
    this.models = (await window.electronAPI.listModels()) || this.models;
    const models = this.modelsFor(this.choice);
    this.task('python', 'Python').set('wait');
    this.task('venv', 'Private Python environment for MeetScribe').set('wait');
    this.task('engine', 'Speech engine (faster-whisper)').set('wait');
    if (gpu) this.task('cuda', 'NVIDIA graphics card support').set('wait');
    for (const { role, row } of models) {
      const card = window.MeetScribeModelCard.card(row);
      this.task('model:' + row.repo, (role === 'live' ? 'Live model: ' : 'After-meeting model: ') + card.title)
        .set(row.downloaded ? 'ok' : 'wait', card.tech + (row.downloaded ? ' · already on this PC' : row.sizeMb ? ' · ' + fmt(row.sizeMb * 1e6) : ''));
    }

    try {
      // The profile first: it sets the models and language the rest relies on.
      const selected = await window.electronAPI.selectProfile(this.choice.profile);
      if (selected && selected.ok === false) throw new Error(selected.error || 'Could not apply the language choice');

      const engine = await window.electronAPI.installWhisper({ gpu, noModel: true });
      if (!engine.ok) throw new Error(engine.message || engine.error || 'The speech engine could not be installed');
      // Whatever the script reported step by step, all of it is in place now.
      for (const key of ['python', 'venv', 'engine', 'cuda']) {
        const handle = this.tasks.get(key);
        if (handle && !handle.box.classList.contains('ok')) handle.set('ok', 'Done');
      }

      for (const { row } of models) {
        if (row.downloaded) continue;
        await this.downloadModel(row);
      }

      this.finished = true;
      $('installTitle').textContent = 'All done';
      $('installHint').textContent = 'Everything is installed.';
      await window.electronAPI.completeSetup();
    } catch (error) {
      this.failed = true;
      $('installError').hidden = false;
      $('installError').textContent = friendly(error.message);
      $('installTitle').textContent = 'Setup stopped';
      $('installHint').textContent = 'Nothing is lost: "Try again" continues where it stopped.';
      for (const handle of this.tasks.values()) {
        if (handle.box.classList.contains('busy')) handle.set('bad');
      }
    } finally {
      this.running = false;
      this.renderFooter();
      if (this.finished) this.go(STEPS.indexOf('done'));
    }
  }

  /** Download one model and wait for it; resolves on done, rejects on failure or cancel. */
  downloadModel(row) {
    const handle = this.task('model:' + row.repo);
    handle.set('busy', 'Starting download…');
    handle.progress(null);
    this.addCancel(handle, row);
    return new Promise((resolve, reject) => {
      this.waiting.set(row.repo, { resolve, reject, row });
      window.electronAPI.downloadModel(row.id).then((result) => {
        if (!result.ok) {
          this.waiting.delete(row.repo);
          reject(new Error(result.error));
        }
      });
    });
  }

  addCancel(handle, row) {
    handle.side.textContent = '';
    const cancel = document.createElement('button');
    cancel.className = 'link';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', async () => {
      cancel.disabled = true;
      cancel.textContent = 'Cancelling…';
      await window.electronAPI.cancelModelDownload(row.id);
    });
    handle.side.appendChild(cancel);
  }

  onModelProgress(payload) {
    const waiting = this.waiting.get(payload.repo);
    const handle = this.tasks.get('model:' + payload.repo);
    if (!handle) return;
    if (payload.state === 'downloading') {
      const view = window.MeetScribeModelCard.progress({ downloading: true, progress: payload.progress, bytesDone: payload.bytes, total: payload.total });
      handle.set('busy', view.label);
      handle.progress(view.percent);
      return;
    }
    handle.side.textContent = '';
    handle.clearProgress();
    if (payload.state === 'done') handle.set('ok', 'Downloaded');
    if (payload.state === 'failed') handle.set('bad', 'Download failed');
    if (payload.state === 'cancelled') handle.set('bad', 'Cancelled');
    if (!waiting) return;
    this.waiting.delete(payload.repo);
    if (payload.state === 'done') waiting.resolve();
    else if (payload.state === 'cancelled') waiting.reject(new Error('You cancelled the download of ' + (waiting.row.title || waiting.row.id) + '.'));
    else waiting.reject(new Error(payload.error || 'Download failed'));
  }

  /** setup-whisper.js output: "STEP" lines tick the checklist, the rest is the log. */
  onLine(line) {
    const match = /^STEP (\w+) (start|done|skip)(?: (.*))?$/.exec(line);
    if (!match) {
      const log = $('log');
      log.textContent += line + '\n';
      log.scrollTop = log.scrollHeight;
      return;
    }
    const [, name, state, detail] = match;
    if (name === 'model') return; // models are downloaded separately, with progress
    const handle = this.tasks.get(name);
    if (!handle) return;
    if (state === 'start') handle.set('busy', name === 'engine' || name === 'cuda' ? 'Downloading and installing… this is the slow part' : 'Working…');
    if (state === 'done') handle.set('ok', name === 'python' && detail ? 'Python ' + detail : 'Done');
    if (state === 'skip') handle.set('skip', 'Skipped');
  }
}

/** Turn a technical failure into something a person can act on. */
function friendly(message) {
  const text = String(message || 'Something went wrong');
  if (/No suitable Python/i.test(text)) return 'Python 3.11 to 3.13 was not found. Go back one step to install it, then try again.';
  if (/pip.*exited|exited with code/i.test(text)) {
    return 'Installing the speech engine failed. Check your internet connection, then click "Try again". ' +
      '"Show details" below has the technical log. (' + text + ')';
  }
  if (/Download failed/i.test(text)) return 'A model download failed. Check your internet connection and free disk space, then click "Try again". (' + text + ')';
  return text;
}

new SetupAssistant();
