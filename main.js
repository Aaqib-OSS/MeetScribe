const path = require("path");
const fs = require("fs");
const { fileURLToPath } = require("url");
const {
  app,
  BrowserWindow,
  globalShortcut,
  session,
  ipcMain,
  desktopCapturer,
  dialog,
  shell,
  clipboard,
} = require("electron");

// ── Pin userData before anything reads it ──
// The disguise feature calls app.setName("Terminal ") to hide the app in Task
// Manager, and Electron derives userData from the app name. Without pinning,
// the settings file, the Whisper venv and the model cache would all move every
// time the user picks a different disguise. Must run before the first
// getPath('userData') and before setName().
try {
  app.setPath("userData", path.join(app.getPath("appData"), "MeetScribe"));
} catch (_) {
  /* falls back to Electron's default */
}

// Keep Chromium network noise out of the terminal; app logs go through Winston.
app.commandLine.appendSwitch("log-level", "3");
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-domain-reliability");
app.commandLine.appendSwitch("no-pings");

const { logDir } = require("./src/core/logger");
const logger = require("./src/core/logger").createServiceLogger("MAIN");
const config = require("./src/core/config");
const settingsStore = require("./src/core/settings.store");

// ── Global crash guard ──
// The transcription path spawns an external Python process. A spawn failure
// must degrade to a status message, never take the whole app down mid-meeting.
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception (kept alive)", {
    error: err && err.message,
    stack: err && err.stack,
  });
});
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection (kept alive)", {
    reason: String((reason && reason.message) || reason),
  });
});

const captureService = require("./src/services/capture.service");
const transcriptionService = require("./src/services/transcription.service");
const meetingService = require("./src/services/meeting.service");
const audioArchive = require("./src/services/audio-archive.service");
const offlinePass = require("./src/services/offline-pass.service");
const modelStore = require("./src/services/model-store.service");
const profiles = require("./src/core/profiles");
const settingsSchema = require("./src/core/settings-schema");
const libraryService = require("./src/services/library.service");
const managerServer = require("./src/services/manager-server.service");
const phoneServer = require("./src/services/phone-server.service");
const libraryEdit = require("./src/services/library-edit.service");
const voiceService = require("./src/services/voice.service");
const speedStats = require("./src/services/speed-stats.service");
const { CaptureWatchdog } = require("./src/core/capture-watchdog");
const problemLog = require("./src/core/problem-log");
const windowManager = require("./src/managers/window.manager");

// How often a recording is checked for arriving audio, and how many times
// capture is restarted before only the warning stays.
const WATCHDOG_INTERVAL_MS = 3000;
const MAX_CAPTURE_RESTARTS = 3;

/** Why an update check failed, in words a user can act on. */
function friendlyUpdateError(error) {
  const text = String((error && error.message) || error || "");
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::|getaddrinfo|socket/i.test(text)) return "No internet connection, or GitHub could not be reached.";
  if (/404|latest\.yml/i.test(text)) return "No downloadable release was found on GitHub yet.";
  if (/sha512|checksum|signature/i.test(text)) return "The downloaded update did not check out; it will be fetched again next time.";
  return text.split("\n")[0].slice(0, 200) || "The update check failed.";
}

class ApplicationController {
  constructor() {
    this.isReady = false;
    this.starting = false;
    this.appIcon = "terminal";
    this.audioDevices = { inputs: [] };
    this.captureWatchdog = new CaptureWatchdog();
    // Warnings shown so far, newest first; loaded on first use.
    this.problems = null;
    this.watchdogTimer = null;
    // The recording the previous run left unfinished, read once at launch.
    this.unfinishedAtLaunch = "";
    // folder -> promise of a running final pass, including its FLAC step.
    this.finalPasses = new Map();
    // Started from the library shortcut: the manager only, no overlay.
    this.libraryOnly = process.argv.includes("--library");
    this.overlayCreated = false;

    this.setupStealth();
    this.setupEventHandlers();
  }

  setupStealth() {
    if (config.get("stealth.disguiseProcess")) {
      process.title = config.get("app.processTitle");
    }

    // Default disguise: look like a terminal in the task list.
    if (app && typeof app.setName === "function") {
      app.setName("Terminal ");
    }
    process.title = "Terminal ";

    if (process.platform === "darwin" && config.get("stealth.noAttachConsole")) {
      process.env.ELECTRON_NO_ATTACH_CONSOLE = "1";
      process.env.ELECTRON_NO_ASAR = "1";
    }
  }

  setupEventHandlers() {
    app.whenReady().then(() => this.onAppReady());
    app.on("window-all-closed", () => this.onWindowAllClosed());
    app.on("activate", () => this.onActivate());
    app.on("will-quit", () => this.onWillQuit());

    this.setupIPCHandlers();
    this.setupServiceEventHandlers();
  }

  handleSecondInstance(argv = []) {
    logger.info("Second instance launch detected; focusing existing windows");
    // The library shortcut while MeetScribe runs: open the manager, nothing else.
    if (argv.includes("--library")) {
      app.whenReady().then(() => this.openManager());
      return;
    }
    // MeetScribe started normally while only the library runs: bring the overlay up.
    if (this.libraryOnly) {
      app.whenReady().then(() => this.leaveLibraryOnly());
      return;
    }

    const focusExistingWindows = () => {
      try {
        const mainWindow = windowManager.getWindow("main");
        if (mainWindow) {
          if (mainWindow.isMinimized && mainWindow.isMinimized()) {
            mainWindow.restore();
          }
          windowManager.showAllWindows();
          windowManager.showOnCurrentDesktop(mainWindow);
          mainWindow.focus();
          return;
        }
        if (this.isReady) windowManager.showAllWindows();
      } catch (error) {
        logger.error("Failed to focus existing instance", { error: error.message });
      }
    };

    if (app.isReady()) {
      focusExistingWindows();
    } else {
      app.whenReady().then(focusExistingWindows);
    }
  }

  async onAppReady() {
    if (this.starting || this.isReady) return;
    this.starting = true;

    app.setName("Terminal ");
    process.title = "Terminal ";

    settingsStore.load();
    this.appIcon = settingsStore.get("appIcon") || "terminal";
    // Read before any recording can start: Record overwrites the setting with
    // the live meeting, which recovery must never touch.
    this.unfinishedAtLaunch = settingsStore.get("unfinishedRecording") || "";

    logger.info("Application starting", {
      version: config.get("app.version"),
      platform: process.platform,
      userData: app.getPath("userData"),
    });

    try {
      this.setupPermissions();
      this.setupDisplayMediaHandler();
      // Built-ins this version no longer ships become the user's own profiles
      // if they were in use, before anything reads the profile list.
      const migrated = profiles.migrate(settingsStore.all());
      if (migrated) {
        settingsStore.update(migrated);
        logger.info("Moved retired built-in profiles to the user's own", { count: (migrated.myProfiles || []).length });
      }
      transcriptionService.configure();
      this.ensureLibraryShortcut();

      if (this.libraryOnly) {
        // Started from the library shortcut: no overlay, just the manager.
        this.starting = false;
        this.isReady = true;
        logger.info("Started in library-only mode");
        await this.openManager();
        return;
      }

      await this.startOverlay();
      this.starting = false;
      this.isReady = true;
      // A new install walks through setup instead of failing on the first Record.
      await this.openSetupIfNeeded();

      if (settingsStore.get("autoStartRecording")) {
        setTimeout(() => this.startRecording(), 1200);
      }

      logger.info("Application initialized successfully");
      this.checkForUpdates();
      // After the UI is up: a resumed pass is background work and can wait.
      setTimeout(() => {
        // Pending first: recovery queues a pass, which would be read straight
        // back from the pending file and queued a second time.
        this.resumePendingFinalPasses();
        this.recoverUnfinishedRecording();
      }, 5000);
    } catch (error) {
      this.starting = false;
      logger.error("Application initialization failed", { error: error.message });
      app.quit();
    }
  }

  /** The overlay windows and shortcuts; created once, then only shown and hidden. */
  async startOverlay() {
    if (this.overlayCreated) {
      windowManager.showAllWindows();
      this.setupGlobalShortcuts();
      return;
    }
    // Small delay so desktop/display detection is accurate.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await windowManager.initializeWindows({ showMainWindow: true });
    this.overlayCreated = true;
    windowManager.setWindowGap(Number(settingsStore.get("windowGap")) || 10);
    this.setupGlobalShortcuts();
    this.updateAppIcon(this.appIcon);
    if (settingsStore.get("startClickThrough")) {
      windowManager.setInteractive(false);
    }
  }

  // ── Library-only mode ──
  //
  // MeetScribe without its overlay: only the browser manager's local server.
  // Entered by starting with --library (the shortcut in the transcript folder)
  // or with the power button in the library's header; left by starting
  // MeetScribe normally or with the same button in the library. It quits by itself once
  // the manager has been closed for a while and no final pass is running.

  /** Asked for from the library page itself, which stays open. */
  enterLibraryOnly() {
    if (transcriptionService.isRecording) return { ok: false, error: "Stop the recording first" };
    if (this.libraryOnly) return { ok: true };
    this.libraryOnly = true;
    globalShortcut.unregisterAll();
    windowManager.hideAllWindows();
    logger.info("Switched to library-only mode");
    managerServer.broadcast("status", { mode: "library" });
    return { ok: true };
  }

