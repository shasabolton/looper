const button = document.querySelector("#looper");
const stateText = document.querySelector("#stateText");
const hintText = document.querySelector("#hintText");

const DOUBLE_TAP_MS = 300;
const HOLD_MS = 650;
const MIN_LOOP_SECONDS = 0.25;

let audioContext;
let micStream;
let masterGain;
let layers = [];
let loopDuration = 0;
let sources = [];
let playStartContextTime = 0;

let activeRecording = null;
let isPlaying = false;
let isRecording = false;
let isProcessing = false;
let errorMessage = "";

let holdTimer = 0;
let holdTriggered = false;
let isPressing = false;
let pendingTapTimer = 0;
let lastTapAt = 0;
let playbackStartedByTapAt = 0;
let nextLayerId = 1;

function formatTime(seconds) {
  if (!seconds) return "0.0s";
  return `${seconds.toFixed(1)}s`;
}

function setError(message) {
  errorMessage = message;
  updateUi();
}

function clearError() {
  errorMessage = "";
}

function updateUi() {
  button.classList.toggle("recording", isRecording);
  button.classList.toggle("playing", !isRecording && isPlaying);
  button.classList.toggle("stopped", !isRecording && !isPlaying);

  if (errorMessage) {
    stateText.textContent = "Mic needed";
    hintText.textContent = errorMessage;
    return;
  }

  if (isProcessing) {
    stateText.textContent = "Saving";
    hintText.textContent = "Keeping the take in sync with the loop.";
    return;
  }

  if (isRecording) {
    stateText.textContent = activeRecording?.kind === "overdub" ? "Overdub" : "Record";
    hintText.textContent =
      activeRecording?.kind === "overdub"
        ? "Tap to keep it. Hold to cancel this take."
        : "Tap again to start the loop.";
    return;
  }

  if (isPlaying) {
    stateText.textContent = "Playing";
    hintText.textContent = `Tap to overdub. Double tap stops. Hold undoes. ${layers.length} layer${
      layers.length === 1 ? "" : "s"
    } / ${formatTime(loopDuration)}.`;
    return;
  }

  if (layers.length > 0) {
    stateText.textContent = "Stopped";
    hintText.textContent = `Tap to play. Hold to undo. ${layers.length} layer${
      layers.length === 1 ? "" : "s"
    } saved.`;
    return;
  }

  stateText.textContent = "Tap to record";
  hintText.textContent = "Use headphones for clean overdubs. Works best on HTTPS.";
}

function getSupportedMimeType() {
  if (!window.MediaRecorder) return "";

  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];

  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

async function ensureAudioReady() {
  clearError();

  if (!window.AudioContext && !window.webkitAudioContext) {
    throw new Error("This browser does not support the Web Audio API.");
  }

  if (!window.MediaRecorder) {
    throw new Error("This browser does not support MediaRecorder audio capture.");
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser cannot request microphone access.");
  }

  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass({ latencyHint: "interactive" });
    masterGain = audioContext.createGain();
    masterGain.gain.value = 0.92;
    masterGain.connect(audioContext.destination);
  }

  if (audioContext.state !== "running") {
    await audioContext.resume();
  }

  if (!micStream) {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: false,
        echoCancellation: false,
        noiseSuppression: false,
      },
    });
  }
}

function getLoopPosition() {
  if (!isPlaying || !loopDuration || !audioContext) return 0;
  const elapsed = audioContext.currentTime - playStartContextTime;
  return ((elapsed % loopDuration) + loopDuration) % loopDuration;
}

function stopSources() {
  for (const source of sources) {
    try {
      source.stop();
    } catch {
      // A source can already be stopped when the tab suspends audio.
    }
  }
  sources = [];
}

async function startPlayback(phase = 0) {
  if (!layers.length || !loopDuration) return;

  await ensureAudioReady();
  stopSources();

  const offset = ((phase % loopDuration) + loopDuration) % loopDuration;
  playStartContextTime = audioContext.currentTime - offset;
  sources = layers.map((layer) => {
    const source = audioContext.createBufferSource();
    source.buffer = layer.buffer;
    source.loop = true;
    source.loopStart = 0;
    source.loopEnd = Math.min(loopDuration, layer.buffer.duration);
    source.connect(masterGain);
    source.start(0, Math.min(offset, source.loopEnd - 0.001));
    return source;
  });

  isPlaying = true;
  updateUi();
}

function stopPlayback() {
  stopSources();
  isPlaying = false;
  playbackStartedByTapAt = 0;
  playStartContextTime = 0;
  updateUi();
}

function blobFromChunks(recording) {
  return new Blob(recording.chunks, {
    type: recording.recorder.mimeType || getSupportedMimeType() || "audio/webm",
  });
}

async function startRecording(kind) {
  if (isProcessing || isRecording) return;

  try {
    await ensureAudioReady();
  } catch (error) {
    setError(error.message || "Could not start the microphone.");
    return;
  }

  const mimeType = getSupportedMimeType();
  const recorder = new MediaRecorder(micStream, mimeType ? { mimeType } : undefined);
  const recording = {
    chunks: [],
    kind,
    recorder,
    startPhase: kind === "overdub" ? getLoopPosition() : 0,
  };

  recording.stopped = new Promise((resolve, reject) => {
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size) recording.chunks.push(event.data);
    });
    recorder.addEventListener("stop", () => resolve(blobFromChunks(recording)), { once: true });
    recorder.addEventListener(
      "error",
      (event) => reject(event.error || new Error("Recording failed.")),
      { once: true },
    );
  });

  activeRecording = recording;
  isRecording = true;
  recorder.start(100);
  updateUi();
}

