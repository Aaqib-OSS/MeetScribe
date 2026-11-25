/**
 * Notices a recording that receives no audio. Pure: the caller feeds it chunk
 * times and asks on a timer, so it can be tested without a capture device.
 *
 * The audio engine delivers continuously, silence included, so a quiet room is
 * not a stall; only a capture that stopped (or never started) is.
 */
class CaptureWatchdog {
  constructor({ stallMs = 8000 } = {}) {
    this.stallMs = stallMs;
    this.lastChunkAt = null;
    this.suspect = false;
  }

  start(now) {
    this.lastChunkAt = now;
    this.suspect = false;
  }

  stop() {
    this.lastChunkAt = null;
    this.suspect = false;
  }

  mark(now) {
    if (this.lastChunkAt === null) return;
    this.lastChunkAt = now;
    this.suspect = false;
  }

  /**
   * True when nothing has arrived for stallMs on two checks in a row. One check
   * is not enough: right after the PC wakes from sleep the last chunk is old
   * although capture is about to resume.
   */
  check(now) {
    if (this.lastChunkAt === null) return false;
    if (now - this.lastChunkAt < this.stallMs) {
      this.suspect = false;
      return false;
    }
    const stalled = this.suspect;
    this.suspect = true;
    return stalled;
  }
}

module.exports = { CaptureWatchdog };