  async leaveLibraryOnly() {
    if (!this.libraryOnly) {
      windowManager.showAllWindows();
      return {};
    }
    this.libraryOnly = false;
    logger.info("Leaving library-only mode");
    await this.startOverlay();
    managerServer.broadcast("status", { mode: "app" });
    return {};
  }

  onManagerStopped() {
    if (!this.libraryOnly) return;
    // A phone may still be recording; this runs again when its link closes.
    if (managerServer.isRunning() || phoneServer.isRunning()) return;
    const pass = offlinePass.getStatus();
    if (pass.folder || (pass.queued || []).length) {
      // Finish the passes first; check again when the queue moves.
      if (!this.quitAfterPass) {
        this.quitAfterPass = () => {
          if (managerServer.isRunning()) return;
          const next = offlinePass.getStatus();
          if (!next.folder && !(next.queued || []).length) this.onManagerStopped();
        };
        for (const event of ["done", "failed", "cancelled"]) offlinePass.on(event, () => setTimeout(() => this.quitAfterPass(), 500));
      }
      return;
    }
    logger.info("Library closed; quitting library-only mode");
    this.quit();
  }

  /**
   * "Open MeetScribe Library" in the transcript folder: starts this app with
   * --library. Windows only (a .lnk); put back if it was deleted.
   */
  ensureLibraryShortcut() {
    if (process.platform !== "win32") return;
    try {
      const root = settingsStore.get("transcriptRoot");
      if (!root) return;
      fs.mkdirSync(root, { recursive: true });
      const link = path.join(root, "Open MeetScribe Library.lnk");
      // Packaged: the app's own exe. From source: electron.exe plus the app folder.
      const args = app.isPackaged ? "--library" : `"${app.getAppPath()}" --library`;
      const icon = path.join(__dirname, "assets", "brand", "icon.ico").replace("app.asar", "app.asar.unpacked");
      const options = {
        target: process.execPath,
        args,
        cwd: path.dirname(process.execPath),
        description: "Browse, play and edit your meetings without the MeetScribe overlay",
        icon: fs.existsSync(icon) ? icon : process.execPath,
        iconIndex: 0,
      };
      let current = null;
      try { current = shell.readShortcutLink(link); } catch (_) { /* missing */ }
      if (current && current.target === options.target && current.args === options.args) return;
      shell.writeShortcutLink(link, current ? "replace" : "create", options);
      logger.info("Library shortcut written to the transcript folder");
    } catch (error) {
      logger.warn("Could not write the library shortcut", { error: error.message });
    }
  }

  /**
   * Windows system-audio capture. Electron routes getDisplayMedia through this
   * handler; returning audio:'loopback' hands back the WASAPI loopback of the
   * default render endpoint — i.e. whatever the meeting app is playing.
   *
   * 'loopback' (not 'loopbackWithMute'): the user must keep hearing the call.
   * useSystemPicker is passed explicitly as false — toggling it has a known
   * bug where getDisplayMedia never resolves.
   */
  setupDisplayMediaHandler() {
    session.defaultSession.setDisplayMediaRequestHandler(
      async (request, callback) => {
        try {
          const sources = await desktopCapturer.getSources({
            types: ["screen"],
            thumbnailSize: { width: 1, height: 1 },
          });
          if (sources.length === 0) {
            logger.error("No screen source available for loopback audio");
            callback({});
            return;
          }
          callback({ video: sources[0], audio: "loopback" });
        } catch (error) {
          logger.error("Display media request failed", { error: error.message });
          callback({});
        }
      },
      { useSystemPicker: false }
    );
  }

  setupPermissions() {
    const appSession = session.defaultSession;
    const isTrustedAppContents = (webContents) => {
      if (!webContents || webContents.isDestroyed()) return false;
      try {
        const pagePath = path.resolve(fileURLToPath(webContents.getURL()));
        const appRoot = path.resolve(__dirname);
        const normalize = (value) =>
          process.platform === "win32" ? value.toLowerCase() : value;
        return normalize(pagePath).startsWith(normalize(appRoot + path.sep));
      } catch (_) {
        return false;
      }
    };

    appSession.setPermissionCheckHandler(
      (webContents, permission, _requestingOrigin, details = {}) => {
        if (!isTrustedAppContents(webContents)) return false;
        if (permission === "media") {
          return !details.mediaType || details.mediaType === "audio";
        }
        return permission === "display-capture";
      }
    );

    appSession.setPermissionRequestHandler(
      (webContents, permission, callback, details = {}) => {
        let granted = false;
        if (isTrustedAppContents(webContents)) {
          if (permission === "media") {
            const mediaTypes = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
            granted = mediaTypes.length === 0 || mediaTypes.includes("audio");
          } else {
            granted = permission === "display-capture";
          }
        }
        logger.debug("Permission request", {
          permission,
          mediaTypes: details.mediaTypes || [],
          granted,
        });
        callback(granted);
      }
    );
  }

  /**
   * System-wide shortcuts. Off by default: they take keys from every other
   * app while MeetScribe runs, and the defaults collide with meeting apps
   * (Teams mute and camera, Zoom mute and record) and with plain text editing
   * (Ctrl+Arrow, Ctrl+Shift+V/T/S). Settings → Appearance turns them on.
   */
  setupGlobalShortcuts() {
    globalShortcut.unregisterAll();
    if (!settingsStore.get("globalShortcuts")) {
      logger.info("Global shortcuts are off");
      return;
    }
    const shortcuts = {
      "CommandOrControl+Shift+R": () => this.toggleRecording(),
      "Alt+R": () => this.toggleRecording(),
      "CommandOrControl+Shift+S": () => this.captureMeetingScreenshot(),
      "CommandOrControl+Shift+V": () => windowManager.toggleVisibility(),
      "CommandOrControl+Shift+I": () => windowManager.toggleInteraction(),
      "Alt+A": () => windowManager.toggleInteraction(),
      "CommandOrControl+Shift+T": () => windowManager.toggleTranscriptWindow(),
      "CommandOrControl+Shift+O": () => this.openMeetingFolder(),
      "CommandOrControl+Shift+M": () => this.addMarker(),
      "CommandOrControl+,": () => this.showSettings(),
      "CommandOrControl+Up": () => windowManager.moveBoundWindows(0, -40),
      "CommandOrControl+Down": () => windowManager.moveBoundWindows(0, 40),
      "CommandOrControl+Left": () => windowManager.moveBoundWindows(-40, 0),
      "CommandOrControl+Right": () => windowManager.moveBoundWindows(40, 0),
    };

    Object.entries(shortcuts).forEach(([accelerator, handler]) => {
      const success = globalShortcut.register(accelerator, handler);
      if (!success) {
        logger.warn("Global shortcut could not be registered (already taken?)", { accelerator });
      }
    });
  }

