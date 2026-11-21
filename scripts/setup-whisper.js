#!/usr/bin/env node
/**
 * Creates a private Python venv with faster-whisper and pre-downloads a model.
 *
 * Runnable two ways, both hitting this same file:
 *   npm run setup:whisper -- --model small [--gpu]
 *   the "Install / Repair Whisper" button in Settings (spawns this and streams
 *   stdout into the log pane)
 *
 * Every progress line goes to stdout so the UI can paint it live. The last line
 * on success is "OK <path-to-python>", which the caller parses and stores as
 * the whisperPython setting.
 *
 * Lines starting with "STEP <name> <start|done|skip>" mark where the setup is,
 * for the setup assistant's checklist (names: python, venv, engine, cuda,
 * model). Everything else is the human-readable log.
 *
 *   --check     only report what is there, as one "CHECK {json}" line
 *   --no-model  skip the model download (the assistant downloads models itself,
 *               with progress and cancel)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const useGpu = args.includes('--gpu');
const checkOnly = args.includes('--check');
const skipModel = args.includes('--no-model');
const modelIndex = args.indexOf('--model');
const model = modelIndex >= 0 ? args[modelIndex + 1] : 'small';
const dataDirIndex = args.indexOf('--data-dir');

// In the packaged app the caller passes userData; standalone we default to the
// same place Electron would use on Windows so both entry points share a venv.
const dataDir = dataDirIndex >= 0
  ? args[dataDirIndex + 1]
  : path.join(process.env.APPDATA || os.homedir(), 'MeetScribe');

const venvDir = path.join(dataDir, '.venv-whisper');
const modelDir = path.join(dataDir, '.whisper-models');
const isWindows = process.platform === 'win32';
const venvPython = isWindows
  ? path.join(venvDir, 'Scripts', 'python.exe')
  : path.join(venvDir, 'bin', 'python');

function say(line) {
  process.stdout.write(`${line}\n`);
}

function step(name, state, detail = '') {
  say(`STEP ${name} ${state}${detail ? ' ' + detail : ''}`);
}

function run(command, commandArgs, options = {}) {
  say(`$ ${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, {
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
    // huggingface_hub symlinks snapshot files to its blob store, which on
    // Windows needs Developer Mode or admin rights. Without this the model
    // download fails with WinError 1314 after downloading the whole file.
    env: { ...process.env, HF_HUB_DISABLE_SYMLINKS: '1' },
    ...options
  });
  if (result.error) throw new Error(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}`);
}

/**
 * Find a usable interpreter. ctranslate2 ships wheels for cp39..cp313 only, so
 * a 3.14 install is rejected rather than left to fail during pip with a
 * confusing "no matching distribution" error.
 */
/**
 * Where python.org's installer (and winget, which runs it) puts Python on
 * Windows. Checked by path because a Python installed while MeetScribe is
 * running is not on this process's PATH yet.
 */
function knownWindowsPythons() {
  const roots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Python'),
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)']
  ].filter(Boolean);
  const found = [];
  for (const root of roots) {
    for (const version of ['313', '312', '311']) {
      const exe = path.join(root, 'Python' + version, 'python.exe');
      if (fs.existsSync(exe)) found.push([exe, []]);
    }
  }
  const launchers = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Launcher', 'py.exe'),
    process.env.WINDIR && path.join(process.env.WINDIR, 'py.exe')
  ].filter((file) => file && fs.existsSync(file));
  for (const launcher of launchers) found.push([launcher, ['-3']]);
  return found;
}

