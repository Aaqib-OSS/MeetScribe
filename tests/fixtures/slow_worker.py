"""A stand-in for scripts/whisper_worker.py: same JSON-lines protocol, no model.

Loading takes LOAD_SECONDS (as a real model load or first download does), a
transcription TRANSCRIBE_SECONDS. Requests are handled one at a time in order,
like the real worker, so a transcription sent during the load waits for it.
"""
import json
import os
import sys
import time

LOAD_SECONDS = float(os.environ.get("FAKE_LOAD_SECONDS", "1.5"))
TRANSCRIBE_SECONDS = float(os.environ.get("FAKE_TRANSCRIBE_SECONDS", "0.05"))
loaded = False

print(json.dumps({"event": "ready"}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    action = request.get("action")
    if action in ("warmup", "transcribe") and not loaded:
        time.sleep(LOAD_SECONDS)
        loaded = True
    if action == "transcribe":
        time.sleep(TRANSCRIBE_SECONDS)
        print(json.dumps({"id": request["id"], "ok": True, "text": "synthetic"}), flush=True)
    elif action == "unload":
        loaded = False
        print(json.dumps({"id": request["id"], "ok": True}), flush=True)
    else:
        print(json.dumps({"id": request["id"], "ok": True, "model": request.get("model")}), flush=True)
