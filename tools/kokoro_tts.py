"""ROOKI Local Kokoro TTS Engine — persistent pipeline, sentence-level generation,
producer/consumer audio queue, direct sounddevice playback.

Adapted from Mark-LI engineering principles:
- persistent KPipeline (initialize once, reuse forever)
- device detection (CUDA/CPU)
- CPU thread optimization
- language mapping from voice prefix
- warmup inference
- lazy generator
- tensor normalization (detach→cpu→float→numpy, with tolist fallback)
- silence compression (conservative)
- bounded FIFO audio queue
- producer/consumer concurrent playback
- generation IDs for cancellation
- playback state tracking
- start/done callbacks
- error handling

Communicates with Electron main process via stdin/stdout JSON lines:
  Input:  {"id":N,"type":"speak","text":"...","voice":"af_heart","speed":1.0}
  Input:  {"id":N,"type":"stop"}
  Input:  {"id":N,"type":"config","voice":"af_heart","speed":1.0}
  Output: {"id":N,"type":"event","event":"speaking_started","generation":N}
  Output: {"id":N,"type":"event","event":"speaking_done","generation":N}
  Output: {"id":N,"type":"event","event":"error","message":"..."}
  Output: {"id":N,"type":"ready","voice":"af_heart","speed":1.0,"device":"cpu"}
  Output: {"id":N,"type":"stopped","generation":N}
"""

from __future__ import annotations

import io
import json
import os
import queue
import sys
import threading
import time
from typing import Optional

import numpy as np
import sounddevice as sd

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------
os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

# ---------------------------------------------------------------------------
# Audio helpers
# ---------------------------------------------------------------------------

def _to_numpy(samples) -> np.ndarray:
    """Convert samples to float32 numpy array. Handles PyTorch tensors."""
    if hasattr(samples, "detach"):
        t = samples.detach().cpu().float()
        try:
            return t.numpy()
        except RuntimeError:
            return np.asarray(t.tolist(), dtype=np.float32)
    return np.asarray(samples, dtype=np.float32)


def _compress_silence(
    arr: np.ndarray,
    sample_rate: int = 24_000,
    max_silence_ms: int = 500,
    threshold: float = 0.003,
) -> np.ndarray:
    """Shorten Kokoro's long punctuation pauses (1-2s -> <=500ms)."""
    max_samp = int(max_silence_ms * sample_rate / 1000)
    frame_len = 240  # ~10ms at 24kHz
    out: list[np.ndarray] = []
    silent_acc = 0

    for i in range(0, len(arr), frame_len):
        chunk = arr[i : i + frame_len]
        if np.sqrt(np.mean(chunk ** 2) + 1e-12) < threshold:
            silent_acc += len(chunk)
            if silent_acc <= max_samp:
                out.append(chunk)
        else:
            silent_acc = 0
            out.append(chunk)

    return np.concatenate(out) if out else arr


# ---------------------------------------------------------------------------
# Language mapping
# ---------------------------------------------------------------------------
_LANG_CODES = {
    "a": "a",  # American English (af_*, am_*)
    "b": "b",  # British English (bf_*, bm_*)
    "j": "j",  # Japanese (jf_*, jm_*)
    "z": "z",  # Mandarin Chinese (zf_*, zm_*)
    "s": "s",  # Spanish (sf_*, sm_*)
    "f": "f",  # French (ff_*, fm_*)
    "h": "h",  # Hindi (hf_*, hm_*)
    "i": "i",  # Italian (if_*, im_*)
    "p": "p",  # Brazilian Portuguese
    "r": "r",  # Russian (rf_*, rm_*)
    "e": "e",  # German (ef_*, em_*)
}


def _voice_to_lang(voice: str) -> str:
    prefix = voice[0].lower() if voice else "a"
    return _LANG_CODES.get(prefix, "a")


# ---------------------------------------------------------------------------
# Sentence chunker
# ---------------------------------------------------------------------------
_SENTENCE_END = ".!?"
_SPLIT_RE = None


def _split_sentences(text: str) -> list[str]:
    """Split text into natural sentence chunks for incremental synthesis."""
    import re
    global _SPLIT_RE
    if _SPLIT_RE is None:
        _SPLIT_RE = re.compile(r"(?<=[.!?])\s+")

    parts = _SPLIT_RE.split(text.strip())
    return [p.strip() for p in parts if p.strip()]


# ---------------------------------------------------------------------------
# Playback state
# ---------------------------------------------------------------------------
class PlaybackState:
    IDLE = "idle"
    LOADING = "loading"
    READY = "ready"
    SYNTHESIZING = "synthesizing"
    PLAYING = "playing"
    STOPPING = "stopping"
    ERROR = "error"


