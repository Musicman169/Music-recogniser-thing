const listenButton = document.querySelector("#listen-button");
const buttonLabel = document.querySelector("#button-label");
const listenStatus = document.querySelector("#listen-status");
const privacyNote = document.querySelector("#privacy-note");
const soundStage = document.querySelector("#sound-stage");
const waveform = document.querySelector("#waveform");
const canvasContext = waveform.getContext("2d");
const transcriptLine = document.querySelector("#detected-line");
const transcriptText = document.querySelector("#transcript");
const searchForm = document.querySelector("#search-form");
const searchLabel = document.querySelector("#search-label");
const lyricInput = document.querySelector("#lyric-input");
const emptyState = document.querySelector("#empty-state");
const loadingState = document.querySelector("#loading-state");
const errorState = document.querySelector("#error-state");
const resultsList = document.querySelector("#results-list");
const resultCount = document.querySelector("#result-count");

const maxRecordingMs = 20_000;
const transcriptionApiUrl = window.HUM_CONFIG?.transcriptionApiUrl?.trim() || "";
let stream;
let mediaRecorder;
let recordedChunks = [];
let recordingFailed = false;
let transcriptionWorker;
let pendingTranscription;
let transcriptionRequestId = 0;
let audioContext;
let analyser;
let animationFrame;
let searchController;
let isListening = false;
let recordingTimer;
let currentQuery = "";

if (transcriptionApiUrl) {
  privacyNote.textContent = "Audio is sent to the configured Vercel and Groq services for transcription.";
}

function getTranscriptionWorker() {
  if (!transcriptionWorker) {
    transcriptionWorker = new Worker(new URL("./transcription-worker.js?v=2", document.baseURI), { type: "module" });
    transcriptionWorker.addEventListener("message", ({ data }) => {
      if (!pendingTranscription || data.requestId !== pendingTranscription.requestId) return;
      if (data.type === "progress") {
        listenStatus.textContent = data.message;
      } else if (data.type === "result") {
        const { resolve } = pendingTranscription;
        pendingTranscription = undefined;
        resolve(data.transcript);
      } else if (data.type === "error") {
        const { reject } = pendingTranscription;
        pendingTranscription = undefined;
        reject(new Error(data.message));
      }
    });
    transcriptionWorker.addEventListener("error", (event) => {
      if (pendingTranscription) {
        pendingTranscription.reject(new Error("The on-device transcription worker stopped unexpectedly."));
        pendingTranscription = undefined;
      }
      transcriptionWorker?.terminate();
      transcriptionWorker = undefined;
      event.preventDefault();
    });
  }
  return transcriptionWorker;
}

function transcribeLocally(samples) {
  const worker = getTranscriptionWorker();
  const requestId = ++transcriptionRequestId;
  return new Promise((resolve, reject) => {
    pendingTranscription = { requestId, resolve, reject };
    worker.postMessage({ type: "transcribe", requestId, samples: samples.buffer }, [samples.buffer]);
  });
}

const ignoredWords = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "could", "did", "do", "does",
  "for", "from", "had", "has", "have", "he", "her", "him", "his", "i", "if", "in", "into", "is",
  "it", "its", "just", "me", "my", "no", "not", "of", "oh", "on", "or", "our", "she", "so",
  "that", "the", "their", "them", "then", "there", "they", "this", "to", "up", "was", "we", "were",
  "know",
  "what", "when", "where", "which", "who", "will", "with", "would", "yeah", "you", "your"
]);

