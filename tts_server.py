"""Minimal Kokoro TTS server — local offline text-to-speech.

Provides:
  POST /synthesize  { text, voice, speed } -> WAV audio
  GET  /health      -> { status, voice, device, ready }
  GET  /voices      -> list of available voices

Model downloads on first run, caches locally, reused on restart.
"""

import os
import io
import logging
import traceback

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

_HERE = os.path.dirname(os.path.abspath(__file__))
# Kokoro uses HuggingFace hub cache (default: ~/.cache/huggingface/hub)
# Model: hexgrad/Kokoro-82M (~100MB)

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# Global state
pipeline = None
DEVICE = "cpu"
READY = False
STAGE = "starting"

# Default voice registry (Kokoro built-in voices)
VOICES = {
    "af_heart": "American English - Heart (female)",
    "af_bella": "American English - Bella (female)",
    "af_nicole": "American English - Nicole (female)",
    "af_sarah": "American English - Sarah (female)",
    "af_sky": "American English - Sky (female)",
    "am_adam": "American English - Adam (male)",
    "am_michael": "American English - Michael (male)",
    "bf_emma": "British English - Emma (female)",
    "bf_isabella": "British English - Isabella (female)",
    "bm_george": "British English - George (male)",
    "bm_lewis": "British English - Lewis (male)",
}

DEFAULT_VOICE = "af_heart"
DEFAULT_SPEED = 1.0


class SynthesizeRequest(BaseModel):
    text: str
    voice: str = DEFAULT_VOICE
    speed: float = DEFAULT_SPEED


def _set_stage(s: str):
    global STAGE
    STAGE = s
    logger.info(f"[tts stage] {s}")


def _detect_device():
    """Detect CUDA availability without disturbing existing torch install."""
    global DEVICE
    try:
        import torch
        if torch.cuda.is_available():
            DEVICE = "cuda"
            logger.info(f"CUDA available: {torch.cuda.get_device_name(0)}")
        else:
            DEVICE = "cpu"
            logger.info("CUDA not available, using CPU")
    except ImportError:
        DEVICE = "cpu"
        logger.info("PyTorch not detected, using CPU")


def _init_pipeline():
    """Initialize Kokoro pipeline. Downloads model on first run."""
    global pipeline, READY
    try:
        _set_stage("importing_kokoro")
        from kokoro import KPipeline

        _set_stage("detecting_device")
        _detect_device()

        _set_stage("loading_pipeline")
        # 'a' = American English, 'b' = British English
        pipeline = KPipeline(lang_code="a", device=DEVICE)

        _set_stage("warming_up")
        # Warm up with a short phrase to pre-load model weights
        list(pipeline("Hello.", voice=DEFAULT_VOICE, speed=1.0))

        READY = True
        _set_stage("ready")
        logger.info(f"Kokoro TTS ready on {DEVICE}")
    except Exception as e:
        _set_stage("error")
        logger.error(f"Kokoro init failed: {e}")
        logger.error(traceback.format_exc())
        READY = False


@app.on_event("startup")
async def startup_event():
    import threading
    threading.Thread(target=_init_pipeline, daemon=True).start()


@app.get("/health")
async def health():
    return JSONResponse({
        "status": "ready" if READY else STAGE,
        "ready": READY,
        "stage": STAGE,
        "voice": DEFAULT_VOICE,
        "device": DEVICE,
    })


@app.get("/voices")
async def voices():
    return JSONResponse({"voices": VOICES, "default": DEFAULT_VOICE})


@app.post("/synthesize")
async def synthesize(req: SynthesizeRequest):
    global pipeline, READY
    if not READY or pipeline is None:
        return JSONResponse(
            {"error": "TTS not ready", "stage": STAGE},
            status_code=503,
        )

    text = (req.text or "").strip()
    if not text:
        return JSONResponse({"error": "empty text"}, status_code=400)

    voice = req.voice if req.voice in VOICES else DEFAULT_VOICE
    speed = max(0.5, min(2.0, req.speed))

    try:
        # Generate audio chunks
        chunks = []
        for _, _, audio in pipeline(text, voice=voice, speed=speed):
            import numpy as np
            # Convert tensor to numpy float32
            if hasattr(audio, "detach"):
                audio = audio.detach().cpu().float().numpy()
            elif hasattr(audio, "numpy"):
                audio = audio.numpy().astype("float32")
            else:
                audio = np.asarray(audio, dtype="float32")
            chunks.append(audio)

        if not chunks:
            return JSONResponse({"error": "no audio generated"}, status_code=500)

        # Concatenate and convert to WAV
        import numpy as np
        import soundfile as sf
        audio_data = np.concatenate(chunks)

        buf = io.BytesIO()
        # Kokoro outputs 24kHz mono
        sf.write(buf, audio_data, 24000, format="WAV", subtype="PCM_16")
        buf.seek(0)

        return StreamingResponse(
            buf,
            media_type="audio/wav",
            headers={"Content-Disposition": "inline; filename=speech.wav"},
        )
    except Exception as e:
        logger.error(f"Synthesis failed: {e}")
        logger.error(traceback.format_exc())
        return JSONResponse({"error": str(e)}, status_code=500)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8767, log_level="info")
