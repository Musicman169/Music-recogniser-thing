import os

import httpx
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware

MAX_AUDIO_BYTES = 4 * 1024 * 1024
GROQ_TRANSCRIPT_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
DEFAULT_ALLOWED_ORIGINS = {
    "http://localhost:8000",
    "http://127.0.0.1:8000",
}

allowed_origins = {
    origin.strip()
    for origin in os.environ.get("ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
} or DEFAULT_ALLOWED_ORIGINS

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(allowed_origins),
    allow_methods=["POST"],
    allow_headers=["Content-Type"],
)


@app.post("/api/transcribe")
async def transcribe(request: Request, audio: UploadFile = File(...)) -> dict[str, str]:
    if request.headers.get("origin") not in allowed_origins:
        raise HTTPException(status_code=403, detail="This website is not allowed to use the transcription service.")

    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="The transcription service is not configured.")

    if not audio.content_type or not audio.content_type.startswith("audio/"):
        raise HTTPException(status_code=415, detail="Upload an audio recording.")

    audio_bytes = await audio.read(MAX_AUDIO_BYTES + 1)
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="The recording is empty.")
    if len(audio_bytes) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="The recording is too large. Try a shorter recording.")

    headers = {"Authorization": f"Bearer {api_key}"}
    files = {
        "file": (
            audio.filename or "recording.webm",
            audio_bytes,
            audio.content_type,
        )
    }
    data = {
        "model": "whisper-large-v3-turbo",
        "response_format": "json",
        "language": "en",
    }

    try:
        async with httpx.AsyncClient(timeout=35) as client:
            response = await client.post(
                GROQ_TRANSCRIPT_URL,
                headers=headers,
                files=files,
                data=data,
            )
    except httpx.TimeoutException as error:
        raise HTTPException(status_code=504, detail="Transcription took too long. Try again.") from error
    except httpx.RequestError as error:
        raise HTTPException(status_code=502, detail="The transcription provider could not be reached.") from error

    if response.status_code == 429:
        raise HTTPException(status_code=429, detail="The free transcription limit was reached. Try again later.")
    if response.status_code in {401, 403}:
        raise HTTPException(status_code=503, detail="The transcription service rejected its server key.")
    if not response.is_success:
        raise HTTPException(status_code=502, detail="The transcription provider could not process this recording.")

    try:
        result = response.json()
    except ValueError as error:
        raise HTTPException(status_code=502, detail="The transcription provider returned an invalid response.") from error

    transcript = result.get("text") if isinstance(result, dict) else None
    if not isinstance(transcript, str):
        raise HTTPException(status_code=502, detail="The transcription provider returned no transcript.")

    return {"transcript": transcript}