async function decodeRecording(blob) {
  const data = await blob.arrayBuffer();
  return audioContext.decodeAudioData(data);
}

function makeWrappedLayer(buffer, startPhase) {
  const channelCount = Math.min(2, Math.max(1, buffer.numberOfChannels));
  const sampleRate = audioContext.sampleRate;
  const frameCount = Math.max(1, Math.ceil(loopDuration * sampleRate));
  const layer = audioContext.createBuffer(channelCount, frameCount, sampleRate);

  for (let channel = 0; channel < channelCount; channel += 1) {
    const input = buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1));
    const output = layer.getChannelData(channel);

    for (let frame = 0; frame < input.length; frame += 1) {
      const secondsFromStart = frame / buffer.sampleRate;
      const loopTime = (startPhase + secondsFromStart) % loopDuration;
      const outputFrame = Math.floor(loopTime * sampleRate);
      if (outputFrame >= 0 && outputFrame < output.length) {
        output[outputFrame] += input[frame];
      }
    }
  }

  return layer;
}

async function finishRecording({ commit }) {
  if (!activeRecording || isProcessing) return;

  const recording = activeRecording;
  activeRecording = null;
  isRecording = false;
  isProcessing = true;
  updateUi();

  try {
    if (recording.recorder.state !== "inactive") {
      recording.recorder.stop();
    }

    const blob = await recording.stopped;
    if (!commit || blob.size === 0) return;

    const buffer = await decodeRecording(blob);
    if (buffer.duration < MIN_LOOP_SECONDS) {
      setError("That take was too short. Tap again and record a longer loop.");
      return;
    }

    if (recording.kind === "base") {
      stopPlayback();
      loopDuration = buffer.duration;
      layers = [{ id: nextLayerId, buffer }];
      nextLayerId += 1;
      await startPlayback(0);
    } else {
      const phase = getLoopPosition();
      layers.push({
        id: nextLayerId,
        buffer: makeWrappedLayer(buffer, recording.startPhase),
      });
      nextLayerId += 1;

      if (isPlaying) {
        await startPlayback(phase);
      }
    }
  } catch (error) {
    setError(error.message || "Could not save that recording.");
  } finally {
    isProcessing = false;
    updateUi();
  }
}

async function undoLast() {
  clearPendingTap();
  if (isProcessing) return;

  if (isRecording) {
    await finishRecording({ commit: false });
    return;
  }

  if (!layers.length) return;

  const phase = getLoopPosition();
  layers.pop();

  if (!layers.length) {
    stopPlayback();
    loopDuration = 0;
    updateUi();
    return;
  }

  if (isPlaying) {
    await startPlayback(phase);
  }

  updateUi();
}

function clearPendingTap() {
  if (pendingTapTimer) {
    clearTimeout(pendingTapTimer);
    pendingTapTimer = 0;
  }
  lastTapAt = 0;
}

async function handleTap() {
  clearError();

  if (isProcessing) return;

  if (isRecording) {
    await finishRecording({ commit: true });
    return;
  }

  if (isPlaying) {
    const now = performance.now();
    if (playbackStartedByTapAt && now - playbackStartedByTapAt <= DOUBLE_TAP_MS) {
      playbackStartedByTapAt = 0;
      stopPlayback();
      return;
    }

    playbackStartedByTapAt = 0;
    if (pendingTapTimer && now - lastTapAt <= DOUBLE_TAP_MS) {
      clearPendingTap();
      stopPlayback();
      return;
    }

    clearPendingTap();
    lastTapAt = now;
    pendingTapTimer = window.setTimeout(() => {
      pendingTapTimer = 0;
      lastTapAt = 0;
      startRecording("overdub");
    }, DOUBLE_TAP_MS);
    return;
  }

  if (layers.length > 0) {
    await startPlayback(0);
    playbackStartedByTapAt = performance.now();
  } else {
    await startRecording("base");
  }
}

function beginPress(event) {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  event.preventDefault();

  isPressing = true;
  holdTriggered = false;
  if (event.pointerType !== "keyboard") {
    button.setPointerCapture?.(event.pointerId);
  }
  holdTimer = window.setTimeout(async () => {
    holdTriggered = true;
    await undoLast();
  }, HOLD_MS);
}

async function endPress(event) {
  if (!isPressing) return;
  event.preventDefault();

  isPressing = false;
  clearTimeout(holdTimer);
  if (event.pointerId !== -1) {
    button.releasePointerCapture?.(event.pointerId);
  }

  if (!holdTriggered) {
    await handleTap();
  }
}

function cancelPress() {
  isPressing = false;
  clearTimeout(holdTimer);
}

button.addEventListener("pointerdown", beginPress);
button.addEventListener("pointerup", endPress);
button.addEventListener("pointercancel", cancelPress);
button.addEventListener("contextmenu", (event) => event.preventDefault());

button.addEventListener("keydown", (event) => {
  if ((event.key === " " || event.key === "Enter") && !event.repeat) {
    beginPress({
      button: 0,
      pointerId: -1,
      pointerType: "keyboard",
      preventDefault: () => event.preventDefault(),
    });
  }
});

button.addEventListener("keyup", (event) => {
  if (event.key === " " || event.key === "Enter") {
    endPress({
      pointerId: -1,
      preventDefault: () => event.preventDefault(),
    });
  }
});

window.addEventListener("beforeunload", () => {
  stopSources();
  micStream?.getTracks().forEach((track) => track.stop());
});

updateUi();