  setupServiceEventHandlers() {
    // The browser manager marks meetings that are recording or being
    // transcribed, and refuses to touch them.
    libraryService.setBusyProvider(() => {
      const pass = offlinePass.getStatus();
      return {
        recordingFolder: transcriptionService.isRecording ? meetingService.folder : null,
        runningFolder: pass.folder,
        queuedFolders: pass.queued,
      };
    });
    // Deletes from the manager go to the Recycle Bin, never straight off the disk.
    libraryEdit.setTrash((target) => shell.trashItem(target));
    // Fire and forget: progress reaches the page as "final-pass" events.
    const rerunInBackground = (folder, overrides) => {
      this.rerunFinalPass(folder, overrides).then((result) => {
        if (!result.ok && !result.cancelled) {
          managerServer.broadcast("final-pass", { state: "failed", folder, message: `Final pass failed: ${result.error}` });
        }
      });
    };
    managerServer.setApi({
      status: () => ({
        recording: transcriptionService.isRecording,
        folder: meetingService.folder,
        finalPass: offlinePass.getStatus(),
        whisperReady: transcriptionService.isAvailable(),
        // "library": started with --library, no overlay windows.
        mode: this.libraryOnly ? "library" : "app",
        version: config.get("app.version"),
      }),
      models: () => this.listModels(),
      queue: () => offlinePass.getStatus(),
      rerun: rerunInBackground,
      cancelRunning: () => offlinePass.cancel(),
      dequeue: (folder) => offlinePass.dequeue(folder),
      reorder: (folder, delta) => offlinePass.reorder(folder, delta),
      settings: () => settingsStore.all(),
      saveSettings: (patch) => this.saveSettings(patch),
      profiles: () => this.listProfiles(),
      selectProfile: (id) => this.selectProfile(id),
      resetProfile: (id) => this.resetProfile(id),
      updateProfile: (id, values, meta) => this.updateProfile(id, values, meta),
      createProfile: (options) => this.createProfile(options),
      deleteProfile: (id) => this.deleteProfile(id),
      restoreBuiltinProfiles: () => this.restoreBuiltinProfiles(),
      downloadModel: (id, options) => this.downloadModel(id, options),
      deleteModel: (id) => this.deleteModel(id),
      cancelModel: (id) => modelStore.cancel(id),
      searchModels: (query) => modelStore.searchHub(query),
      openApp: () => this.leaveLibraryOnly(),
      libraryOnly: () => this.enterLibraryOnly(),
      phoneStatus: () => phoneServer.status(),
      phoneStart: (address) => phoneServer.start(address),
      phoneStop: () => phoneServer.stop(),
      phoneQr: () => phoneServer.qrSvg(),
    });
    // Library-only mode ends when the manager has been closed for a while.
    managerServer.on("stopped", () => this.onManagerStopped());

    // Recordings made on a phone arrive as imports and go to the final pass.
    phoneServer.setApi({
      whisperReady: () => transcriptionService.isAvailable(),
      rerun: rerunInBackground,
    });
    phoneServer.on("status", (status) => managerServer.broadcast("phone", status));
    phoneServer.on("received", () => managerServer.broadcast("library", { reason: "phone" }));
    phoneServer.on("stopped", () => this.onManagerStopped());
    // Everything the overlay hears about the final pass, the manager hears too.
    for (const event of ["progress", "queued", "done", "failed", "cancelled"]) {
      offlinePass.on(event, (payload) => {
        managerServer.broadcast("final-pass", {
          state: event === "progress" ? payload.state : event,
          ...payload,
          message:
            event === "done" ? "Final transcript ready"
              : event === "failed" ? `Final pass failed: ${payload.error}`
                : event === "cancelled" ? "Final pass cancelled"
                  : event === "queued" ? `Final pass queued (${payload.waiting} waiting)`
                    : payload.message,
        });
      });
    }
    modelStore.on("progress", (payload) => managerServer.broadcast("model-progress", payload));

    // Lets the writer hold an instantaneous event (screenshot, marker) until
    // speech that started earlier has come back from Whisper.
    meetingService.setPendingProvider(() => transcriptionService.oldestPendingStartedAt());

    transcriptionService.on("utterance", (utterance) => {
      meetingService.appendUtterance(utterance);
    });

    transcriptionService.on("status", (status) => {
      windowManager.broadcastToAllWindows("transcription-status", {
        status,
        ...transcriptionService.getStatus(),
      });
    });

    transcriptionService.on("error", (message) => {
      this.warnUser(message);
    });

    // Lines are broadcast only once they are actually on disk, so the UI order
    // always matches the file.
    meetingService.on("line", (entry) => {
      windowManager.broadcastToAllWindows("transcript-line", entry);
    });

    meetingService.on("write-error", (message) => {
      this.warnUser(`Could not write the transcript: ${message}`);
    });

    // The final pass runs for minutes after the meeting ends. Surface it, or it
    // looks like the app is idle while it is doing the most useful work it does.
    modelStore.on("progress", (payload) => {
      windowManager.broadcastToAllWindows("model-progress", payload);
      windowManager.sendToSetup("model-progress", payload);
    });

    offlinePass.on("progress", (payload) => {
      windowManager.broadcastToAllWindows("final-pass", { ...payload, running: true });
    });

    offlinePass.on("queued", (payload) => {
      windowManager.broadcastToAllWindows("final-pass", {
        state: "queued",
        running: true,
        message: `Final pass queued (${payload.waiting} waiting)`,
        ...payload,
      });
    });

    offlinePass.on("done", (payload) => {
      windowManager.broadcastToAllWindows("final-pass", {
        state: "done",
        pct: 1,
        running: false,
        message: "Final transcript ready",
        ...payload,
      });
    });

    offlinePass.on("failed", (payload) => {
      windowManager.broadcastToAllWindows("final-pass", {
        state: "failed",
        running: false,
        message: `Final pass failed: ${payload.error}`,
        ...payload,
      });
      this.warnUser(`Final pass failed: ${payload.error}`);
    });
  }

  // ── Recording lifecycle ──

  // ── Problems (Settings > Problems) ──

  problemsFile() {
    return settingsStore.userDataFile("problems.json");
  }

  listProblems() {
    if (!this.problems) {
      try {
        this.problems = problemLog.normalize(JSON.parse(fs.readFileSync(this.problemsFile(), "utf8")));
      } catch (_) {
        this.problems = []; // none yet, or unreadable
      }
    }
    return this.problems;
  }

  recordProblem(message) {
    const text = problemLog.redact(message, {
      transcriptRoot: settingsStore.get("transcriptRoot"),
      home: app.getPath("home"),
    });
    this.saveProblems(problemLog.add(this.listProblems(), text, Date.now()));
  }

  saveProblems(list) {
    this.problems = list;
    try {
      fs.writeFileSync(this.problemsFile(), JSON.stringify(list, null, 2), "utf8");
    } catch (error) {
      logger.error("Could not save the problem list", { error: error.message });
    }
    windowManager.broadcastToAllWindows("problems-changed", list);
  }

  /** The whole list as text, with what a bug report needs to make sense of it. */
  problemsText() {
    return problemLog.toText(
      this.listProblems(),
      `MeetScribe ${config.get("app.version")}, ${process.platform} ${process.getSystemVersion()}, Electron ${process.versions.electron}`
    );
  }

  /**
   * A warning for the user. While a recording is starting, warnings are held
   * and sent after "meeting-started", which clears the overlay's old warning;
   * sent before it they would be wiped at once and a recording that captures
   * nothing would look normal.
   */
  warnUser(message) {
    logger.warn(message);
    // Kept at once, so it is in Settings > Problems even if no window shows it.
    this.recordProblem(message);
    if (this.startWarnings) this.startWarnings.push(message);
    else windowManager.broadcastToAllWindows("transcription-error", { message });
  }

  /**
   * Start and stop each take seconds (capture, flushing Whisper, closing the
   * archive). A second press meanwhile used to start a "new" recording into
   * the same, still-closing meeting and empty its WAV files, so presses during
   * a transition are ignored.
   */
  async startRecording() {
    if (this.recordingTransition) {
      logger.info("Record ignored: a recording is still " + this.recordingTransition);
      return meetingService.getStatus();
    }
    if (transcriptionService.isRecording) return meetingService.getStatus();
    this.recordingTransition = "starting";
    this.startWarnings = [];
    try {
      return await this._startRecording();
    } finally {
      this.recordingTransition = null;
      const held = this.startWarnings || [];
      this.startWarnings = null;
      for (const message of held) windowManager.broadcastToAllWindows("transcription-error", { message });
    }
  }

  async _startRecording() {

    // Enrollment owns the microphone capture; starting a meeting now would
    // replace it, and the end of enrollment would then stop the meeting's audio.
    if (voiceService.isEnrolling()) {
      this.warnUser("Voice enrollment is still recording. Start the meeting when it has finished.");
      return null;
    }

    if (transcriptionService.isLiveEnabled() && !transcriptionService.isAvailable()) {
      this.warnUser("MeetScribe is not set up yet. The setup assistant is open; it takes a few minutes.");
      // Show the way instead of only describing it.
      windowManager.showSetup().catch(() => {});
      return null;
    }

    // With the live transcript off the final pass is the only transcript. If it
    // cannot run, say so now rather than leave a meeting with audio and no text.
    if (!transcriptionService.isLiveEnabled()) {
      const reason = !transcriptionService.isAvailable()
        ? "Whisper is not set up"
        : !settingsStore.get("offlinePassEnabled")
          ? "the final pass is turned off"
          : "";
      if (reason) {
        this.warnUser(
          `The live transcript is off and ${reason}, so this meeting will only be recorded as audio. ` +
          "Re-run the final pass later to get a transcript."
        );
      }
    }

    // Nothing is created until audio can be captured: a meeting that looks like
    // it is recording while it is not loses the whole meeting.
    const enabled = transcriptionService.getEnabledStreams();
    if (!enabled.system && !enabled.mic) {
      this.warnUser("NOT RECORDING: system audio and microphone are both turned off in Settings.");
      return null;
    }
    try {
      await windowManager.ensureAudioWindow();
    } catch (error) {
      logger.error("Recording refused: audio engine not ready", { error: error.message });
      this.warnUser("NOT RECORDING: MeetScribe is still starting. Press Record again in a moment.");
      return null;
    }

    let status;
    try {
      status = meetingService.start();
    } catch (error) {
      this.warnUser(`Could not create the meeting folder: ${error.message}`);
      return null;
    }

    // Start archiving before capture, so the recording covers the meeting from
    // its first chunk. A failure here must not stop the meeting — a live
    // transcript with no archive still beats no transcript at all.
    // With the live transcript off the archive is the only record, so it is kept regardless.
    if (settingsStore.get("archiveAudio") || !transcriptionService.isLiveEnabled()) {
      try {
        audioArchive.start(status.folder, {
          system: settingsStore.get("labelSystem") || "Them",
          mic: settingsStore.get("labelMic") || "You",
        });
        // Remembered until a clean stop: after a crash or a forced quit the
        // next launch finishes this meeting's archive and queues its final pass.
        settingsStore.update({ unfinishedRecording: status.folder });
      } catch (error) {
        this.warnUser(`Audio archiving is off for this meeting: ${error.message}`);
      }
    }

    transcriptionService.start();
    if (!(await this.startAudioCapture()) && !(await this.startAudioCapture())) {
      await this.abortRecording();
      return null;
    }
    this.startCaptureWatchdog();

    windowManager.handleRecordingStarted({
      showTranscript: settingsStore.get("showTranscriptOnRecord") !== false,
    });
    windowManager.broadcastToAllWindows("meeting-started", status);
    managerServer.broadcast("library", { reason: "meeting-started" });
    logger.info("Recording started", { folder: status.folder });
    return status;
  }

  /** Capture never started: close what was opened instead of pretending to record. */
  async abortRecording() {
    await this.stopAudioCapture();
    await transcriptionService.stop();
    await audioArchive.stop();
    const status = await meetingService.stop();
    settingsStore.update({ unfinishedRecording: "" });
    windowManager.handleRecordingStopped();
    windowManager.broadcastToAllWindows("meeting-stopped", status);
    managerServer.broadcast("library", { reason: "meeting-stopped" });
    logger.error("Recording aborted: no audio could be captured", { folder: status.folder });
    this.warnUser("NOT RECORDING: no audio could be captured. Check the audio devices and press Record again.");
  }

