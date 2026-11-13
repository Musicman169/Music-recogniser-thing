# Hum

A song finder that records up to 20 seconds of singing, transcribes it with Whisper Tiny in your browser or an optional Groq cloud API, and searches song and lyric catalogs for likely matches. Melody recognition from humming alone is not implemented.

## Run locally

Microphone access requires HTTPS or localhost. From the project folder run:

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Publish with GitHub Pages

1. Push the project to the `main` branch of a GitHub repository.
2. In **Settings → Pages**, choose **GitHub Actions** as the deployment source.
3. The included workflow publishes the site on each push to `main`. The published URL appears in the workflow run or Pages settings.

No backend, API key, account, or server configuration is required.

## Optional cloud transcription

For potentially better recognition of sung lyrics, the app can send recordings to Groq's Whisper Large v3 Turbo through a Vercel Python backend. Cloud transcription is optional; with an empty endpoint in `config.js`, the browser continues using local Whisper Tiny. Cloud transcription may still mishear singing.

Groq offers a $0 Free plan with rate limits; usage is not unlimited, and its published on-demand rate is $0.04 per audio hour. Check the [current plan and limits](https://console.groq.com/settings/billing/plans) before use. You need a Groq API key and a Vercel account. Never put the Groq key in `config.js` or any browser code.

1. Import this GitHub repository into Vercel to deploy the Python API.
2. In Vercel project settings, add `GROQ_API_KEY` with your Groq key.
3. Add `ALLOWED_ORIGINS` with the exact origin of your GitHub Pages site, such as `https://your-name.github.io` (no repository path). For local testing, also include `http://localhost:8000`.
4. Redeploy the Vercel project, then set `transcriptionApiUrl` in `config.js` to `https://your-project.vercel.app/api/transcribe`.
5. Commit and push `config.js`; GitHub Pages will then send recordings to the backend. The audio is forwarded to Groq for transcription and is not persisted by this project's code; review Vercel's and Groq's privacy terms for their processing and retention.

Vercel's backend deployment serves the API; GitHub Pages continues to serve the website. The backend checks the request origin and limits uploads to 4 MB, but this is not a substitute for provider rate limits.

## Transcription and privacy

With local transcription enabled, the page downloads the quantized multilingual Whisper Tiny model from the public Hugging Face Hub on first use (about 40 MB of model weights). The browser caches the model for future visits. Inference runs in a web worker on the visitor's device, using one CPU thread; older or slower devices may take longer. The site needs an internet connection to initially load the model and to search LRCLIB and Apple's song catalog.

The local model may be less accurate than a hosted transcription service, especially for singing. Lyric matches require at least three meaningful words, ignore common filler and contractions, and tolerate one misheard meaningful word. LRCLIB searches song metadata rather than every lyric, so results are suggestions and some songs may not match.
