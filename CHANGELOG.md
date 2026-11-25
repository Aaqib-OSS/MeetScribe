# Changelog

All notable changes to this project are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [SemVer](https://semver.org/).

## [Unreleased]

## [1.7.0] - 2026-11-25

### Added

- Settings → Problems lists every warning in full, with Copy for one, Copy all (version included, your user folder and meeting names left out), Clear and Open log folder. The list survives a restart.
- While recording, MeetScribe restarts the audio capture when no audio arrives, and warns. Stopping a meeting without any audio says why there is no final transcript.

### Changed

- A warning on the overlay bar is a short "Problem" chip (a red "NOT RECORDING" when nothing is recorded) instead of a cut-off sentence. Click it to read and copy the full text in Settings → Problems.

### Fixed

- Pressing Record within the first seconds after launch could make crash recovery treat the live meeting as a crashed one, compress its first second and delete the audio still being recorded. Recovery only touches the recording left by the previous run, and a meeting being recorded is never given a final pass.
- A recording whose audio capture could not start looked like it was recording. Record is refused, or stopped at once, with a "NOT RECORDING" warning.
- Record was clickable before the audio engine was ready on a slow start. The audio engine now starts first.
- A WAV is deleted only when its FLAC holds all of the audio, and only one final pass per meeting runs at a time.

## [1.6.0] - 2026-11-21

### Added

- Settings → Recording shows your version and what the updater is doing (up to date, downloading with a progress bar, an error, or ready), with a "Check for updates" button and "Restart to update". A downloaded update shows as a green "Update to x.y.z" button on the overlay bar. MeetScribe checks again every 4 hours while it runs and never restarts into an update while recording.
- Setting "Keyboard shortcuts that work in every app" (Settings → Appearance), with the full list and which meeting apps they clash with.
- A dotted grip on the left of the overlay bar to move it, with a grab cursor.
- A setup assistant opens on first launch. It checks for Python and can install Python 3.12 with one click (winget, no admin rights). It asks what language your meetings are in, then installs the speech engine and both the live and the after-meeting model, with a checklist, progress bars and Cancel. It also opens from Settings → Transcription, from the overlay's warning, and when you press Record before setup.
- Model cards say what a model is in plain words ("German · Accurate"), with the technical name underneath as a link to its Hugging Face page, a language badge, speed and accuracy ratings, and the time per 1 h meeting. Settings and the Library describe models the same way.
- Model downloads show a progress bar with "42% · 342 MB of 815 MB" and can be cancelled. A cancelled download leaves nothing behind.
- New profiles are made by answering a few questions (language, live transcript, transcript after the meeting, speed or quality); MeetScribe picks the models. Profiles can now be created, edited and deleted in Settings too.
- Picking a profile whose models are not downloaded offers to download them, with progress and Cancel.

### Changed

- Edits are no longer saved into the active profile silently. The profile shows what you changed, with Save to profile, Save as new profile and Undo changes.
- Settings → Recording's "Open Manager" is now "Open Library".
- Only English and German ship as built-in profiles. German · Work and Tunisian are no longer offered to new users. If you were using or had edited one, it becomes a profile of your own with the same values. The setup assistant's Tunisian choice makes one for you.
- Built-in profiles can be deleted, like your own; "Restore built-in profiles" brings them back.
- System-wide keyboard shortcuts are off by default, so they no longer take keys from meeting apps or text editing. To leave click-through without a shortcut, hover the bar's dot and click it. Settings always takes clicks.
- Quit and Restart ask first while recording, then stop the recording properly before closing.
- The after-meeting pass downloads a missing model visibly, with progress and Cancel, and waits for a download of the same model already running instead of starting a second one.
- A model picked for the live or final transcript but not downloaded is listed first, as "Needed, not downloaded yet".

### Fixed

- A failed model download is shown on its row instead of the row silently going back to "Not downloaded"; without Whisper, Download says "Install Whisper first".
- Install / Repair Whisper says clearly whether it worked, refreshes the model list, and rebuilds a Python environment that no longer starts or uses an unsupported Python.
- "Whisper worker closed" when recording on slower PCs: the first line timed out while the live model was still loading. The 45-second limit now starts once the model is loaded.
- A second Record/Stop press while a recording was stopping could wipe that meeting's audio. Presses during a stop are ignored and the bar shows "Stopping…".
- A recording cut off by a crash, a forced quit or a restart is recovered on the next launch and gets its final pass.
- Warnings raised while a recording starts (capture failed, archiving off) stay visible instead of being cleared at once.

## [1.5.0] - 2026-11-12

### Added

- Unit tests for the hallucination filter, transcript reordering and echo suppression (`npm test`, run in CI).
- Profiles in Settings (English, German, German · Work, Tunisian): one click preselects live/final models, language, transcript visibility and a meeting folder name prefix. Edits are remembered per profile.
- Setting to turn the live transcript off: the audio is still archived and the final pass writes the transcript.
- Tunisian large-v3 (`medyas/FarukSTT`), converted to CTranslate2 on download; German tiny and small.en live models.
- Downloaded models are grouped by purpose; Settings sections collapse and remember their state.
- Meeting library in the browser (overlay → Library, or Settings → Open Manager): browse meetings by folder and tag, search every transcript, and play the archived audio in sync with the transcript (speed, solo one side, skip silence, loop a line, keyboard shortcuts). Screenshots and markers sit in the timeline. Served only on 127.0.0.1 while a tab is open, behind a one-time token.
- In the library: give meetings a title, notes, participants and tags; rename, move and organise them into folders (real folders on disk, the date stays in the name); fix transcript text and speakers, merge or delete lines, add markers; edit a meeting's glossary and corrections (select a word to add a correction); export as Markdown, text, SRT or text for an LLM, or copy it; delete meetings or only their audio to the Recycle Bin, with a storage view to clean up old audio. Meetings that are recording or being transcribed are left alone.
- Re-run the final pass from the library with another model, language, mode or cross-check model, for one meeting or a selection; the queue shows progress and passes can be cancelled, reordered or removed. Per-run choices survive a restart and never change your settings.
- Import a recording (mp3, m4a, wav, flac, ogg, webm) into the library as a new meeting and transcribe it with the final pass.
- Record with your phone: **Phone** in the library shows a QR code; the phone records in its browser (pause, level meter, screen kept on) and sends the recording when you stop. It arrives in the Inbox and the final pass starts. Over your local network only, with HTTPS from a certificate MeetScribe makes itself, a one-time link, and nothing from the library readable through it. The phone keeps the recording until the PC confirms the file is safely on disk; after a reload or a dropped Wi-Fi it offers to send it again (from the same network address), and a resend never makes a second meeting.
- Profiles, models and settings in the library too: switch, edit or reset any profile (not only the active one), download and delete models with live progress and pick the live and final model, and change the same settings as in the app. The Python environment, the transcript folder and audio devices stay app-only.
- Optional speaker labels on the microphone (Settings → Audio, beta): record a short voice sample once, then lines are labelled "You" or "Other 1", "Other 2"… using local speaker embeddings (sherpa-onnx, ~0.04x realtime on one core). Live transcript only (the final pass keeps the stream label). Off by default; only a numeric voiceprint is stored, with a Delete button.
- A new look for the library: the app's colours and logo, icons on every action (delete is red, with a menu for "audio only" or "whole meeting"), a folder tree with nested folders that collapse.
- The library opens on an **Inbox** of meetings not yet filed; drag meetings (or a whole selection) onto a folder, drag folders into each other, and drop an audio file anywhere to import it. Search still looks in every folder.
- Project glossaries: one named glossary per project (the Glossaries page, stored in `.glossaries` in the transcript folder). A meeting can use several or none (its Glossary tab, or the re-run dialog), and a profile picks the ones new recordings start with.
- Your own profiles: save the current settings as a profile, duplicate any profile, rename it, give it a flag, delete it. "No profile" replaces "My settings" and stands for the multilingual defaults.
- Models come in two lists, live and final pass. German small (`mkenfenheuer/whisper-small-cv11-german-ct2`) for live German. Search Hugging Face from the Models page and add any Whisper model for live or final; Transformers models are converted on download.
- Library-only mode: the library's server without the overlay. Start it from the "Open MeetScribe Library" shortcut MeetScribe puts in the transcript folder, or with the power button in the Library's header, which closes MeetScribe and keeps the Library; the same button (or starting MeetScribe) brings it back. A green dot shows the Library is answering. The browser page is now called MeetScribe Library.
- Profiles in the app's Settings are one line of small chips in their own Profiles tab.
- Select meetings in the Library with Ctrl+click, Shift+click (a range), Ctrl+A or the select-all button; Escape clears the selection.
- The glossary pickers (Settings and a meeting's Glossary tab) say how many terms will reach the model ("About 18 of 93 terms reach the model"), and the Glossaries page shows it for each list that is too long.
- A Skill button at the bottom of the Library's sidebar copies a meeting-summary skill for Claude: a summary in sections, to-dos for you and for the others, and open questions, saved as Markdown where you choose.

### Changed

- Several project glossaries in one meeting take turns in the final pass's short hotword list, one term from each in turn. Before, the first glossary picked could use up the whole list and the others were never used. A term that is in more than one of them is used once.

### Fixed

- The WAV header repair before a final pass only touches files in the layout the recorder writes; other WAVs were corrupted by it.
- Settings opens under the banner instead of covering it, and the transcript and settings panels no longer show at the same time.
- Picking a profile no longer empties the glossary; a profile only changes it once it has one of its own.
- Starting a meeting with the live transcript off now warns when no final pass can run, instead of silently keeping only the audio.
- Pressing Enter in a library dialog (new folder, rename, tag) cancelled it instead of confirming.
- The collapse arrows in Settings showed as "B8" / "BE".
- Live transcription in the German profiles was mostly wrong words: they now use `small` live instead of the German tiny model. Live workers on auto threads use half the CPU's cores (4 to 8) instead of faster-whisper's fixed 4, so small keeps up. Pick the profile again to switch an existing setup.
- Repetition loops ("so, so, so, …") in the fast final pass. Its batched decode never retried a looping segment, which happened most with a glossary. Looped segments are now decoded again one at a time without the glossary, and any loop left over is collapsed when the transcript is written.

## [1.4.0] - 2026-10-23

### Added
- Settings → Final pass → **Models on this PC**: every Whisper model with its download status and size, Download and Delete buttons, and which one is in use. Dropdowns mark downloaded models with ✓ (#61).
- German final-pass models: German turbo (`cstr/whisper-large-v3-turbo-german-int8_float32`) and German large-v3 (`tnfru/whisper-large-v3-german-ct2`) (#61).
- Estimated final-pass time per 1-hour meeting for each model. It starts from a benchmark and learns from every pass: model speed per second of speech, plus how much speech your meetings contain (#61).

### Fixed
- The custom-model hint suggested a Transformers repo that faster-whisper cannot load (#61).

## [1.3.0] - 2026-10-23

### Added
- Final pass speed setting: **Fast** (default) decodes VAD-cut speech chunks in batches on one thread per physical core; **Quality** keeps the sequential, conditioned decode (#51).
- Final passes are queued instead of dropped when one is already running, shown as "n queued", run at below-normal priority, and resume after a restart (#48, #49).
- Logging of slow and failed transcriptions with queue wait, decode time and audio length, and of final-pass speed against meeting length (#53).

### Changed
- Final pass beam size defaults to 2 (was 5) and CPU threads to one per physical core (faster-whisper's own default is 4).
- The live pass no longer uses the glossary; the final pass uses only the first ~96 tokens of terms (#47).

### Fixed
- Final pass failing with "The maximum decoding length must be > 0" when a glossary was set (#44).
- Glossary terms written into transcripts where nobody said them (#47).
- Last utterances lost when recording stops while segments are still queued (#50).
- A wedged live Whisper worker is restarted after a timeout instead of stalling every following segment (#52).
- Quitting during a final pass is logged as cancelled, not as an unreadable-audio crash (#49).

## [1.2.0] - 2026-10-21

### Added
- Offline final pass: post-meeting re-transcription with `large-v3-turbo`, confidence marking, chapters and uncertainty index.
- Per-stream raw audio archive with FLAC transcoding.
- Corrections map: `corrections.json` (user data folder, plus a per-meeting copy) replaces known mishearings in the final transcript, marked as `{correct}`.
- Repo foundation: contributor docs, issue/PR templates, CI, shared Claude Code workflow.
- `npm run deploy`: builds the installer and installs it silently over the per-user install, keeping one `MeetScribe.lnk` Start Menu shortcut.
- Auto-update from GitHub Releases for installed builds (Settings toggle, on by default). Release workflow now publishes `latest.yml` and blockmaps.
- New app icon (signal dot) for the executable, installer and windows (#18).

### Changed
- License metadata unified to Apache-2.0; repository links point to this repo.

## [1.1.1]

### Changed
- Local faster-whisper pipeline hardening; version bump.

## [1.0.0]

### Added
- Initial MeetScribe release: live dual-stream transcription overlay, stealth windows, local Whisper setup from Settings.
