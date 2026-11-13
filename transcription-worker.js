const modelId = "onnx-community/whisper-tiny";
let transcriberPromise;

async function loadTranscriber(requestId) {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      const { env, pipeline } = await import(
        "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2"
      );
      env.backends.onnx.wasm.numThreads = 1;
      return pipeline("automatic-speech-recognition", modelId, {
        device: "wasm",
        dtype: "q8",
        progress_callback(progress) {
          let message = "Loading the on-device Whisper model…";
          if (progress.status === "progress" && progress.total) {
            const percent = Math.round((progress.loaded / progress.total) * 100);
            message = `Downloading Whisper model… ${percent}%`;
          } else if (progress.status === "initiate") {
            message = "Starting the Whisper model download…";
          }
          self.postMessage({ type: "progress", requestId, message });
        }
      });
    })();
  }

  try {
    return await transcriberPromise;
  } catch (error) {
    transcriberPromise = undefined;
    throw error;
  }
}

self.addEventListener("message", async ({ data }) => {
  if (data.type !== "transcribe") return;
  try {
    const transcriber = await loadTranscriber(data.requestId);
    self.postMessage({
      type: "progress",
      requestId: data.requestId,
      message: "Transcribing on your device…"
    });
    const result = await transcriber(new Float32Array(data.samples), {
      language: "english",
      task: "transcribe"
    });
    self.postMessage({
      type: "result",
      requestId: data.requestId,
      transcript: result.text || ""
    });
  } catch (error) {
    self.postMessage({
      type: "error",
      requestId: data.requestId,
      message: error.message || "Couldn't run the on-device Whisper model."
    });
  }
});