function wordsIn(text) {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/\b(?:i'm|i've|i'll|i'd|you're|you've|you'll|you'd|he's|she's|it's|we're|we've|we'll|we'd|they're|they've|they'll|they'd|that's|there's|what's|who's|where's|when's|how's|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|haven't|hasn't|hadn't|won't|wouldn't|shouldn't|couldn't|can't|cannot|ain't)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/)
    .filter((word) => word && !ignoredWords.has(word));
}

function wordMatch(queryWords, text) {
  if (!queryWords.length) return 0;
  const candidateWords = new Set(wordsIn(text));
  return queryWords.filter((word) => candidateWords.has(word)).length / queryWords.length;
}

function phraseMatchLength(queryWords, text) {
  const candidateWords = wordsIn(text);
  let longest = 0;
  for (let queryIndex = 0; queryIndex < queryWords.length; queryIndex++) {
    for (let candidateIndex = 0; candidateIndex < candidateWords.length; candidateIndex++) {
      let length = 0;
      while (queryIndex + length < queryWords.length && candidateIndex + length < candidateWords.length &&
        queryWords[queryIndex + length] === candidateWords[candidateIndex + length]) length++;
      longest = Math.max(longest, length);
    }
  }
  return longest;
}

function decodeCatalogText(value = "") {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}

function trackKey(track) {
  return `${decodeCatalogText(track.trackName).toLowerCase()}|${decodeCatalogText(track.artistName).toLowerCase()}`;
}

function lyricsText(track) {
  return (track.plainLyrics || track.syncedLyrics || "").replace(/\[\d{2}:\d{2}(?:\.\d{2,3})?\]/g, " ");
}

function mergeMatches(query, catalogTracks, lyricTracks) {
  const queryWords = [...new Set(wordsIn(query))];
  const catalogByTitle = new Map(catalogTracks.map((track) => [trackKey(track), track]));
  const matches = new Map();

  for (const track of lyricTracks) {
    const key = trackKey(track);
    const catalogTrack = catalogByTitle.get(key);
    const lyricScore = wordMatch(queryWords, lyricsText(track));
    const phraseLength = phraseMatchLength(queryWords, lyricsText(track));
    const titleScore = wordMatch(queryWords, `${track.trackName} ${track.artistName}`);
    const lyricMatch = queryWords.length >= 3 &&
      lyricScore >= 0.4 &&
      (phraseLength >= 2 || lyricScore >= (queryWords.length - 1) / queryWords.length);

    if (!lyricMatch && titleScore < 0.35) continue;
    matches.set(key, {
      ...track,
      ...catalogTrack,
      trackName: decodeCatalogText(track.trackName),
      artistName: decodeCatalogText(track.artistName),
      collectionName: catalogTrack?.collectionName || track.albumName,
      artworkUrl60: catalogTrack?.artworkUrl60,
      trackViewUrl: catalogTrack?.trackViewUrl,
      lyricScore: lyricMatch ? lyricScore : 0,
      titleScore,
      matchLabel: lyricMatch ? "Words found in lyrics" : "Title or artist match"
    });
  }

  for (const track of catalogTracks) {
    const key = trackKey(track);
    if (matches.has(key)) continue;
    const titleScore = wordMatch(queryWords, `${track.trackName} ${track.artistName}`);
    if (titleScore < 0.25) continue;
    matches.set(key, {
      ...track,
      trackName: decodeCatalogText(track.trackName),
      artistName: decodeCatalogText(track.artistName),
      collectionName: decodeCatalogText(track.collectionName || ""),
      lyricScore: 0,
      titleScore,
      matchLabel: "Title or artist match"
    });
  }

  return [...matches.values()]
    .sort((a, b) => Number(b.lyricScore > 0) - Number(a.lyricScore > 0) ||
      b.lyricScore - a.lyricScore || b.titleScore - a.titleScore)
    .slice(0, 5);
}

function resizeCanvas() {
  const bounds = waveform.getBoundingClientRect();
  const pixelRatio = window.devicePixelRatio || 1;
  waveform.width = Math.round(bounds.width * pixelRatio);
  waveform.height = Math.round(bounds.height * pixelRatio);
  canvasContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
}

function drawWaveform() {
  if (!analyser) return;
  const width = waveform.clientWidth;
  const height = waveform.clientHeight;
  const values = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(values);
  canvasContext.clearRect(0, 0, width, height);
  canvasContext.lineWidth = 2;
  canvasContext.strokeStyle = "#57906c";
  canvasContext.beginPath();
  const step = width / values.length;
  for (let i = 0; i < values.length; i++) {
    const x = i * step;
    const y = (values[i] / 255) * height;
    if (i === 0) canvasContext.moveTo(x, y);
    else canvasContext.lineTo(x, y);
  }
  canvasContext.stroke();
  animationFrame = requestAnimationFrame(drawWaveform);
}

async function decodeRecording(audioBlob) {
  const decoder = new AudioContext();
  try {
    const audio = await decoder.decodeAudioData(await audioBlob.arrayBuffer());
    const sampleRate = 16_000;
    const offline = new OfflineAudioContext(1, Math.ceil(audio.duration * sampleRate), sampleRate);
    const source = offline.createBufferSource();
    source.buffer = audio;
    source.connect(offline.destination);
    source.start();
    const resampled = await offline.startRendering();
    return new Float32Array(resampled.getChannelData(0));
  } finally {
    await decoder.close();
  }
}

async function transcribeRecording(audioBlob) {
  if (!transcriptionApiUrl) {
    const samples = await decodeRecording(audioBlob);
    return transcribeLocally(samples);
  }

  const formData = new FormData();
  const extension = audioBlob.type.includes("mp4") ? "mp4" : audioBlob.type.includes("ogg") ? "ogg" : "webm";
  formData.append("audio", audioBlob, `recording.${extension}`);
  let response;
  try {
    response = await fetch(transcriptionApiUrl, { method: "POST", body: formData });
  } catch (error) {
    throw new Error("Couldn't reach cloud transcription. Check the API URL, CORS settings, and connection.");
  }

  let result;
  try {
    result = await response.json();
  } catch (error) {
    throw new Error("The transcription service returned an invalid response.");
  }
  if (!response.ok) {
    throw new Error(typeof result?.detail === "string" ? result.detail : "Cloud transcription failed. Try again.");
  }
  if (typeof result?.transcript !== "string") {
    throw new Error("The transcription service returned no transcript.");
  }
  return result.transcript;
}

async function startListening() {
  if (!navigator.mediaDevices?.getUserMedia) {
    listenStatus.textContent = "Microphone access needs a secure connection (HTTPS or localhost).";
    return;
  }
  if (!window.MediaRecorder) {
    listenStatus.textContent = "Audio recording is not supported in this browser. Try a newer browser or type a lyric below.";
    return;
  }

  listenButton.disabled = true;
  listenStatus.textContent = "Asking for microphone access…";
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new AudioContext();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    audioContext.createMediaStreamSource(stream).connect(analyser);

    const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"]
      .find((type) => MediaRecorder.isTypeSupported(type));
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recordedChunks = [];
    recordingFailed = false;
    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) recordedChunks.push(event.data);
    });
    mediaRecorder.addEventListener("stop", finishListening, { once: true });
    mediaRecorder.addEventListener("error", () => {
      recordingFailed = true;
      listenStatus.textContent = "The recording failed. Check your microphone and try again.";
      if (mediaRecorder?.state === "recording") mediaRecorder.stop();
    }, { once: true });
    mediaRecorder.start(250);

    resizeCanvas();
    isListening = true;
    currentQuery = "";
    transcriptText.textContent = "";
    transcriptLine.hidden = true;
    lyricInput.value = "";
    searchLabel.textContent = "Know a word or two?";
    soundStage.classList.add("is-listening");
    soundStage.setAttribute("aria-label", "Microphone is on");
    listenButton.classList.add("is-active");
    buttonLabel.textContent = "Stop & guess";
    listenButton.setAttribute("aria-pressed", "true");
    listenStatus.textContent = "Recording up to 20 seconds. Sing a lyric, then stop to find a match.";
    drawWaveform();
    recordingTimer = setTimeout(stopListening, maxRecordingMs);
  } catch (error) {
    isListening = false;
    mediaRecorder = undefined;
    analyser = undefined;
    soundStage.classList.remove("is-listening");
    soundStage.setAttribute("aria-label", "Microphone is off");
    listenButton.classList.remove("is-active");
    buttonLabel.textContent = "Start recording";
    listenButton.setAttribute("aria-pressed", "false");
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = undefined;
    }
    if (audioContext) {
      await audioContext.close();
      audioContext = undefined;
    }
    if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
      listenStatus.textContent = "Microphone access was denied. Allow it in your browser settings, or type a lyric below.";
    } else if (error.name === "NotFoundError") {
      listenStatus.textContent = "No microphone was found. Connect one, or type a lyric below.";
    } else {
      listenStatus.textContent = "Couldn't start the microphone. Check your browser settings and try again.";
    }
  } finally {
    listenButton.disabled = false;
  }
}