# ---------------------------------------------------------------------------
# Kokoro TTS Engine
# ---------------------------------------------------------------------------
class KokoroTTSEngine:
    """Persistent Kokoro TTS engine with producer/consumer audio queue."""

    MAX_QUEUE = 4  # bounded FIFO for backpressure

    def __init__(self, voice: str = "af_heart", speed: float = 1.0):
        self.voice = voice
        self.speed = speed
        self._pipeline = None
        self._lock = threading.Lock()
        self._state = PlaybackState.IDLE
        self._generation = 0
        self._current_gen = 0
        self._synth_thread: Optional[threading.Thread] = None
        self._audio_queue: queue.Queue = queue.Queue(maxsize=self.MAX_QUEUE)
        self._cancel_event = threading.Event()
        self._device = "cpu"
        self._first_audio_latency_ms = 0.0
        self._total_synth_time_ms = 0.0
        self._sentence_count = 0

    @property
    def state(self) -> str:
        return self._state

    def initialize(self) -> None:
        """Initialize pipeline, warmup, ready."""
        self._state = PlaybackState.LOADING
        try:
            self._init_pipeline()
            self._state = PlaybackState.READY
        except Exception as e:
            self._state = PlaybackState.ERROR
            raise

    def _init_pipeline(self) -> None:
        """Create persistent KPipeline with device detection and warmup."""
        lang = _voice_to_lang(self.voice)

        # Device detection
        try:
            import torch
            self._device = "cuda" if torch.cuda.is_available() else "cpu"
            if self._device == "cpu":
                n_threads = max(1, min(4, (os.cpu_count() or 4) // 2))
                try:
                    torch.set_num_threads(n_threads)
                    torch.set_num_interop_threads(2)
                except RuntimeError:
                    pass
        except Exception:
            self._device = "cpu"

        print(f"[KOKORO] Loading pipeline (lang='{lang}', device='{self._device}')", flush=True)

        from kokoro import KPipeline

        try:
            self._pipeline = KPipeline(lang_code=lang, device=self._device)
        except TypeError:
            self._pipeline = KPipeline(lang_code=lang)

        # Warmup inference
        print("[KOKORO] Warming up...", flush=True)
        try:
            for _ in self._pipeline("Hello.", voice=self.voice, speed=self.speed):
                pass
            print("[KOKORO] Warmup complete", flush=True)
        except Exception as e:
            print(f"[KOKORO] Warmup warning: {e}", flush=True)

        print(f"[KOKORO] Ready on {self._device}", flush=True)

    def configure(self, voice: Optional[str] = None, speed: Optional[float] = None) -> None:
        """Update voice/speed. Reinitializes pipeline if voice language changes."""
        if voice and voice != self.voice:
            old_lang = _voice_to_lang(self.voice)
            new_lang = _voice_to_lang(voice)
            self.voice = voice
            if old_lang != new_lang and self._pipeline is not None:
                print(f"[KOKORO] Voice language changed, reinitializing pipeline", flush=True)
                self._pipeline = None
                self._init_pipeline()
        if speed is not None:
            self.speed = max(0.5, min(2.0, speed))

    def speak(self, text: str, on_start=None, on_done=None) -> int:
        """Start speaking text. Returns generation ID."""
        self._generation += 1
        gen = self._generation

        # Cancel any ongoing speech
        self._cancel_event.set()
        if self._synth_thread and self._synth_thread.is_alive():
            self._synth_thread.join(timeout=2.0)

        # Reset state
        self._cancel_event.clear()
        self._current_gen = gen
        self._audio_queue = queue.Queue(maxsize=self.MAX_QUEUE)
        self._state = PlaybackState.SYNTHESIZING
        self._first_audio_latency_ms = 0.0
        self._total_synth_time_ms = 0.0
        self._sentence_count = 0

        # Start producer/consumer
        self._synth_thread = threading.Thread(
            target=self._producer_consumer,
            args=(text, gen, on_start, on_done),
            daemon=True,
        )
        self._synth_thread.start()

        return gen

    def _producer_consumer(self, text: str, gen: int, on_start, on_done) -> None:
        """Run producer and consumer concurrently."""
        sentences = _split_sentences(text)
        if not sentences:
            self._state = PlaybackState.READY
            if on_done:
                on_done()
            return

        first_audio_time: list[float] = []
        synth_start = time.time()

        def _synth_producer():
            """Synthesize sentences and put audio chunks into queue."""
            try:
                for sent_idx, sentence in enumerate(sentences):
                    if self._cancel_event.is_set() or gen != self._current_gen:
                        return

                    sent_start = time.time()
                    for _, _, audio in self._pipeline(
                        sentence, voice=self.voice, speed=self.speed
                    ):
                        if self._cancel_event.is_set() or gen != self._current_gen:
                            return
                        if audio is not None:
                            arr = _to_numpy(audio)
                            arr = _compress_silence(arr)
                            if arr.size > 0:
                                self._audio_queue.put(arr)

                    sent_ms = (time.time() - sent_start) * 1000
                    self._total_synth_time_ms += sent_ms
                    self._sentence_count += 1

            except Exception as e:
                print(f"[KOKORO] Synthesis error: {e}", flush=True)
                self._audio_queue.put(None)  # sentinel with error
                return
            self._audio_queue.put(None)  # sentinel: done

        def _play_consumer():
            """Consume audio chunks from queue and play via sounddevice."""
            first_chunk = True
            try:
                while True:
                    if self._cancel_event.is_set():
                        sd.stop()
                        return

                    try:
                        arr = self._audio_queue.get(timeout=0.1)
                    except queue.Empty:
                        continue

                    if arr is None:
                        break

                    if first_chunk:
                        first_chunk = False
                        self._state = PlaybackState.PLAYING
                        self._first_audio_latency_ms = (time.time() - synth_start) * 1000
                        if on_start:
                            on_start()

                    sd.play(arr, 24000)
                    sd.wait()

            except Exception as e:
                print(f"[KOKORO] Playback error: {e}", flush=True)
            finally:
            # Reset state when done
                if gen == self._current_gen:
                    self._state = PlaybackState.READY
                    if on_done:
                        on_done()

        # Run producer in background, consumer in this thread
        producer_thread = threading.Thread(target=_synth_producer, daemon=True)
        producer_thread.start()
        _play_consumer()
        producer_thread.join(timeout=1.0)

    def stop(self) -> None:
        """Stop current playback and clear queues."""
        self._cancel_event.set()
        sd.stop()
        # Drain queue
        while not self._audio_queue.empty():
            try:
                self._audio_queue.get_nowait()
            except queue.Empty:
                break
        self._state = PlaybackState.READY

    def get_diagnostics(self) -> dict:
        """Return engine diagnostics."""
        return {
            "engine": "Kokoro",
            "version": "0.9.4",
            "model": "Kokoro-82M",
            "device": self._device,
            "voice": self.voice,
            "speed": self._speed_display(),
            "state": self._state,
            "queue": f"{self._audio_queue.qsize()}/{self.MAX_QUEUE}",
            "generation": self._generation,
            "first_audio_latency_ms": round(self._first_audio_latency_ms, 1),
            "avg_sentence_ms": round(
                self._total_synth_time_ms / max(1, self._sentence_count), 1
            ),
        }

    def _speed_display(self) -> float:
        return round(self.speed, 2)


# ---------------------------------------------------------------------------
# JSON-line IPC with Electron
# ---------------------------------------------------------------------------
def _emit(obj: dict) -> None:
    """Write JSON line to stdout."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    """Main loop: read JSON commands from stdin, emit events to stdout."""
    engine = KokoroTTSEngine()

    # Initialize in background thread
    def _init():
        try:
            engine.initialize()
            _emit({
                "id": 0,
                "type": "ready",
                "voice": engine.voice,
                "speed": engine.speed,
                "device": engine._device,
            })
        except Exception as e:
            _emit({"id": 0, "type": "error", "message": str(e)})

    init_thread = threading.Thread(target=_init, daemon=True)
    init_thread.start()

    # Command loop
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError:
            continue

        cmd_id = cmd.get("id", 0)
        cmd_type = cmd.get("type", "")

        if cmd_type == "speak":
            text = cmd.get("text", "")
            if cmd.get("voice"):
                engine.configure(voice=cmd["voice"])
            if cmd.get("speed") is not None:
                engine.configure(speed=cmd["speed"])

            def on_start(cid=cmd_id, gen=engine._generation + 1):
                _emit({"id": cid, "type": "event", "event": "speaking_started", "generation": gen})

            def on_done(cid=cmd_id, gen=engine._generation + 1):
                _emit({"id": cid, "type": "event", "event": "speaking_done", "generation": gen})

            gen = engine.speak(text, on_start=on_start, on_done=on_done)
            _emit({"id": cmd_id, "type": "ack", "generation": gen})

        elif cmd_type == "stop":
            engine.stop()
            _emit({"id": cmd_id, "type": "stopped", "generation": engine._generation})

        elif cmd_type == "config":
            engine.configure(
                voice=cmd.get("voice"),
                speed=cmd.get("speed"),
            )
            _emit({"id": cmd_id, "type": "config_ok", "voice": engine.voice, "speed": engine.speed})

        elif cmd_type == "diagnostics":
            _emit({"id": cmd_id, "type": "diagnostics", **engine.get_diagnostics()})

        elif cmd_type == "ping":
            _emit({"id": cmd_id, "type": "pong"})

        elif cmd_type == "shutdown":
            engine.stop()
            _emit({"id": cmd_id, "type": "shutdown_ok"})
            break


if __name__ == "__main__":
    main()