  /** While recording: restart capture when audio stops arriving, and say so. */
  startCaptureWatchdog() {
    this.stopCaptureWatchdog();
    this.captureWatchdog.start(Date.now());
    let restarts = 0;
    let busy = false;
    const timer = setInterval(async () => {
      if (busy || this.recordingTransition || !transcriptionService.isRecording) return;
      if (!this.captureWatchdog.check(Date.now())) return;
      busy = true;
      try {
        if (restarts >= MAX_CAPTURE_RESTARTS) {
          this.stopCaptureWatchdog();
          this.warnUser("NOT RECORDING: no audio is arriving. Stop and press Record again.");
          return;
        }
        restarts += 1;
        logger.error("No audio is arriving; restarting capture", { attempt: restarts });
        this.warnUser("No audio was arriving. Restarting the audio capture.");
        await this.startAudioCapture();
        if (this.watchdogTimer === timer) {
          // Give the new capture its full grace period.
          this.captureWatchdog.start(Date.now());
        } else if (!transcriptionService.isRecording) {
          // Stopped while capture was starting: do not leave it running.
          await this.stopAudioCapture();
        }
      } finally {
        busy = false;
      }
    }, WATCHDOG_INTERVAL_MS);
    this.watchdogTimer = timer;
  }

  stopCaptureWatchdog() {
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
    this.captureWatchdog.stop();
  }

  async stopRecording() {
    if (this.recordingTransition) {
      logger.info("Stop ignored: a recording is still " + this.recordingTransition);
      return meetingService.getStatus();
    }
    if (!transcriptionService.isRecording && !meetingService.isActive()) {
      return meetingService.getStatus();
    }
    this.recordingTransition = "stopping";
    // Straight away: flushing the last lines takes a few seconds, and a pill
    // that does not change invites a second press.
    windowManager.broadcastToAllWindows("recording-stopping", {});
    try {
      return await this._stopRecording();
    } finally {
      this.recordingTransition = null;
    }
  }

  async _stopRecording() {
    this.stopCaptureWatchdog();
    await this.stopAudioCapture();
    // Stop transcription after capture so buffered audio still gets flushed.
    await transcriptionService.stop();
    const events = meetingService.getEvents();
    const archive = await audioArchive.stop();
    const status = await meetingService.stop();
    settingsStore.update({ unfinishedRecording: "" });

    windowManager.handleRecordingStopped();
    windowManager.broadcastToAllWindows("meeting-stopped", status);
    managerServer.broadcast("library", { reason: "meeting-stopped" });
    logger.info("Recording stopped", { folder: status.folder });
    if (!archive && settingsStore.get("archiveAudio")) {
      this.warnUser("No audio was recorded in this meeting, so there is no final transcript.");
    }

    // The final pass runs in the background: it takes minutes, and nothing in
    // the app is waiting on it. The live transcript is already on disk.
    if (archive && settingsStore.get("offlinePassEnabled") && transcriptionService.isAvailable()) {
      this.runFinalPass({ folder: status.folder, meta: archive, events }).catch((error) =>
        logger.error("Final pass could not be started", { error: error.message })
      );
    }

    return status;
  }

  /**
   * The second pass over the archived audio. Broadcasts progress so the overlay
   * can show it, then compresses the archive once the transcript exists.
   */
  async runFinalPass(job) {
    if (this.isLiveFolder(job.folder)) {
      return { ok: false, error: "This meeting is still being recorded" };
    }
    // One per folder, FLAC step included: two would compress and delete the
    // same WAVs at the same time.
    const key = path.resolve(job.folder);
    const running = this.finalPasses.get(key);
    if (running) return running;
    const pass = this._runFinalPass(job).finally(() => this.finalPasses.delete(key));
    this.finalPasses.set(key, pass);
    return pass;
  }

  /** The meeting being recorded (or still being closed) right now. */
  isLiveFolder(folder) {
    if (!folder) return false;
    if (audioArchive.isRecordingTo(folder)) return true;
    return meetingService.isActive() && path.resolve(meetingService.folder) === path.resolve(folder);
  }

  async _runFinalPass({ folder, meta, events = [], overrides = {} }) {
    // Queued, never refused: a meeting that ends while another pass runs waits
    // its turn instead of silently never getting a final transcript.
    const paths = transcriptionService.getPaths();
    const result = await offlinePass.enqueue({ folder, meta, events, paths, overrides });

    if (result.ok) {
      await this.compressArchive(meta, paths);
    }
    return result;
  }

  /**
   * Shrink the archive once it has been transcribed. FLAC is lossless and
   * roughly halves it, which matters because the audio is kept precisely so a
   * better model can be run over it later.
   */
  async compressArchive(meta, paths) {
    const format = settingsStore.get("archiveFormat");
    if (!format || format === "wav") return;

    for (const entry of meta.streams || []) {
      // Only the WAVs the recorder wrote: an imported recording keeps its own
      // file (and for it the ".wav" -> ".flac" target would be the source itself).
      if (!/\.wav$/i.test(entry.path) || !fs.existsSync(entry.path)) continue;

      if (format === "none") {
        try {
          fs.rmSync(entry.path, { force: true });
          logger.info("Archived audio deleted after the final pass", { file: entry.path });
        } catch (error) {
          logger.warn("Could not delete archived audio", { error: error.message });
        }
        continue;
      }

      const target = entry.path.replace(/\.wav$/i, ".flac");
      try {
        const output = await this.runPythonScript(paths.python, paths.transcodeScript, [entry.path, target], paths.env);
        const parsed = JSON.parse(output.trim().split(/\r?\n/).pop() || "{}");
        // The script fails when the FLAC is shorter than the WAV; a WAV that
        // changed since then is still being written and must be kept too.
        const unchanged = parsed.ok && fs.statSync(entry.path).size === parsed.sourceBytes;
        if (parsed.ok && !unchanged) {
          logger.error("The WAV changed while it was compressed; keeping it", { file: entry.path });
        } else if (parsed.ok) {
          fs.rmSync(entry.path, { force: true });
          entry.path = target;
          logger.info("Archived audio compressed", {
            file: target,
            saved: `${Math.round((1 - parsed.bytes / parsed.sourceBytes) * 100)}%`,
          });
        } else {
          logger.warn("FLAC transcode failed; keeping the WAV", { error: parsed.error });
        }
      } catch (error) {
        logger.warn("FLAC transcode failed; keeping the WAV", { error: error.message });
      }
    }

    // meta.json points at the archive; keep it truthful after the rename.
    try {
      const metaPath = path.join(path.dirname(meta.streams[0].path), "meta.json");
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
    } catch (error) {
      logger.warn("Could not update archive meta.json", { error: error.message });
    }
  }