function stopListening() {
  if (!isListening) return;
  isListening = false;
  clearTimeout(recordingTimer);
  listenButton.disabled = true;
  buttonLabel.textContent = "Finishing…";
  listenStatus.textContent = "Preparing your recording…";
  if (mediaRecorder?.state === "recording") mediaRecorder.stop();
  else void finishListening();
}

async function finishListening() {
  isListening = false;
  clearTimeout(recordingTimer);
  const audioBlob = new Blob(recordedChunks, { type: mediaRecorder?.mimeType || "audio/webm" });
  const failed = recordingFailed;
  recordedChunks = [];
  recordingFailed = false;
  mediaRecorder = undefined;
  if (animationFrame) cancelAnimationFrame(animationFrame);
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = undefined;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = undefined;
  }
  analyser = undefined;
  soundStage.classList.remove("is-listening");
  soundStage.setAttribute("aria-label", "Microphone is off");
  listenButton.classList.remove("is-active");
  buttonLabel.textContent = "Start recording";
  listenButton.setAttribute("aria-pressed", "false");
  if (failed) {
    setLoading(false);
    listenButton.disabled = false;
    listenStatus.textContent = "The recording failed. Check your microphone and try again.";
    return;
  }
  if (!audioBlob.size) {
    listenButton.disabled = false;
    listenStatus.textContent = "No audio was recorded. Try again, or type a lyric below.";
    return;
  }

  setLoading(true);
  errorState.hidden = true;
  listenStatus.textContent = transcriptionApiUrl
    ? "Sending your recording for cloud transcription…"
    : "Preparing on-device transcription…";
  try {
    const transcript = (await transcribeRecording(audioBlob)).trim();
    if (!transcript) {
      setLoading(false);
      listenStatus.textContent = "No words were recognized. Try singing closer to the mic, or type a lyric below.";
      return;
    }
    currentQuery = transcript;
    transcriptText.textContent = transcript;
    transcriptLine.hidden = false;
    lyricInput.value = transcript;
    searchLabel.textContent = "Correct any misheard words, then search again";
    listenStatus.textContent = "Searching for your song…";
    await searchSongs(transcript);
  } catch (error) {
    setLoading(false);
    listenStatus.textContent = error.message || "Couldn't load the on-device model. Check your connection and try again.";
  } finally {
    listenButton.disabled = false;
  }
}