function probePython(command, prefix) {
  const probe = spawnSync(command, [...prefix, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (probe.status !== 0 || !probe.stdout) return null;
  return probe.stdout.trim();
}

function supported(version) {
  const [major, minor] = String(version).split('.').map(Number);
  return major === 3 && minor >= 9 && minor <= 13;
}

/** The first usable interpreter, or null. `quiet` leaves the log alone (--check). */
function locatePython(quiet = false) {
  const candidates = isWindows
    ? [['py', ['-3.13']], ['py', ['-3.12']], ['py', ['-3.11']], ['py', ['-3']], ['python', []], ['python3', []], ...knownWindowsPythons()]
    : [['python3', []], ['python', []]];

  const rejected = [];
  for (const [command, prefix] of candidates) {
    const version = probePython(command, prefix);
    if (!version) continue;
    if (!supported(version)) {
      rejected.push(version);
      if (!quiet) say(`  skipping ${command} ${prefix.join(' ')} (Python ${version}; need 3.9-3.13)`);
      continue;
    }
    if (!quiet) say(`Using Python ${version} via "${command} ${prefix.join(' ')}".`);
    return { command, prefix, version, rejected };
  }
  return { command: null, prefix: [], version: null, rejected };
}

function findPython() {
  const python = locatePython();
  if (python.command) return python;
  const wrong = python.rejected.length ? ` (found Python ${[...new Set(python.rejected)].join(', ')}, which is not supported)` : '';
  throw new Error(`No suitable Python found${wrong}. Install Python 3.12 from python.org (tick "Add python.exe to PATH"), then click Install / Repair Whisper again`);
}

/** What is already there, for the setup assistant's first screen. */
function check() {
  const python = locatePython(true);
  const venv = fs.existsSync(venvPython);
  const problem = venv ? venvProblem() : null;
  let engine = false;
  if (venv && !problem) {
    engine = spawnSync(venvPython, ['-c', 'import faster_whisper'], { windowsHide: true }).status === 0;
  }
  let winget = false;
  if (isWindows) {
    winget = spawnSync('winget', ['--version'], { windowsHide: true, encoding: 'utf8' }).status === 0;
  }
  say('CHECK ' + JSON.stringify({
    python: python.command ? { version: python.version } : null,
    rejected: [...new Set(python.rejected)],
    venv,
    venvProblem: problem,
    engine,
    winget,
    platform: process.platform
  }));
}

/**
 * Why the existing venv cannot be reused, or null when it is fine. A venv whose
 * base Python was uninstalled no longer starts, and one made with an
 * unsupported version can never install ctranslate2; "Repair" has to rebuild
 * both instead of reusing them. A missing faster-whisper is fixed by the pip
 * step below and is not a reason to rebuild.
 */
function venvProblem() {
  const probe = spawnSync(venvPython, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (probe.status !== 0 || !probe.stdout) return 'its Python no longer starts';
  const version = probe.stdout.trim();
  const [major, minor] = version.split('.').map(Number);
  if (major !== 3 || minor < 9 || minor > 13) return `it uses Python ${version} (need 3.9-3.13)`;
  return null;
}

function main() {
  if (checkOnly) return check();
  say('=== MeetScribe Whisper setup ===');
  say(`Data directory: ${dataDir}`);
  step('python', 'start');

  if (fs.existsSync(venvPython)) {
    const problem = venvProblem();
    if (problem) {
      say(`The existing environment cannot be used (${problem}); rebuilding it.`);
      fs.rmSync(venvDir, { recursive: true, force: true });
    }
  }

  if (!fs.existsSync(venvPython)) {
    const python = findPython();
    step('python', 'done', python.version);
    step('venv', 'start');
    say('Creating virtual environment...');
    fs.mkdirSync(dataDir, { recursive: true });
    run(python.command, [...python.prefix, '-m', 'venv', venvDir]);
  } else {
    step('python', 'done');
    step('venv', 'start');
    say('Virtual environment already exists; reusing it.');
  }

  if (!fs.existsSync(venvPython)) {
    throw new Error(`venv creation did not produce ${venvPython}`);
  }
  step('venv', 'done');

  step('engine', 'start');
  say('Upgrading pip...');
  run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip', '--disable-pip-version-check']);

  say('Installing faster-whisper...');
  run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'faster-whisper', '--disable-pip-version-check']);
  step('engine', 'done');

  if (useGpu) {
    step('cuda', 'start');
    // ctranslate2 >= 4.5 does not bundle cuBLAS/cuDNN. Without these the CUDA
    // path dies with "Could not locate cudnn_ops64_9.dll"; the worker service
    // prepends their bin dirs to the child PATH at spawn time.
    say('Installing CUDA runtime libraries (cuBLAS + cuDNN)...');
    run(venvPython, [
      '-m', 'pip', 'install', '--upgrade',
      'nvidia-cublas-cu12', 'nvidia-cudnn-cu12',
      '--disable-pip-version-check'
    ]);
    step('cuda', 'done');
  }

  fs.mkdirSync(modelDir, { recursive: true });
  if (skipModel) {
    step('model', 'skip');
  } else {
    step('model', 'start');
    say(`Downloading the "${model}" model (this can take a few minutes)...`);
    run(venvPython, [
      '-c',
      'import sys;from faster_whisper import WhisperModel;' +
      'WhisperModel(sys.argv[1], device="cpu", compute_type="int8", download_root=sys.argv[2]);' +
      'print("model ready")',
      model,
      modelDir
    ]);
    step('model', 'done');
  }

  say('');
  say(`Model directory: ${modelDir}`);
  say(`OK ${venvPython}`);
}

try {
  main();
} catch (error) {
  say('');
  say(`ERROR ${error.message}`);
  process.exit(1);
}