  runPythonScript(python, script, args, env) {
    return new Promise((resolve, reject) => {
      const { spawn } = require("child_process");
      const child = spawn(python, ["-u", script, ...args], { windowsHide: true, env });
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(out);
        else reject(new Error(`${path.basename(script)} exited with code ${code}`));
      });
    });
  }

  /**
   * Re-run the final pass on a meeting that was already recorded — after
   * editing its glossary.txt, or with a different model. This is the loop that
   * makes the archive worth keeping.
   */
  async rerunFinalPass(folder, overrides = {}) {
    try {
      const target = folder || meetingService.folder;
      if (!target) return { ok: false, error: "No meeting folder was given" };

      const metaPath = path.join(target, "audio", "meta.json");
      if (!fs.existsSync(metaPath)) {
        return { ok: false, error: "This meeting has no archived audio (audio/meta.json is missing)" };
      }
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));

      // Paths in meta.json are from the original recording; the folder may have
      // moved, and the WAVs may since have become FLACs.
      for (const entry of meta.streams || []) {
        const candidates = [
          entry.path,
          path.join(target, "audio", `${entry.stream}.flac`),
          path.join(target, "audio", `${entry.stream}.wav`),
          // Imported recordings keep their own name and format.
          entry.path ? path.join(target, "audio", path.basename(entry.path)) : null,
        ];
        const found = candidates.find((candidate) => candidate && fs.existsSync(candidate));
        if (found) entry.path = found;
      }

      let events = [];
      const eventsPath = path.join(target, "events.json");
      if (fs.existsSync(eventsPath)) {
        try {
          events = JSON.parse(fs.readFileSync(eventsPath, "utf8"));
        } catch (error) {
          logger.warn("Could not read events.json", { error: error.message });
        }
      }

      return await this.runFinalPass({ folder: target, meta, events, overrides });
    } catch (error) {
      logger.error("Re-run of the final pass failed", { error: error.message });
      return { ok: false, error: error.message };
    }
  }

  /**
   * A recording the app never stopped cleanly (crash, power loss, forced
   * quit): finish its archive description from the files on disk and queue
   * its final pass, which it would otherwise never get.
   */
  recoverUnfinishedRecording() {
    const folder = this.unfinishedAtLaunch;
    this.unfinishedAtLaunch = "";
    if (!folder || this.isLiveFolder(folder)) return;
    // A recording started meanwhile has put its own folder here; leave that one.
    if (settingsStore.get("unfinishedRecording") === folder) settingsStore.update({ unfinishedRecording: "" });
    try {
      const meta = audioArchive.recover(folder, {
        system: settingsStore.get("labelSystem") || "Them",
        mic: settingsStore.get("labelMic") || "You",
      });
      if (!meta) return;
      logger.warn("Recovered a recording that was not stopped cleanly", { streams: meta.streams.length });
      this.warnUser(
        "The last recording was cut off (the app closed while recording). Its audio is saved" +
          (settingsStore.get("offlinePassEnabled") && transcriptionService.isAvailable() ? " and its final transcript is being made." : "; re-run it from the Library.")
      );
      if (settingsStore.get("offlinePassEnabled") && transcriptionService.isAvailable()) {
        this.rerunFinalPass(folder).catch((error) => logger.error("Could not queue the recovered recording", { error: error.message }));
      }
    } catch (error) {
      logger.error("Could not recover the last recording", { error: error.message });
    }
  }

  /** Re-queue the passes that were queued or running when the app last quit. */
  resumePendingFinalPasses() {
    // Left on disk otherwise, so they resume once Whisper is set up again.
    if (!settingsStore.get("offlinePassEnabled") || !transcriptionService.isAvailable()) return;
    const pending = offlinePass.takePending();
    if (pending.length === 0) return;
    logger.info("Resuming pending final passes", { count: pending.length });
    for (const { folder, overrides } of pending) {
      this.rerunFinalPass(folder, overrides).then((result) => {
        if (!result.ok && !result.cancelled) {
          logger.warn("Skipped a pending final pass", { folder, error: result.error });
        }
      });
    }
  }

  // ── Models ──

  /** Catalog + cache state, each with its learned "minutes per 1 h meeting". */
  listModels() {
    const settings = settingsStore.all();
    const { modelDir } = transcriptionService.getPaths();
    const mode = settings.offlineMode === "quality" ? "quality" : "fast";
    const threads = Number(settings.offlineCpuThreads) || offlinePass.DEFAULT_CPU_THREADS;
    const rows = modelStore.list(modelDir, {
      live: settings.whisperModel,
      final: settings.offlineModel,
      diff: settings.offlineDiffModel,
    });
    return rows.map((row) => ({ ...row, estimate: speedStats.estimate(row.id, row, mode, threads) }));
  }

  downloadModel(id, options = {}) {
    try {
      // Progress and the outcome arrive as "model-progress" events.
      modelStore.download(id, transcriptionService.getPaths(), options).catch(() => {});
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  deleteModel(id) {
    const settings = settingsStore.all();
    const status = offlinePass.getStatus();
    try {
      return modelStore.remove(id, transcriptionService.getPaths().modelDir, {
        recording: transcriptionService.isRecording,
        liveModel: settings.whisperModel,
        finalRunning: status.running,
        // A re-run from the manager may be using its own model right now.
        finalModel: (status.overrides && status.overrides.model) || settings.offlineModel,
        diffModel: status.overrides && status.overrides.diffModel !== undefined ? status.overrides.diffModel : settings.offlineDiffModel,
      });
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  toggleRecording() {
    if (transcriptionService.isRecording) {
      this.stopRecording().catch((error) =>
        logger.error("Failed to stop recording", { error: error.message })
      );
    } else {
      this.startRecording().catch((error) =>
        logger.error("Failed to start recording", { error: error.message })
      );
    }
  }

  /**
   * Kick the hidden audio renderer into capturing. Invoked through
   * executeJavaScript with a synthetic user gesture — getDisplayMedia refuses
   * to run without transient activation, which a hidden window never has.
   */
  async startAudioCapture() {
    const enabled = transcriptionService.getEnabledStreams();
    try {
      const result = await windowManager.runInAudioWindow(
        `window.__startCapture(${JSON.stringify(enabled)})`
      );
      if (!result || (!result.system && !result.mic)) {
        logger.error("Audio capture started no stream", result || {});
        return null;
      }
      logger.info("Audio capture started", result);
      return result;
    } catch (error) {
      logger.error("Audio capture failed to start", { error: error.message });
      this.warnUser(`Could not start audio capture: ${error.message}.`);
      return null;
    }
  }

  async stopAudioCapture() {
    try {
      await windowManager.runInAudioWindow("window.__stopCapture()");
    } catch (error) {
      logger.warn("Audio capture stop failed", { error: error.message });
    }
  }

  // ── Screenshot ──

  async captureMeetingScreenshot() {
    try {
      // Never lose a shot because recording wasn't running.
      if (!meetingService.isActive()) meetingService.start();

      const at = new Date();
      const { imageBuffer } = await captureService.captureAndProcess();
      const saved = meetingService.saveScreenshot(imageBuffer, at);

      logger.info("Screenshot saved", { file: saved.path });
      return { ok: true, filename: saved.filename };
    } catch (error) {
      logger.error("Screenshot failed", { error: error.message });
      this.warnUser(`Screenshot failed: ${error.message}`);
      return { ok: false, error: error.message };
    }
  }

  addMarker(text = "") {
    if (!meetingService.isActive()) return { ok: false, error: "No meeting is recording" };
    meetingService.appendMarker(text);
    return { ok: true };
  }

  /** Start the manager's local server if needed and open it in the default browser. */
  async openManager() {
    try {
      const url = await managerServer.open();
      await shell.openExternal(url);
      return { ok: true };
    } catch (error) {
      logger.error("Could not open the manager", { error: error.message });
      return { ok: false, error: error.message };
    }
  }

  openMeetingFolder() {
    const folder = meetingService.folder || settingsStore.get("transcriptRoot");
    try {
      fs.mkdirSync(folder, { recursive: true });
      shell.openPath(folder);
      return { ok: true, folder };
    } catch (error) {
      logger.warn("Could not open meeting folder", { folder, error: error.message });
      return { ok: false, error: error.message };
    }
  }

  showSettings(page = null) {
    windowManager.showSettings();
    const settingsWindow = windowManager.getWindow("settings");
    if (settingsWindow) {
      setTimeout(() => {
        settingsWindow.webContents.send("load-settings", this.getSettings());
        if (page) settingsWindow.webContents.send("settings-open-page", page);
      }, 100);
    }
  }

  getSettings() {
    return {
      ...settingsStore.all(),
      audioInputs: this.audioDevices.inputs,
      whisper: transcriptionService.getStatus(),
      meeting: meetingService.getStatus(),
    };
  }

  saveSettings(patch) {
    const previous = settingsStore.all();
    // Edits under an active profile are not written into it any more: the
    // profile shows as "modified" (listProfiles().changed) until the user
    // saves, saves as new, or undoes.
    const next = settingsStore.update(patch);

    if ("globalShortcuts" in patch && patch.globalShortcuts !== previous.globalShortcuts && this.overlayCreated && !this.libraryOnly) {
      this.setupGlobalShortcuts();
    }

    if (patch.appIcon && patch.appIcon !== previous.appIcon) {
      this.updateAppIcon(patch.appIcon);
    }
    if (patch.transcriptRoot && patch.transcriptRoot !== previous.transcriptRoot) {
      this.ensureLibraryShortcut();
    }
    if (patch.windowGap !== undefined) {
      windowManager.setWindowGap(Number(patch.windowGap) || 10);
    }

    // Reconfigure the pipeline so model/VAD/label changes take effect without
    // a restart. Streams pick up new settings on their next start.
    transcriptionService.configure();
    // Skip the settings pane itself: it already has these values, and pushing
    // them back would rewrite fields under the user's cursor.
    windowManager.broadcastToAllWindows("load-settings", this.getSettings(), ["settings"]);
    managerServer.broadcast("settings", { reason: "saved" });
    return { ok: true, settings: next };
  }

  listProfiles() {
    const settings = settingsStore.all();
    const active = profiles.activeId(settings);
    const list = profiles.listProfiles(settings, settingsStore.defaults());
    const current = list.find((profile) => profile.id === active) || null;
    const hidden = Array.isArray(settings.hiddenProfiles) ? settings.hiddenProfiles : [];
    return { active, profiles: list, changed: profiles.changedKeys(current, settings), hiddenBuiltins: hidden.length };
  }

  selectProfile(id) {
    try {
      const settings = settingsStore.all();
      const { patch } = profiles.select(id, settings, settingsStore.defaults());
      this.saveSettings(patch);
      return { ok: true, settings: this.getSettings(), ...this.listProfiles() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  /** Store a profile change, then re-apply it if it is the active profile. */
  _profileChanged(id, patch) {
    const settings = settingsStore.all();
    settingsStore.update(patch);
    if (id && id === settings.activeProfile && profiles.getProfile(id, settingsStore.all())) return this.selectProfile(id);
    managerServer.broadcast("settings", { reason: "profile" });
    windowManager.broadcastToAllWindows("load-settings", this.getSettings());
    return { ok: true, ...this.listProfiles() };
  }

  /** Edit any profile's values (browser manager); the active one is applied at once. */
  updateProfile(id, values, meta = {}) {
    try {
      return this._profileChanged(id, profiles.update(id, values, settingsStore.all(), meta));
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  /**
   * A new profile of the user's own; `fromId` copies another profile, otherwise
   * the current settings. `values` (from the guided questions) go on top.
   */
  createProfile({ label, flag, fromId, activate, values }) {
    try {
      const settings = settingsStore.all();
      const source = fromId ? profiles.getProfile(fromId, settings, settingsStore.defaults()) : null;
      if (fromId && !source) throw new Error("Unknown profile: " + fromId);
      const base = source ? source.values : settings;
      const { id, patch } = profiles.create({ label, flag, values: { ...base, ...profiles.pick(values || {}) } }, settings);
      settingsStore.update(patch);
      if (activate) return { ...this.selectProfile(id), id };
      managerServer.broadcast("settings", { reason: "profile" });
      return { ok: true, id, ...this.listProfiles() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  /** Profile keys only, with the same checks as a settings change. Throws on a bad value. */
  _validProfileValues(values) {
    if (!values || typeof values !== "object") return null;
    const picked = profiles.pick(values);
    const { patch, errors } = settingsSchema.validatePatch(picked);
    if (errors.length) throw new Error(errors.join("; "));
    return patch;
  }

  deleteProfile(id) {
    try {
      return this._profileChanged(null, profiles.remove(id, settingsStore.all()));
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  /** Bring back built-in profiles the user deleted. */
  restoreBuiltinProfiles() {
    return this._profileChanged(null, profiles.restoreBuiltins());
  }

  resetProfile(id) {
    try {
      return this._profileChanged(id, profiles.reset(id, settingsStore.all()));
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  // ── Voice labels ──

  voicePaths() {
    const paths = transcriptionService.getPaths();
    voiceService.configure(paths);
    return paths;
  }

  async enrollVoice(seconds = 25) {
    if (transcriptionService.isRecording) return { ok: false, error: "Stop the recording first" };
    const say = (message) => windowManager.broadcastToAllWindows("voice-progress", message);
    try {
      this.voicePaths();
      voiceService.beginEnrollment();
      const started = await windowManager.runInAudioWindow(
        `window.__startCapture(${JSON.stringify({
          system: false,
          mic: true,
          systemSource: "loopback",
          micDeviceLabel: settingsStore.get("micDeviceLabel") || "",
        })})`
      );
      logger.info("Voice enrollment capture started", started);
      for (let left = seconds; left > 0; left--) {
        say(`Recording… speak normally, ${left} s left`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      await this.stopAudioCapture();
      say("Analysing your voice…");
      const result = await voiceService.finishEnrollment();
      say("Voice saved.");
      return result;
    } catch (error) {
      voiceService.cancelEnrollment();
      await this.stopAudioCapture();
      logger.warn("Voice enrollment failed", { error: error.message });
      say(error.message);
      return { ok: false, error: error.message };
    }
  }

  setupIPCHandlers() {
    ipcMain.handle("voice:status", () => {
      this.voicePaths();
      return voiceService.status();
    });
    ipcMain.handle("voice:setup", async () => {
      this.voicePaths();
      const forward = (line) => windowManager.broadcastToAllWindows("voice-progress", line);
      voiceService.on("progress", forward);
      try {
        return { ok: true, ...(await voiceService.setup()) };
      } catch (error) {
        return { ok: false, error: error.message };
      } finally {
        voiceService.off("progress", forward);
      }
    });
    ipcMain.handle("voice:enroll", (_event, seconds) => this.enrollVoice(Math.min(60, Math.max(15, Number(seconds) || 25))));
    ipcMain.handle("voice:delete", () => voiceService.deleteVoiceprint());
    ipcMain.handle("profiles:list", () => this.listProfiles());
    ipcMain.handle("profiles:select", (_event, id) => this.selectProfile(id));
    ipcMain.handle("profiles:reset", (_event, id) => this.resetProfile(id));
    ipcMain.handle("profiles:create", (_event, options = {}) => {
      try {
        return this.createProfile({
          label: String(options.label || ""),
          flag: String(options.flag || "custom"),
          fromId: options.fromId ? String(options.fromId) : null,
          activate: options.activate === true,
          values: this._validProfileValues(options.values),
        });
      } catch (error) {
        return { ok: false, error: error.message };
      }
    });
    ipcMain.handle("profiles:update", (_event, id, values, meta = {}) => {
      try {
        return this.updateProfile(String(id || ""), this._validProfileValues(values) || {}, {
          ...(meta && meta.label !== undefined && { label: String(meta.label) }),
          ...(meta && meta.flag !== undefined && { flag: String(meta.flag) }),
        });
      } catch (error) {
        return { ok: false, error: error.message };
      }
    });
    ipcMain.handle("profiles:delete", (_event, id) => this.deleteProfile(String(id || "")));
    ipcMain.handle("profiles:restore-builtins", () => this.restoreBuiltinProfiles());

    // ── Meeting ──
    ipcMain.handle("meeting:start", () => this.startRecording());
    ipcMain.handle("meeting:stop", () => this.stopRecording());
    ipcMain.handle("meeting:status", () => ({
      ...meetingService.getStatus(),
      recording: transcriptionService.isRecording,
    }));
    ipcMain.handle("meeting:open-folder", () => this.openMeetingFolder());
    ipcMain.handle("meeting:screenshot", () => this.captureMeetingScreenshot());
    ipcMain.handle("meeting:add-marker", (_event, text) => this.addMarker(text));
    ipcMain.handle("meeting:final-status", () => offlinePass.getStatus());
    ipcMain.handle("meeting:rerun-final", (_event, folder) => this.rerunFinalPass(folder));

    ipcMain.handle("manager:open", () => this.openManager());
    ipcMain.handle("glossaries:list", () => libraryService.projectGlossaries().map(({ name, terms, text }) => ({ name, terms, text })));

    ipcMain.handle("meeting:pick-and-rerun", async () => {
      const result = await dialog.showOpenDialog({
        title: "Pick a meeting folder to re-transcribe",
        defaultPath: settingsStore.get("transcriptRoot"),
        properties: ["openDirectory"],
      });
      if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
      // Fire and forget: this takes minutes and reports through 'final-pass'.
      this.rerunFinalPass(result.filePaths[0]).catch((error) =>
        logger.error("Re-run failed", { error: error.message })
      );
      return { ok: true, folder: result.filePaths[0] };
    });

    // ── Audio engine ──
    ipcMain.on("audio-chunk", (_event, data) => {
      if (data && data.buffer) {
        // Voice enrollment listens to the mic while no meeting is recording.
        if (data.streamId === "mic") voiceService.collect(Buffer.from(data.buffer));
        this.captureWatchdog.mark(Date.now());
        transcriptionService.ingest(data.streamId, Buffer.from(data.buffer));
      }
    });

    ipcMain.on("audio-level", (_event, data) => {
      windowManager.broadcastToAllWindows("audio-level", data);
    });

    ipcMain.on("audio-error", (_event, data) => {
      logger.error("Audio capture error", data);
      // Held while a recording starts, or "meeting-started" would clear it.
      this.warnUser(`${data.streamId === "system" ? "System audio" : "Microphone"}: ${data.message}`);
    });

    ipcMain.on("audio-started", (_event, info) => {
      logger.info("Audio stream started", info);
    });

    ipcMain.on("audio-stopped", (_event, info) => {
      logger.debug("Audio stream stopped", info);
    });

    ipcMain.on("audio:devices-enumerated", (_event, devices) => {
      this.audioDevices = devices || { inputs: [] };
    });

    ipcMain.handle("audio:list-devices", async () => {
      try {
        const devices = await windowManager.runInAudioWindow("window.__listDevices()");
        this.audioDevices = devices || { inputs: [] };
        return this.audioDevices;
      } catch (error) {
        logger.warn("Could not enumerate audio devices", { error: error.message });
        return { inputs: [] };
      }
    });

    // ── Settings ──
    ipcMain.handle("settings:get", () => this.getSettings());
    ipcMain.handle("settings:save", (_event, patch) => this.saveSettings(patch || {}));
    ipcMain.handle("show-settings", () => {
      this.showSettings();
      return { ok: true };
    });
    ipcMain.on("close-settings", () => windowManager.hideSettings());

    ipcMain.handle("settings:pick-folder", async () => {
      const window = windowManager.getWindow("settings");
      const result = await dialog.showOpenDialog(window, {
        title: "Choose where meeting transcripts are saved",
        defaultPath: settingsStore.get("transcriptRoot"),
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled || result.filePaths.length === 0) return { ok: false };
      return { ok: true, path: result.filePaths[0] };
    });

    ipcMain.handle("settings:pick-python", async () => {
      const window = windowManager.getWindow("settings");
      const result = await dialog.showOpenDialog(window, {
        title: "Select python.exe",
        properties: ["openFile"],
        filters: process.platform === "win32"
          ? [{ name: "Python", extensions: ["exe"] }]
          : [],
      });
      if (result.canceled || result.filePaths.length === 0) return { ok: false };
      return { ok: true, path: result.filePaths[0] };
    });

    // ── Whisper setup ──
    ipcMain.handle("whisper:status", () => transcriptionService.getStatus());

    // ── Updates ──
    ipcMain.handle("update:status", () => this.updateStatus());
    ipcMain.handle("update:check", () => this.checkForUpdates({ manual: true }));
    ipcMain.handle("update:install", () => {
      const result = this.installUpdate();
      if (result && result.ok === false) this.warnUser(result.error);
      return result;
    });
    ipcMain.handle("problems:list", () => this.listProblems());
    ipcMain.handle("problems:text", () => this.problemsText());
    ipcMain.handle("problems:clear", () => this.saveProblems([]));
    ipcMain.handle("problems:open-logs", () => shell.openPath(logDir));
    ipcMain.handle("models:list", () => this.listModels());
    ipcMain.handle("models:download", (_event, id) => this.downloadModel(id));
    ipcMain.handle("models:delete", (_event, id) => this.deleteModel(id));
    ipcMain.handle("models:cancel", (_event, id) => modelStore.cancel(id));

    // ── Setup assistant ──
    ipcMain.handle("setup:check", () => this.checkSetup());
    ipcMain.handle("setup:install-python", (event) => {
      const sender = event.sender;
      return this.installPython((line) => {
        try { sender.send("install-progress", line); } catch (_) { /* window gone */ }
      });
    });
    ipcMain.handle("setup:open", async () => {
      await windowManager.showSetup();
      return { ok: true };
    });
    ipcMain.handle("setup:complete", () => {
      settingsStore.update({ setupCompleted: true });
      windowManager.broadcastToAllWindows("load-settings", this.getSettings());
      return { ok: true };
    });
    ipcMain.on("setup:close", () => windowManager.closeSetup());
    // The overlay's warning: the assistant while Whisper is missing, else the full text.
    ipcMain.handle("show-help-for-warning", async (_event, kind) => {
      if (kind === "setup" && !transcriptionService.getStatus().configured) await windowManager.showSetup();
      else this.showSettings("problems");
      return { ok: true };
    });

    ipcMain.handle("whisper:install", async (event, options = {}) => {
      const sender = event.sender;
      const send = (line) => {
        try { sender.send("install-progress", line); } catch (_) { /* window gone */ }
      };
      return this.runWhisperSetup(options, send);
    });

    // ── Windows ──
    ipcMain.handle("resize-window", (_event, { width, height }) => {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow) {
        const minW = 60;
        const maxW = windowManager.windowConfigs?.main?.width || 520;
        const clampedWidth = Math.max(minW, Math.min(maxW, Math.round(width || minW)));
        try {
          mainWindow.setContentSize(Math.max(1, clampedWidth), Math.max(1, Math.round(height)));
        } catch (_) {
          mainWindow.setSize(Math.max(1, clampedWidth), Math.max(1, Math.round(height)));
        }
      }
      return { success: true };
    });

    ipcMain.handle("move-window", (_event, { deltaX, deltaY }) => {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow) {
        const [x, y] = mainWindow.getPosition();
        mainWindow.setPosition(x + deltaX, y + deltaY);
      }
      return { success: true };
    });

    ipcMain.handle("move-bound-windows", (_event, { deltaX, deltaY }) => {
      windowManager.moveBoundWindows(deltaX, deltaY);
      return windowManager.getWindowBindingStatus();
    });

    ipcMain.handle("resize-transcript-window", (_event, metrics) => {
      windowManager.resizeTranscriptWindow(metrics);
      return { success: true };
    });

    ipcMain.handle("window:toggle-transcript", () => ({
      visible: windowManager.toggleTranscriptWindow(),
    }));

    ipcMain.handle("window:toggle-interaction", () => ({
      interactive: windowManager.toggleInteraction(),
    }));

    ipcMain.handle("enable-window-interaction", () => {
      windowManager.setInteractive(true);
      return windowManager.getWindowStats();
    });

    ipcMain.handle("disable-window-interaction", () => {
      windowManager.setInteractive(false);
      return windowManager.getWindowStats();
    });

    ipcMain.handle("show-all-windows", () => {
      windowManager.showAllWindows();
      return windowManager.getWindowStats();
    });

    ipcMain.handle("hide-all-windows", () => {
      windowManager.hideAllWindows();
      return windowManager.getWindowStats();
    });

    ipcMain.handle("get-window-stats", () => windowManager.getWindowStats());
    ipcMain.handle("set-window-gap", (_event, gap) => windowManager.setWindowGap(gap));

    ipcMain.handle("close-window", (event) => {
      windowManager.windows.forEach((win) => {
        if (!win.isDestroyed() && win.webContents === event.sender) win.hide();
      });
      return { success: true };
    });

    // ── App ──
    ipcMain.handle("copy-to-clipboard", (_event, text) => {
      try {
        clipboard.writeText(String(text ?? ""));
        return true;
      } catch (error) {
        logger.error("Failed to write to clipboard", { error: error.message });
        return false;
      }
    });

    ipcMain.handle("update-app-icon", (_event, iconKey) => {
      settingsStore.update({ appIcon: iconKey });
      return this.updateAppIcon(iconKey);
    });


    // Click-through lets clicks pass the overlay, its own dot included. Hovering
    // the dot catches clicks again for as long as the pointer is on it, so
    // click-through can be turned off with the mouse (no shortcut needed).
    ipcMain.on("overlay:dot-hover", (_event, hovering) => windowManager.setDotHover(Boolean(hovering)));
    // What a quit or restart would interrupt, so Settings can ask first.
    ipcMain.handle("app:busy", () => this.busyState());
    ipcMain.handle("restart-app-for-stealth", async () => {
      logger.info("Restart requested");
      // Through the normal quit, not app.exit(): that skipped closing the
      // recording, the transcript and the final-pass process.
      await this.finishRecordingBeforeQuit();
      app.relaunch();
      this.quit();
    });

    ipcMain.on("main-window-ready", () => {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("transcription-status", {
          status: transcriptionService.isAvailable() ? "Ready" : "Whisper not set up",
          ...transcriptionService.getStatus(),
        });
      }
    });

    ipcMain.handle("quit-app", async () => {
      logger.info("Quit requested");
      await this.finishRecordingBeforeQuit();
      this.quit();
    });

    ipcMain.on("quit-app", async () => {
      logger.info("Quit requested");
      await this.finishRecordingBeforeQuit();
      this.quit();
    });
  }

  /**
   * Run scripts/setup-whisper.js, streaming its output to the settings pane.
   * The script prints "OK <python path>" on success, which becomes the stored
   * interpreter path.
   */
  runWhisperSetup(options, send) {
    return new Promise((resolve) => {
      const { spawn } = require("child_process");
      const scriptPath = this._unpackedPath(path.join(__dirname, "scripts", "setup-whisper.js"));
      const args = [
        scriptPath,
        "--model",
        options.model || settingsStore.get("whisperModel") || "small",
        "--data-dir",
        app.getPath("userData"),
      ];
      if (options.gpu) args.push("--gpu");
      // The setup assistant downloads models itself, with progress and cancel.
      if (options.noModel) args.push("--no-model");

      send(`Running setup (this can take several minutes)...`);

      // process.execPath is the Electron binary; ELECTRON_RUN_AS_NODE makes it
      // behave as plain Node, so no separate Node install is required.
      const child = spawn(process.execPath, args, {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        windowsHide: true,
      });

      let pythonPath = null;
      // The script's own "ERROR ..." line says what to do; the exit code does not.
      let lastError = null;
      const handle = (chunk) => {
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          send(line);
          const match = line.match(/^OK (.+)$/);
          if (match) pythonPath = match[1].trim();
          const failure = line.match(/^ERROR (.+)$/);
          if (failure) lastError = failure[1].trim();
        }
      };

      child.stdout.on("data", handle);
      child.stderr.on("data", handle);

      child.on("error", (error) => {
        send(`ERROR ${error.message}`);
        resolve({ ok: false, message: error.message });
      });

      child.on("close", (code) => {
        if (code === 0 && pythonPath) {
          settingsStore.update({ whisperPython: pythonPath });
          transcriptionService.configure();
          send("Whisper is ready.");
          resolve({ ok: true, python: pythonPath });
        } else {
          const message = lastError || `Setup exited with code ${code}`;
          send(`Setup failed: ${message}`);
          resolve({ ok: false, message });
        }
      });
    });
  }

  /** What is installed already, from `setup-whisper.js --check`. */
  checkSetup() {
    return new Promise((resolve) => {
      const { spawn } = require("child_process");
      const scriptPath = this._unpackedPath(path.join(__dirname, "scripts", "setup-whisper.js"));
      const child = spawn(process.execPath, [scriptPath, "--check", "--data-dir", app.getPath("userData")], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        windowsHide: true,
      });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk.toString(); });
      child.on("error", (error) => resolve({ ok: false, error: error.message }));
      child.on("close", () => {
        const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith("CHECK "));
        if (!line) return resolve({ ok: false, error: "The setup check gave no answer" });
        try {
          const result = JSON.parse(line.slice("CHECK ".length));
          resolve({ ok: true, ...result, configured: transcriptionService.getStatus().configured });
        } catch (error) {
          resolve({ ok: false, error: error.message });
        }
      });
    });
  }

  /**
   * Install Python 3.12 for this user with winget (no admin prompt), streaming
   * its output. setup-whisper.js finds it by its install path afterwards, so
   * MeetScribe does not need a restart to pick up the new PATH.
   */
  installPython(send) {
    return new Promise((resolve) => {
      const { spawn } = require("child_process");
      const args = [
        "install", "-e", "--id", "Python.Python.3.12", "--scope", "user", "--silent",
        "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity",
      ];
      send("$ winget " + args.join(" "));
      const child = spawn("winget", args, { windowsHide: true });
      let lastLine = "";
      const handle = (chunk) => {
        // winget redraws a spinner and a bar with \r and block characters.
        for (const raw of chunk.toString().split(/[\r\n]+/)) {
          const line = raw.replace(/[\u2580-\u259F|/\\-]{3,}/g, "").replace(/\s+/g, " ").trim();
          if (line.length < 3 || line === lastLine) continue;
          lastLine = line;
          send(line);
        }
      };
      child.stdout.on("data", handle);
      child.stderr.on("data", handle);
      child.on("error", (error) => resolve({ ok: false, error: "winget could not start: " + error.message }));
      child.on("close", (code) => {
        // 0 = installed; this one = already installed (no newer version).
        if (code === 0 || code === -1978335189) return resolve({ ok: true });
        resolve({ ok: false, error: `winget exited with code ${code}` });
      });
    });
  }

  /** On first launch, or from the overlay warning while Whisper is missing. */
  async openSetupIfNeeded() {
    if (settingsStore.get("setupCompleted")) return false;
    if (transcriptionService.getStatus().configured) {
      // Set up before the assistant existed: nothing to walk through.
      settingsStore.update({ setupCompleted: true });
      return false;
    }
    await windowManager.showSetup();
    return true;
  }

  _unpackedPath(candidate) {
    const unpacked = candidate.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    return fs.existsSync(unpacked) ? unpacked : candidate;
  }

  onWindowAllClosed() {
    if (this.libraryOnly) return;
    if (process.platform !== "darwin") app.quit();
  }

  onActivate() {
    if (!this.isReady && !this.starting) {
      this.onAppReady();
    } else if (this.isReady) {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow && mainWindow.isVisible()) {
        windowManager.showOnCurrentDesktop(mainWindow);
      }
    }
  }

  onWillQuit() {
    globalShortcut.unregisterAll();
    // Close the transcript file before the process goes away so a quit during
    // a meeting still leaves a complete, closed file.
    // Patch the WAV headers before the process goes away, so a quit mid-meeting
    // still leaves a playable archive rather than a truncated one.
    audioArchive.stopSync();
    offlinePass.shutdown();
    meetingService.shutdown();
    transcriptionService.shutdown();
    phoneServer.stop("quit");
    managerServer.stop();
    voiceService.shutdown();
    windowManager.destroyAllWindows();
    logger.info("Application shutting down");
  }

  /** What quitting now would interrupt. */
  busyState() {
    const pass = offlinePass.getStatus();
    return {
      recording: Boolean(transcriptionService.isRecording || meetingService.isActive()),
      finalPass: Boolean(pass && pass.running),
    };
  }

  /**
   * Stop a running recording the normal way before quitting, so its archive is
   * closed and described and its final pass is queued (and resumes on the next
   * launch). Bounded: a quit must not hang on a stuck worker.
   */
  async finishRecordingBeforeQuit() {
    if (!transcriptionService.isRecording && !this.recordingTransition) return;
    try {
      await Promise.race([
        this.recordingTransition ? new Promise((resolve) => setTimeout(resolve, 8000)) : this.stopRecording(),
        new Promise((resolve) => setTimeout(resolve, 8000)),
      ]);
    } catch (error) {
      logger.error("Could not stop the recording before quitting", { error: error.message });
    }
  }

  quit() {
    try {
      audioArchive.stopSync();
      offlinePass.shutdown();
      meetingService.shutdown();
      transcriptionService.shutdown();
      phoneServer.stop("quit");
      managerServer.stop();
      voiceService.shutdown();
      windowManager.destroyAllWindows();
      globalShortcut.unregisterAll();
      app.quit();
      setTimeout(() => process.exit(0), 2000);
    } catch (error) {
      logger.error("Error during quit", { error: error.message });
      process.exit(1);
    }
  }

  // ── Auto-update (installed builds only; GitHub Releases) ──

  /**
   * Where updating stands, for Settings and the overlay:
   * { state: idle|checking|none|downloading|ready|error|unsupported, current,
   *   version, percent, error, checkedAt }
   */
  updateStatus() {
    if (!this.update) this.update = { state: "idle", current: app.getVersion() };
    return { ...this.update };
  }

  _setUpdate(patch) {
    this.update = { ...this.updateStatus(), ...patch };
    windowManager.broadcastToAllWindows("update-status", this.update);
    windowManager.sendToSetup && windowManager.sendToSetup("update-status", this.update);
  }

  /** electron-updater, wired once. Null where updating cannot work (not installed, not Windows). */
  _updater() {
    if (this.updater !== undefined) return this.updater;
    this.updater = null;
    if (!app.isPackaged || process.platform !== "win32") return null;
    try {
      const { autoUpdater } = require("electron-updater");
      autoUpdater.logger = null;
      autoUpdater.autoDownload = true;
      // An update that finished downloading still installs on a normal quit.
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.on("checking-for-update", () => this._setUpdate({ state: "checking", error: null }));
      autoUpdater.on("update-not-available", () => this._setUpdate({ state: "none", checkedAt: Date.now() }));
      autoUpdater.on("update-available", (info) => {
        logger.info("Update available", { version: info.version });
        this._setUpdate({ state: "downloading", version: info.version, percent: 0, checkedAt: Date.now() });
      });
      autoUpdater.on("download-progress", (progress) => {
        this._setUpdate({ state: "downloading", percent: Math.round(progress.percent || 0) });
      });
      autoUpdater.on("update-downloaded", (info) => {
        logger.info("Update downloaded", { version: info.version });
        this._setUpdate({ state: "ready", version: info.version, percent: 100 });
      });
      autoUpdater.on("error", (error) => {
        logger.warn("Auto-update failed", { error: error.message });
        this._setUpdate({ state: "error", error: friendlyUpdateError(error), checkedAt: Date.now() });
      });
      this.updater = autoUpdater;
    } catch (error) {
      logger.warn("Auto-update unavailable", { error: error.message });
    }
    return this.updater;
  }

  /**
   * Look for a newer release on GitHub and download it in the background.
   * On launch and every few hours while "check for updates" is on; any time
   * from Settings' "Check now".
   */
  checkForUpdates({ manual = false } = {}) {
    const updater = this._updater();
    if (!updater) {
      this._setUpdate({ state: "unsupported", error: "Updates work in the installed app (MeetScribe-Setup), not when run from the source." });
      return this.updateStatus();
    }
    if (!manual && !settingsStore.get("autoUpdate")) {
      logger.info("Auto-update disabled in settings");
      return this.updateStatus();
    }
    // Already found and downloaded, or downloading: nothing new to ask.
    if (["ready", "downloading", "checking"].includes(this.updateStatus().state)) return this.updateStatus();
    updater.checkForUpdates().catch((error) => {
      logger.warn("Update check failed", { error: error.message });
      this._setUpdate({ state: "error", error: friendlyUpdateError(error), checkedAt: Date.now() });
    });
    if (!this.updateTimer) {
      // The app runs for days; a check only at launch would miss releases.
      this.updateTimer = setInterval(() => this.checkForUpdates(), 4 * 60 * 60 * 1000);
      this.updateTimer.unref && this.updateTimer.unref();
    }
    return this.updateStatus();
  }

  /** Restart into the downloaded update; never in the middle of a meeting. */
  installUpdate() {
    if (this.updateStatus().state !== "ready" || !this.updater) return { ok: false, error: "No update is ready yet" };
    if (transcriptionService.isRecording || meetingService.isActive()) {
      return { ok: false, error: "Stop the recording first; the update installs in a few seconds after that." };
    }
    logger.info("Installing update", { version: this.update.version });
    // Silent install, then start the new version. The normal quit path runs first.
    setImmediate(() => this.updater.quitAndInstall(true, true));
    return { ok: true };
  }

  // ── Disguise (icon + process name) ──

  updateAppIcon(iconKey) {
    try {
      const iconPaths = {
        terminal: "assests/icons/terminal.png",
        activity: "assests/icons/activity.png",
        settings: "assests/icons/settings.png",
      };
      const appNames = {
        terminal: "Terminal ",
        activity: "Activity Monitor ",
        settings: "System Settings ",
      };

      const iconPath = iconPaths[iconKey];
      const appName = appNames[iconKey];
      if (!iconPath) {
        logger.error("Invalid icon key", { iconKey });
        return { success: false, error: "Invalid icon key" };
      }

      const fullIconPath = path.resolve(__dirname, iconPath);
      if (!fs.existsSync(fullIconPath)) {
        logger.error("Icon file not found", { iconKey, iconPath: fullIconPath });
        return { success: false, error: "Icon file not found" };
      }

      if (process.platform === "darwin") {
        if (app.dock) {
          app.dock.setIcon(fullIconPath);
          const retry = () => {
            try { app.dock.setIcon(fullIconPath); } catch (_) { /* no dock */ }
          };
          setTimeout(retry, 100);
          setTimeout(retry, 500);
        }
      } else {
        windowManager.windows.forEach((window) => {
          if (window && !window.isDestroyed()) window.setIcon(fullIconPath);
        });
      }

      this.updateAppName(appName, iconKey);
      this.appIcon = iconKey;
      logger.info("App icon and name updated", { iconKey, appName });
      return { success: true };
    } catch (error) {
      logger.error("Failed to update app icon", { error: error.message });
      return { success: false, error: error.message };
    }
  }

  updateAppName(appName, iconKey) {
    try {
      process.title = appName;

      if (process.platform === "darwin") {
        app.setName(appName);
        if (app.dock) {
          app.dock.setBadge("");
          setTimeout(() => {
            app.dock.setIcon(path.resolve(__dirname, `assests/icons/${iconKey}.png`));
          }, 50);
        }
      }

      if (process.platform === "win32") {
        app.setAppUserModelId(`${appName.trim()}-${iconKey}`);
      }

      windowManager.windows.forEach((window) => {
        if (window && !window.isDestroyed()) window.setTitle(appName.trim());
      });

      // The name doesn't always stick on the first try; re-apply a few times.
      [50, 100, 200, 500].forEach((delay) => {
        setTimeout(() => {
          process.title = appName;
          if (process.platform === "darwin") app.setName(appName);
        }, delay);
      });
    } catch (error) {
      logger.error("Failed to update app name", { error: error.message });
    }
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  const controller = new ApplicationController();
  app.on("second-instance", (_event, argv) => controller.handleSecondInstance(argv));
}