function setLoading(isLoading) {
  loadingState.hidden = !isLoading;
  emptyState.hidden = isLoading || resultsList.children.length > 0;
}

function showError(message) {
  errorState.textContent = message;
  errorState.hidden = false;
}

async function searchSongs(query) {
  const term = query.trim();
  if (!term) return;
  searchController?.abort();
  searchController = new AbortController();
  errorState.hidden = true;
  setLoading(true);
  const lyricUrl = new URL("https://lrclib.net/api/search");
  lyricUrl.search = new URLSearchParams({ q: term }).toString();
  const catalogUrl = new URL("https://itunes.apple.com/search");
  catalogUrl.search = new URLSearchParams({ term, entity: "song", limit: "10" }).toString();
  const requestOptions = { signal: searchController.signal };
  const [lyricResponse, catalogResponse] = await Promise.allSettled([
    fetch(lyricUrl, requestOptions).then((response) => {
      if (!response.ok) throw new Error("Lyrics search failed.");
      return response.json();
    }),
    fetch(catalogUrl, requestOptions).then((response) => {
      if (!response.ok) throw new Error("Music search failed.");
      return response.json();
    })
  ]);
  if (searchController.signal.aborted || term !== (currentQuery || lyricInput.value).trim()) return;

  const lyricTracks = lyricResponse.status === "fulfilled" && Array.isArray(lyricResponse.value)
    ? lyricResponse.value
    : [];
  const catalogTracks = catalogResponse.status === "fulfilled" && Array.isArray(catalogResponse.value.results)
    ? catalogResponse.value.results
    : [];
  if (lyricResponse.status === "rejected" && catalogResponse.status === "rejected") {
    setLoading(false);
    showError("Couldn't reach song search right now. Check your connection and try again.");
    return;
  }

  const matches = mergeMatches(term, catalogTracks, lyricTracks);
  renderResults(matches);
  listenStatus.textContent = matches.length
    ? `Found ${matches.length} possible matches.`
    : "No likely matches yet. Try another lyric or clearer words.";
  if (lyricResponse.status === "rejected") {
    showError("Lyric search is unavailable right now. Showing title and artist matches instead.");
  }
}

