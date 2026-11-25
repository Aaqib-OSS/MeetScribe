#!/usr/bin/env python3
"""
Lossless WAV -> FLAC for the meeting audio archive.

Roughly halves the archive (16kHz mono PCM16 is ~115 MB/hour/stream) with no
quality loss, which matters because the whole point of keeping the audio is
being able to re-run the final pass on it months later.

No new dependency: PyAV already comes in with faster-whisper — it is what lets
the app decode audio without an ffmpeg binary on PATH — so the same library that
reads the archive can write it.

Usage: transcode_flac.py <in.wav> <out.flac>
Prints one JSON object describing the result.
"""

import json
import os
import sys


def transcode(src, dst):
    import av

    samples = 0

    with av.open(src) as container:
        in_stream = container.streams.audio[0]
        sample_rate = in_stream.codec_context.sample_rate
        channels = in_stream.codec_context.channels

        with av.open(dst, mode='w') as output:
            # s16 keeps this bit-exact: the source is already 16-bit integer PCM,
            # so FLAC stores exactly the samples that were captured.
            out_stream = output.add_stream('flac', rate=sample_rate)
            out_stream.format = 's16'
            out_stream.layout = 'mono'

            for frame in container.decode(audio=0):
                samples += frame.samples
                frame.pts = None
                for packet in out_stream.encode(frame):
                    output.mux(packet)

            for packet in out_stream.encode(None):
                output.mux(packet)

    # The header can claim less audio than the file holds (a recording still in
    # progress, or one that crashed). The caller deletes the WAV on success, so
    # a FLAC that does not cover it is a failure. Half a second of slack.
    expected = (os.path.getsize(src) - 44) // (2 * channels)
    if samples < expected - sample_rate // 2:
        raise ValueError('FLAC would hold %d of %d samples' % (samples, expected))

    return os.path.getsize(dst)


def main():
    if len(sys.argv) < 3:
        print(json.dumps({'ok': False, 'error': 'usage: transcode_flac.py <in.wav> <out.flac>'}))
        return 2

    src, dst = sys.argv[1], sys.argv[2]
    # Written aside first, so a failure never removes a good FLAC already there.
    part = dst + '.part.flac'
    try:
        size = transcode(src, part)
        os.replace(part, dst)
        print(json.dumps({
            'ok': True,
            'path': dst,
            'bytes': size,
            'sourceBytes': os.path.getsize(src),
        }))
        return 0
    except Exception as exc:  # noqa: BLE001
        # A failed transcode must never cost the archive: the caller keeps the
        # WAV whenever this reports failure.
        try:
            if os.path.exists(part):
                os.remove(part)
        except OSError:
            pass
        print(json.dumps({'ok': False, 'error': str(exc)}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
