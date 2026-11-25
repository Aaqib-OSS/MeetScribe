const { contextBridge, ipcRenderer } = require('electron');

/**
 * Wrap an ipcRenderer listener so callers get a disposer back.
 * Renderers that re-subscribe (the transcript list, the settings panes) would
 * otherwise leak listeners with no way to detach.
 */
function on(channel, callback) {
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Meeting lifecycle ──
  startMeeting: () => ipcRenderer.invoke('meeting:start'),
  stopMeeting: () => ipcRenderer.invoke('meeting:stop'),
  getMeetingStatus: () => ipcRenderer.invoke('meeting:status'),
  openMeetingFolder: () => ipcRenderer.invoke('meeting:open-folder'),
  takeScreenshot: () => ipcRenderer.invoke('meeting:screenshot'),
  addMarker: (text) => ipcRenderer.invoke('meeting:add-marker', text),
  getFinalPassStatus: () => ipcRenderer.invoke('meeting:final-status'),
  rerunFinalPass: (folder) => ipcRenderer.invoke('meeting:rerun-final', folder),
  pickAndRerunFinalPass: () => ipcRenderer.invoke('meeting:pick-and-rerun'),
  openManager: () => ipcRenderer.invoke('manager:open'),
  listGlossaries: () => ipcRenderer.invoke('glossaries:list'),

  // ── Audio engine (called from the hidden capture renderer) ──
  sendAudioChunk: (streamId, buffer) => ipcRenderer.send('audio-chunk', { streamId, buffer }),
  sendAudioLevel: (streamId, rms) => ipcRenderer.send('audio-level', { streamId, rms }),
  reportAudioError: (streamId, name, message) =>
    ipcRenderer.send('audio-error', { streamId, name, message }),
  reportAudioStarted: (info) => ipcRenderer.send('audio-started', info),
  reportAudioStopped: (streamId) => ipcRenderer.send('audio-stopped', { streamId }),
  listAudioDevices: () => ipcRenderer.invoke('audio:list-devices'),
  setAudioDevices: (devices) => ipcRenderer.send('audio:devices-enumerated', devices),

  // ── Settings ──
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  getVoiceStatus: () => ipcRenderer.invoke('voice:status'),
  setupVoice: () => ipcRenderer.invoke('voice:setup'),
  enrollVoice: (seconds) => ipcRenderer.invoke('voice:enroll', seconds),
  deleteVoice: () => ipcRenderer.invoke('voice:delete'),
  onVoiceProgress: (cb) => on('voice-progress', cb),
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  selectProfile: (id) => ipcRenderer.invoke('profiles:select', id),
  resetProfile: (id) => ipcRenderer.invoke('profiles:reset', id),
  createProfile: (options) => ipcRenderer.invoke('profiles:create', options),
  updateProfile: (id, values, meta) => ipcRenderer.invoke('profiles:update', id, values, meta),
  deleteProfile: (id) => ipcRenderer.invoke('profiles:delete', id),
  restoreBuiltinProfiles: () => ipcRenderer.invoke('profiles:restore-builtins'),
  pickFolder: () => ipcRenderer.invoke('settings:pick-folder'),
  pickPython: () => ipcRenderer.invoke('settings:pick-python'),
  showSettings: () => ipcRenderer.invoke('show-settings'),
  closeSettings: () => ipcRenderer.send('close-settings'),

  // ── Whisper setup ──
  getWhisperStatus: () => ipcRenderer.invoke('whisper:status'),
  installWhisper: (options) => ipcRenderer.invoke('whisper:install', options),
  getUpdateStatus: () => ipcRenderer.invoke('update:status'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (cb) => on('update-status', cb),
  checkSetup: () => ipcRenderer.invoke('setup:check'),
  installPython: () => ipcRenderer.invoke('setup:install-python'),
  openSetup: () => ipcRenderer.invoke('setup:open'),
  completeSetup: () => ipcRenderer.invoke('setup:complete'),
  closeSetup: () => ipcRenderer.send('setup:close'),
  showHelpForWarning: (kind) => ipcRenderer.invoke('show-help-for-warning', kind),
  listModels: () => ipcRenderer.invoke('models:list'),
  downloadModel: (id) => ipcRenderer.invoke('models:download', id),
  deleteModel: (id) => ipcRenderer.invoke('models:delete', id),
  cancelModelDownload: (id) => ipcRenderer.invoke('models:cancel', id),
  onModelProgress: (cb) => on('model-progress', cb),

  // ── Windows ──
  resizeWindow: (width, height) => ipcRenderer.invoke('resize-window', { width, height }),
  moveWindow: (deltaX, deltaY) => ipcRenderer.invoke('move-window', { deltaX, deltaY }),
  moveBoundWindows: (deltaX, deltaY) => ipcRenderer.invoke('move-bound-windows', { deltaX, deltaY }),
  toggleTranscript: () => ipcRenderer.invoke('window:toggle-transcript'),
  toggleInteraction: () => ipcRenderer.invoke('window:toggle-interaction'),
  enableWindowInteraction: () => ipcRenderer.invoke('enable-window-interaction'),
  disableWindowInteraction: () => ipcRenderer.invoke('disable-window-interaction'),
  showAllWindows: () => ipcRenderer.invoke('show-all-windows'),
  hideAllWindows: () => ipcRenderer.invoke('hide-all-windows'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  getWindowStats: () => ipcRenderer.invoke('get-window-stats'),
  setWindowGap: (gap) => ipcRenderer.invoke('set-window-gap', gap),
  resizeTranscriptForContent: (metrics) => ipcRenderer.invoke('resize-transcript-window', metrics),

  // ── App ──
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
  updateAppIcon: (iconKey) => ipcRenderer.invoke('update-app-icon', iconKey),
  listProblems: () => ipcRenderer.invoke('problems:list'),
  getProblemsText: () => ipcRenderer.invoke('problems:text'),
  clearProblems: () => ipcRenderer.invoke('problems:clear'),
  openLogFolder: () => ipcRenderer.invoke('problems:open-logs'),
  onProblemsChanged: (cb) => on('problems-changed', cb),
  onSettingsOpenPage: (cb) => on('settings-open-page', cb),
  restartAppForStealth: () => ipcRenderer.invoke('restart-app-for-stealth'),
  quitApp: () => ipcRenderer.invoke('quit-app'),
  dotHover: (hovering) => ipcRenderer.send('overlay:dot-hover', hovering),
  getBusyState: () => ipcRenderer.invoke('app:busy'),

  // ── Events (each returns a disposer) ──
  onTranscriptLine: (cb) => on('transcript-line', cb),
  onMeetingStarted: (cb) => on('meeting-started', cb),
  onMeetingStopped: (cb) => on('meeting-stopped', cb),
  onRecordingState: (cb) => on('recording-state', cb),
  onRecordingStopping: (cb) => on('recording-stopping', cb),
  onTranscriptionStatus: (cb) => on('transcription-status', cb),
  onTranscriptionError: (cb) => on('transcription-error', cb),
  onAudioLevel: (cb) => on('audio-level', cb),
  onAudioStartRequest: (cb) => on('audio-start-request', cb),
  onAudioStopRequest: (cb) => on('audio-stop-request', cb),
  onInteractionModeChanged: (cb) => on('interaction-mode-changed', cb),
  onLoadSettings: (cb) => on('load-settings', cb),
  onSettingsWindowShown: (cb) => on('settings-window-shown', cb),
  onInstallProgress: (cb) => on('install-progress', cb),
  onMainWindowShown: (cb) => on('main-window-shown', cb),
  onFinalPass: (cb) => on('final-pass', cb),

  notifyMainWindowReady: () => ipcRenderer.send('main-window-ready')
});