function renderResults(results) {
  resultsList.replaceChildren();
  resultCount.textContent = results.length ? `· ${results.length}` : "";
  if (!results.length) {
    emptyState.hidden = false;
    emptyState.innerHTML = '<div class="empty-art" aria-hidden="true"><span class="note note-one">♪</span><span class="note note-two">♫</span><span class="empty-disc"></span></div><p class="empty-title">No matches just yet</p><p class="empty-copy">Try another lyric, or sing a clearer line.</p>';
    loadingState.hidden = true;
    return;
  }
  emptyState.hidden = true;
  loadingState.hidden = true;
  for (const song of results) {
    const item = document.createElement("li");
    item.className = "result-item";
    const art = document.createElement("span");
    art.className = "result-art";
    if (song.artworkUrl60) {
      const image = document.createElement("img");
      image.src = song.artworkUrl60;
      image.alt = "";
      image.loading = "lazy";
      art.append(image);
    } else {
      art.textContent = "♫";
    }
    const info = document.createElement("div");
    info.className = "result-info";
    const title = document.createElement("a");
    title.className = "result-title";
    title.textContent = song.trackName || "Unknown song";
    title.href = song.trackViewUrl || `https://music.apple.com/search?term=${encodeURIComponent(`${song.trackName} ${song.artistName}`)}`;
    title.target = "_blank";
    title.rel = "noopener noreferrer";
    const artist = document.createElement("p");
    artist.className = "result-artist";
    artist.textContent = [song.artistName, song.collectionName].filter(Boolean).join(" · ");
    const matchLabel = document.createElement("p");
    matchLabel.className = "result-match";
    matchLabel.textContent = song.matchLabel;
    info.append(title, artist, matchLabel);
    item.append(art, info);
    const link = document.createElement("a");
    link.className = "result-arrow";
    link.href = title.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", `Open ${song.trackName} in Apple Music`);
    link.textContent = "↗";
    item.append(link);
    resultsList.append(item);
  }
}

listenButton.setAttribute("aria-pressed", "false");
listenButton.addEventListener("click", () => {
  if (isListening) stopListening();
  else startListening();
});

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = lyricInput.value.trim();
  if (!query) {
    lyricInput.focus();
    return;
  }
  currentQuery = query;
  transcriptText.textContent = query;
  transcriptLine.hidden = false;
  searchLabel.textContent = "Correct any misheard words, then search again";
  searchSongs(query);
});

window.addEventListener("resize", resizeCanvas);
