import { PitchTracker } from "./dsp/pitchTracker.js";
import { TempoTracker } from "./dsp/tempoTracker.js";
import { createClickBuffer, scheduleMetronome } from "./audio/metronome.js";

const $ = (id) => document.getElementById(id);

const btnStart = $("btnStart");
const btnStop = $("btnStop");
const statusEl = $("status");

const bpmInput = $("bpmInput");

const noteNameEl = $("noteName");
const freqHzEl = $("freqHz");
const centsEl = $("cents");
const tempoEl = $("tempo");
const durEl = $("dur");
const tempoLiveEl = $("tempoLive");

const btnPlay = $("btnPlay");
const btnStopPlay = $("btnStopPlay");
const metOn = $("metOn");
const metGainPlay = $("metGainPlay");
const metGainPlayVal = $("metGainPlayVal");
const btnExportVideo = $("btnExportVideo");
const exportStatus = $("exportStatus");
const exportLink = $("exportLink");

const uploadAudio = $("uploadAudio");
const btnUploadAnalyze = $("btnUploadAnalyze");
const uploadStatus = $("uploadStatus");

const repMeanAbs = $("repMeanAbs");
const repIn10 = $("repIn10");
const repIn25 = $("repIn25");
const repTempoStability = $("repTempoStability");
const repN = $("repN");
const repTop = $("repTop");

metGainPlay.addEventListener("input", () => metGainPlayVal.textContent = Number(metGainPlay.value).toFixed(2));

let audioCtx = null;
let micStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let decodedAudioBuffer = null;
let detectedTempo = null;
let beatTimeline = null;
let analyzedPitchLog = [];

let workletNode = null;

// analysis
const frameSize = 1024;
let hopSize = 480;
let hopMs = 10;

let pitchTracker = null;
let analysisTimer = null;

class PCMQueue {
  constructor() { this.chunks = []; this.offset = 0; this.length = 0; }
  push(chunk) { this.chunks.push(chunk); this.length += chunk.length; }
  pop(n) {
    if (this.length < n) return null;
    const out = new Float32Array(n);
    let written = 0;
    while (written < n) {
      const head = this.chunks[0];
      const avail = head.length - this.offset;
      const take = Math.min(avail, n - written);
      out.set(head.subarray(this.offset, this.offset + take), written);
      written += take;
      this.offset += take;
      this.length -= take;
      if (this.offset >= head.length) { this.chunks.shift(); this.offset = 0; }
    }
    return out;
  }
  reset() { this.chunks = []; this.offset = 0; this.length = 0; }
}
const pcmQueue = new PCMQueue();

let rollingFrame = new Float32Array(frameSize);
let rollingInited = false;
let hopCount = 0;

// report samples
let pitchLog = [];

// playback state
let playback = {
  source: null,
  stopScheduler: null,
  beatTimer: null,
  gainNode: null,
  metStart: 0,
  bpm: 0,
  tempoTimers: [],
};

btnStart.addEventListener("click", startRecording);
btnStop.addEventListener("click", stopRecording);
btnPlay.addEventListener("click", play);
btnStopPlay.addEventListener("click", stopPlayback);
btnUploadAnalyze.addEventListener("click", analyzeUploadedAudio);
btnExportVideo.addEventListener("click", exportVideo);
uploadAudio.addEventListener("change", () => {
  uploadStatus.textContent = uploadAudio.files?.[0]?.name || "未选择文件";
});

async function ensureAudioContext() {
  if (audioCtx) return audioCtx;
  audioCtx = new AudioContext({ latencyHint: "interactive" });
  await audioCtx.audioWorklet.addModule("./src/audio/audio-worklet-processor.js");
  return audioCtx;
}

function getBpmPreset() {
  const bpm = Number(bpmInput.value);
  if (!isFinite(bpm)) return 90;
  return Math.max(30, Math.min(240, Math.round(bpm)));
}

async function startRecording() {
  btnStart.disabled = true;
  btnStop.disabled = false;
  btnPlay.disabled = true;
  btnStopPlay.disabled = true;

  resetUIForNewTake();

  const bpm = getBpmPreset();
  tempoEl.textContent = `♩=${bpm}`;

  setStatus("请求麦克风权限…");
  const ctx = await ensureAudioContext();
  await ctx.resume();

  hopSize = Math.max(240, Math.round(ctx.sampleRate * 0.01)); // ~10ms
  hopMs = (hopSize / ctx.sampleRate) * 1000;

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  });

  recordedChunks = [];
  mediaRecorder = new MediaRecorder(micStream);
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.start();

  const src = ctx.createMediaStreamSource(micStream);

  // Mic -> worklet (for analysis). Mute to avoid feedback.
  const mute = ctx.createGain(); mute.gain.value = 0;
  workletNode = new AudioWorkletNode(ctx, "pcm-grabber");
  src.connect(workletNode).connect(mute).connect(ctx.destination);

  pcmQueue.reset();
  rollingFrame = new Float32Array(frameSize);
  rollingInited = false;
  hopCount = 0;
  pitchLog = [];

  pitchTracker = new PitchTracker({ sampleRate: ctx.sampleRate });

  workletNode.port.onmessage = (e) => {
    if (e.data?.type === "pcm") pcmQueue.push(e.data.pcm);
  };

  setStatus("录音中…（实时分析中）");

  if (analysisTimer) clearInterval(analysisTimer);
  analysisTimer = setInterval(analysisHopTick, hopMs);
}

function analysisHopTick() {
  if (!workletNode) return;

  if (!rollingInited) {
    const init = pcmQueue.pop(frameSize);
    if (!init) return;
    rollingFrame.set(init);
    rollingInited = true;
  } else {
    const hop = pcmQueue.pop(hopSize);
    if (!hop) return;
    rollingFrame.copyWithin(0, hopSize);
    rollingFrame.set(hop, frameSize - hopSize);
  }

  const tSec = hopCount * (hopSize / audioCtx.sampleRate);
  hopCount++;

  const pitch = pitchTracker.pushFrame(rollingFrame);
  if (pitch) {
    noteNameEl.textContent = pitch.noteName;
    freqHzEl.textContent = `${pitch.freqHz.toFixed(1)} Hz`;
    centsEl.textContent = `${pitch.cents} cents`;

    if (pitchLog.length === 0 || (tSec - pitchLog[pitchLog.length - 1].tSec) > 0.03) {
      pitchLog.push({ tSec, noteName: pitch.noteName, cents: pitch.cents, freqHz: pitch.freqHz });
    }
  }
}

async function stopRecording() {
  btnStop.disabled = true;
  setStatus("停止中…");

  if (analysisTimer) { clearInterval(analysisTimer); analysisTimer = null; }

  const blob = await stopMediaRecorderSafely();

  if (micStream) micStream.getTracks().forEach(t => t.stop());
  micStream = null;

  if (workletNode) {
    workletNode.port.onmessage = null;
    try { workletNode.disconnect(); } catch {}
    workletNode = null;
  }

  const ctx = await ensureAudioContext();
  const arrayBuf = await blob.arrayBuffer();
  decodedAudioBuffer = await ctx.decodeAudioData(arrayBuf.slice(0));
  durEl.textContent = `${decodedAudioBuffer.duration.toFixed(2)}s`;

  const report = analyzeAudioBuffer(decodedAudioBuffer, { bpm: getBpmPreset() });
  updateDetectedTempo(report.detectedTempo);
  beatTimeline = report.beatTimeline;
  renderReport(report);

  btnStart.disabled = false;
  btnPlay.disabled = false;
  btnExportVideo.disabled = false;
  setStatus("已录制，准备回放");
}

function stopMediaRecorderSafely() {
  return new Promise((resolve) => {
    if (!mediaRecorder) return resolve(new Blob());
    const mr = mediaRecorder;
    mediaRecorder = null;

    mr.onstop = () => resolve(new Blob(recordedChunks, { type: mr.mimeType || "audio/webm" }));
    try { mr.stop(); } catch { resolve(new Blob(recordedChunks, { type: mr.mimeType || "audio/webm" })); }
  });
}

function scheduleDynamicMetronome(ctx, timeline, { startTime, clickBufferStrong, clickBufferWeak, clickGainNode }) {
  if (!timeline?.beatTimes?.length) return null;
  const sources = [];
  for (let i = 0; i < timeline.beatTimes.length; i++) {
    const when = startTime + timeline.beatTimes[i];
    const src = ctx.createBufferSource();
    src.buffer = i % 4 === 0 ? clickBufferStrong : clickBufferWeak;
    src.connect(clickGainNode);
    src.start(when);
    sources.push(src);
  }
  return () => {
    for (const src of sources) {
      try { src.stop(); } catch {}
    }
  };
}

function scheduleTempoUpdates(ctx, startTime, timeline, onTempo) {
  const timers = [];
  if (!timeline?.beatTimes?.length) return timers;
  for (let i = 1; i < timeline.beatTimes.length; i++) {
    const bpm = timeline.bpms?.[i] ?? timeline.bpms?.[i - 1];
    if (!bpm) continue;
    const when = startTime + timeline.beatTimes[i];
    const delayMs = Math.max(0, (when - ctx.currentTime) * 1000);
    const id = setTimeout(() => onTempo(bpm), delayMs);
    timers.push(id);
  }
  return timers;
}

async function play() {
  if (!decodedAudioBuffer) return;

  btnPlay.disabled = true;
  btnStopPlay.disabled = false;

  const ctx = await ensureAudioContext();
  await ctx.resume();
  stopPlayback();

  const bpm = getBpmPreset();
  const useMet = metOn.checked;
  const useDynamicBeats = !!(beatTimeline?.beatTimes?.length && beatTimeline.beatTimes.length >= 3);

  const src = ctx.createBufferSource();
  src.buffer = decodedAudioBuffer;

  const musicGain = ctx.createGain();
  musicGain.gain.value = 1.0;
  musicGain.connect(ctx.destination);

  const clickGain = ctx.createGain();
  clickGain.gain.value = Number(metGainPlay.value);
  clickGain.connect(ctx.destination);

  const clickStrong = createClickBuffer(ctx, { freq: 1900, durationMs: 16 });
  const clickWeak = createClickBuffer(ctx, { freq: 1400, durationMs: 12 });

  const startDelay = 0.03;
  const t0 = ctx.currentTime + startDelay;

  let stopScheduler = null;
  if (useMet) {
    if (useDynamicBeats) {
      stopScheduler = scheduleDynamicMetronome(ctx, beatTimeline, {
        startTime: t0,
        clickBufferStrong: clickStrong,
        clickBufferWeak: clickWeak,
        clickGainNode: clickGain,
      });
    } else {
      stopScheduler = scheduleMetronome(ctx, {
        bpm,
        meter: 999999,
        startTime: t0,
        durationSec: decodedAudioBuffer.duration,
        clickBufferStrong: clickStrong,
        clickBufferWeak: clickStrong,
        clickGainNode: clickGain,
      });
    }
  }

  if (useDynamicBeats) {
    const initialBpm = beatTimeline.bpms?.[1] ?? beatTimeline.bpms?.[0] ?? bpm;
    tempoLiveEl.textContent = `♩=${initialBpm.toFixed(0)}`;
    playback.tempoTimers = scheduleTempoUpdates(ctx, t0, beatTimeline, (tempo) => {
      tempoLiveEl.textContent = `♩=${tempo.toFixed(0)}`;
    });
  } else {
    tempoLiveEl.textContent = `♩=${bpm}`;
  }

  src.connect(musicGain);
  src.start(t0);

  playback.source = src;
  playback.stopScheduler = stopScheduler;

  src.onended = () => stopPlayback();
  setStatus(useMet ? "回放中（叠加节拍器）" : "回放中");
}

function stopPlayback() {
  if (playback.source) { try { playback.source.stop(); } catch {} playback.source = null; }
  if (playback.stopScheduler) { playback.stopScheduler(); playback.stopScheduler = null; }
  if (playback.tempoTimers.length) {
    playback.tempoTimers.forEach((id) => clearTimeout(id));
    playback.tempoTimers = [];
  }
  btnPlay.disabled = !decodedAudioBuffer;
  btnStopPlay.disabled = true;
  if (decodedAudioBuffer) setStatus("已录制，准备回放");
  tempoLiveEl.textContent = "—";
}

function renderReport(report) {
  if (!report || !report.pitchLog || report.pitchLog.length === 0) {
    repMeanAbs.textContent = "—";
    repIn10.textContent = "—";
    repIn25.textContent = "—";
    repTempoStability.textContent = "—";
    repN.textContent = "0";
    repTop.textContent = "—";
    return;
  }
  const { pitchLog, tempoStability } = report;
  const centsAbs = pitchLog.map(x => Math.abs(x.cents));
  const meanAbs = centsAbs.reduce((a,b)=>a+b,0) / centsAbs.length;
  const in10 = centsAbs.filter(x => x <= 10).length / centsAbs.length;
  const in25 = centsAbs.filter(x => x <= 25).length / centsAbs.length;

  repMeanAbs.textContent = meanAbs.toFixed(1);
  repIn10.textContent = (in10*100).toFixed(1) + "%";
  repIn25.textContent = (in25*100).toFixed(1) + "%";
  repTempoStability.textContent = tempoStability === null ? "—" : `${tempoStability.toFixed(1)} / 100`;
  repN.textContent = String(pitchLog.length);

  const counts = new Map();
  for (const x of pitchLog) counts.set(x.noteName, (counts.get(x.noteName)||0)+1);
  const top = [...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5)
    .map(([k,v])=>`${k}(${v})`).join(", ");
  repTop.textContent = top || "—";
}

function resetUIForNewTake() {
  detectedTempo = null;
  beatTimeline = null;
  analyzedPitchLog = [];
  noteNameEl.textContent = "—";
  freqHzEl.textContent = "—";
  centsEl.textContent = "—";
  durEl.textContent = "—";
  tempoLiveEl.textContent = "—";
  btnExportVideo.disabled = true;
  exportStatus.textContent = "未生成";
  exportLink.classList.remove("show");
  exportLink.removeAttribute("href");

  repMeanAbs.textContent = "—";
  repIn10.textContent = "—";
  repIn25.textContent = "—";
  repTempoStability.textContent = "—";
  repN.textContent = "—";
  repTop.textContent = "—";
}

function setStatus(s) { statusEl.textContent = s; }

function updateDetectedTempo(tempoResult) {
  detectedTempo = tempoResult;
}

async function analyzeUploadedAudio() {
  const file = uploadAudio.files?.[0];
  if (!file) {
    uploadStatus.textContent = "请先选择音频文件";
    return;
  }

  try {
    detectedTempo = null;
    uploadStatus.textContent = "解析中…";
    const ctx = await ensureAudioContext();
    await ctx.resume();
    const buf = await file.arrayBuffer();
    decodedAudioBuffer = await ctx.decodeAudioData(buf.slice(0));
    durEl.textContent = `${decodedAudioBuffer.duration.toFixed(2)}s`;

    const report = analyzeAudioBuffer(decodedAudioBuffer, { bpm: getBpmPreset() });
    updateDetectedTempo(report.detectedTempo);
    beatTimeline = report.beatTimeline;
    analyzedPitchLog = report.pitchLog || [];
    renderReport(report);

    btnPlay.disabled = false;
    btnExportVideo.disabled = false;
    uploadStatus.textContent = "分析完成";
    setStatus("已上传音频，准备回放");
  } catch (err) {
    console.error(err);
    uploadStatus.textContent = "解析失败，请尝试其他音频格式";
  }
}

async function exportVideo() {
  if (!decodedAudioBuffer) return;
  btnExportVideo.disabled = true;
  exportStatus.textContent = "导出中…";
  exportLink.classList.remove("show");
  exportLink.removeAttribute("href");

  const ctx = await ensureAudioContext();
  await ctx.resume();
  stopPlayback();

  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const c2d = canvas.getContext("2d");
  if (!c2d) {
    exportStatus.textContent = "导出失败：无法创建画布";
    btnExportVideo.disabled = false;
    return;
  }

  const stream = canvas.captureStream(30);
  const dest = ctx.createMediaStreamDestination();

  const src = ctx.createBufferSource();
  src.buffer = decodedAudioBuffer;

  const musicGain = ctx.createGain();
  musicGain.gain.value = 1.0;
  const clickGain = ctx.createGain();
  clickGain.gain.value = Number(metGainPlay.value);

  musicGain.connect(ctx.destination);
  musicGain.connect(dest);
  clickGain.connect(ctx.destination);
  clickGain.connect(dest);

  src.connect(musicGain);

  const clickStrong = createClickBuffer(ctx, { freq: 1900, durationMs: 16 });
  const clickWeak = createClickBuffer(ctx, { freq: 1400, durationMs: 12 });

  const startDelay = 0.1;
  const t0 = ctx.currentTime + startDelay;
  const useDynamicBeats = !!(beatTimeline?.beatTimes?.length && beatTimeline.beatTimes.length >= 3);

  let stopScheduler = null;
  if (useDynamicBeats) {
    stopScheduler = scheduleDynamicMetronome(ctx, beatTimeline, {
      startTime: t0,
      clickBufferStrong: clickStrong,
      clickBufferWeak: clickWeak,
      clickGainNode: clickGain,
    });
  } else {
    stopScheduler = scheduleMetronome(ctx, {
      bpm: getBpmPreset(),
      meter: 999999,
      startTime: t0,
      durationSec: decodedAudioBuffer.duration,
      clickBufferStrong: clickStrong,
      clickBufferWeak: clickStrong,
      clickGainNode: clickGain,
    });
  }

  const combinedStream = new MediaStream([
    ...stream.getVideoTracks(),
    ...dest.stream.getAudioTracks(),
  ]);

  let recorder;
  const preferredMime = "video/webm;codecs=vp9,opus";
  if (MediaRecorder.isTypeSupported(preferredMime)) {
    recorder = new MediaRecorder(combinedStream, { mimeType: preferredMime });
  } else {
    recorder = new MediaRecorder(combinedStream);
  }

  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = () => {
    if (stopScheduler) stopScheduler();
    const blob = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
    const url = URL.createObjectURL(blob);
    exportLink.href = url;
    exportLink.classList.add("show");
    exportStatus.textContent = "导出完成";
    btnExportVideo.disabled = false;
  };

  const durationSec = decodedAudioBuffer.duration;
  const beatTimes = useDynamicBeats
    ? beatTimeline.beatTimes
    : buildConstantBeatTimes(getBpmPreset(), durationSec);
  const beatBpms = useDynamicBeats ? beatTimeline.bpms : null;
  let beatIndex = 0;
  let lastBeatTime = 0;
  let currentBpm = useDynamicBeats
    ? (beatBpms?.[1] ?? beatBpms?.[0] ?? getBpmPreset())
    : getBpmPreset();
  const pitchData = Array.isArray(analyzedPitchLog) ? analyzedPitchLog : [];
  let pitchIndex = 0;
  let currentPitch = null;

  const drawFrame = () => {
    const now = ctx.currentTime;
    const elapsed = now - t0;
    c2d.clearRect(0, 0, canvas.width, canvas.height);
    c2d.fillStyle = "#0b0f14";
    c2d.fillRect(0, 0, canvas.width, canvas.height);

    if (elapsed >= 0) {
      while (beatIndex < beatTimes.length && beatTimes[beatIndex] <= elapsed) {
        lastBeatTime = beatTimes[beatIndex];
        if (useDynamicBeats && beatBpms?.[beatIndex]) {
          currentBpm = beatBpms[beatIndex];
        }
        beatIndex++;
      }
      while (pitchIndex < pitchData.length && pitchData[pitchIndex].tSec <= elapsed) {
        currentPitch = pitchData[pitchIndex];
        pitchIndex++;
      }
    }

    const flash = Math.max(0, 1 - (elapsed - lastBeatTime) / 0.2);
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const radius = 90 + flash * 30;

    c2d.beginPath();
    c2d.arc(centerX, centerY, radius, 0, Math.PI * 2);
    c2d.fillStyle = `rgba(46, 160, 67, ${0.2 + flash * 0.6})`;
    c2d.fill();

    c2d.font = "700 64px system-ui, sans-serif";
    c2d.fillStyle = "#e6edf3";
    c2d.textAlign = "center";
    c2d.fillText(`♩=${currentBpm.toFixed(0)}`, centerX, centerY + 12);

    c2d.font = "400 26px system-ui, sans-serif";
    c2d.fillStyle = "#8b949e";
    c2d.fillText("同步节拍器导出", centerX, centerY + 72);

    c2d.font = "600 40px system-ui, sans-serif";
    c2d.fillStyle = "#f0f6fc";
    const noteLabel = currentPitch?.noteName ? currentPitch.noteName : "—";
    c2d.fillText(`音准：${noteLabel}`, centerX, centerY + 140);

    c2d.font = "400 24px system-ui, sans-serif";
    c2d.fillStyle = "#8b949e";
    const freqLabel = Number.isFinite(currentPitch?.freqHz)
      ? `${currentPitch.freqHz.toFixed(1)} Hz`
      : "—";
    const centsLabel = Number.isFinite(currentPitch?.cents)
      ? `${currentPitch.cents} cents`
      : "—";
    c2d.fillText(`${freqLabel} · ${centsLabel}`, centerX, centerY + 178);

    if (elapsed < durationSec + 0.5) {
      requestAnimationFrame(drawFrame);
    }
  };

  recorder.start();
  src.start(t0);
  requestAnimationFrame(drawFrame);

  setTimeout(() => {
    try { recorder.stop(); } catch {}
  }, Math.ceil((durationSec + 0.5) * 1000));
}

function analyzeAudioBuffer(buffer, { bpm }) {
  const sampleRate = buffer.sampleRate;
  const data = buffer.getChannelData(0);
  const localHopSize = Math.max(240, Math.round(sampleRate * 0.01));
  const tracker = new PitchTracker({ sampleRate });
  const tempoTracker = new TempoTracker({ sampleRate, frameSize, hopSize: localHopSize });
  const pitchLogLocal = [];

  let frame = new Float32Array(frameSize);
  if (data.length >= frameSize) frame.set(data.subarray(0, frameSize));

  let tSec = 0;
  for (let offset = 0; offset + frameSize <= data.length; offset += localHopSize) {
    if (offset !== 0) {
      frame.copyWithin(0, localHopSize);
      frame.set(data.subarray(offset + frameSize - localHopSize, offset + frameSize), frameSize - localHopSize);
    }
    tempoTracker.pushFrame(frame);
    const pitch = tracker.pushFrame(frame);
    if (pitch) {
      if (pitchLogLocal.length === 0 || (tSec - pitchLogLocal[pitchLogLocal.length - 1].tSec) > 0.03) {
        pitchLogLocal.push({ tSec, noteName: pitch.noteName, cents: pitch.cents, freqHz: pitch.freqHz });
      }
    }
    tSec = offset / sampleRate;
  }

  const tempoStability = computeTempoStability(data, sampleRate, localHopSize, bpm);
  const detectedTempo = tempoTracker.finalize({ minBPM: 40, maxBPM: 200 });
  const beatTimeline = computeBeatTimeline(data, sampleRate, localHopSize, {
    baseBpm: detectedTempo?.bpm ?? bpm,
    beatOffsetSec: detectedTempo?.beatOffsetSec ?? 0,
  });
  return { pitchLog: pitchLogLocal, tempoStability, detectedTempo, beatTimeline };
}

function computeTempoStability(data, sampleRate, hopSizeLocal, bpm) {
  if (!isFinite(bpm) || bpm <= 0) return null;
  const frame = new Float32Array(hopSizeLocal);
  const rms = [];
  for (let i = 0; i + hopSizeLocal <= data.length; i += hopSizeLocal) {
    frame.set(data.subarray(i, i + hopSizeLocal));
    let sum = 0;
    for (let j = 0; j < frame.length; j++) {
      const v = frame[j];
      sum += v * v;
    }
    rms.push(Math.sqrt(sum / frame.length));
  }
  if (rms.length < 4) return null;

  const mean = rms.reduce((a,b)=>a+b,0) / rms.length;
  const variance = rms.reduce((a,b)=>a+(b-mean)*(b-mean),0) / rms.length;
  const std = Math.sqrt(variance);
  const threshold = mean + std * 0.5;

  const minInterval = Math.round((sampleRate / hopSizeLocal) * 0.2);
  const peaks = [];
  for (let i = 1; i < rms.length - 1; i++) {
    if (rms[i] > threshold && rms[i] > rms[i-1] && rms[i] > rms[i+1]) {
      if (peaks.length === 0 || (i - peaks[peaks.length - 1]) >= minInterval) {
        peaks.push(i);
      }
    }
  }
  if (peaks.length < 3) return null;

  const intervals = [];
  for (let i = 1; i < peaks.length; i++) {
    intervals.push((peaks[i] - peaks[i-1]) * (hopSizeLocal / sampleRate));
  }
  const intervalMean = intervals.reduce((a,b)=>a+b,0) / intervals.length;
  const intervalVar = intervals.reduce((a,b)=>a+(b-intervalMean)*(b-intervalMean),0) / intervals.length;
  const intervalStd = Math.sqrt(intervalVar);

  const targetInterval = 60 / bpm;
  const jitterRatio = intervalStd / intervalMean;
  const offsetRatio = Math.abs(intervalMean - targetInterval) / targetInterval;

  const penalty = Math.min(1, jitterRatio * 2 + offsetRatio * 1.5);
  const score = Math.max(0, 1 - penalty) * 100;
  return score;
}

function computeBeatTimeline(data, sampleRate, hopSizeLocal, { baseBpm, beatOffsetSec } = {}) {
  const hopSec = hopSizeLocal / sampleRate;
  const frame = new Float32Array(hopSizeLocal);
  const rms = [];
  for (let i = 0; i + hopSizeLocal <= data.length; i += hopSizeLocal) {
    frame.set(data.subarray(i, i + hopSizeLocal));
    let sum = 0;
    for (let j = 0; j < frame.length; j++) {
      const v = frame[j];
      sum += v * v;
    }
    rms.push(Math.sqrt(sum / frame.length));
  }
  if (rms.length < 8) return null;

  const sm = new Float32Array(rms.length);
  for (let i = 0; i < rms.length; i++) {
    let acc = 0;
    let cnt = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j >= 0 && j < rms.length) { acc += rms[j]; cnt++; }
    }
    sm[i] = acc / cnt;
  }

  const mean = sm.reduce((a, b) => a + b, 0) / sm.length;
  const variance = sm.reduce((a, b) => a + (b - mean) * (b - mean), 0) / sm.length;
  const std = Math.sqrt(variance);
  const threshold = mean + std * 0.35;

  const minIntervalFrames = Math.max(1, Math.round(0.2 / hopSec));
  const peaks = [];
  for (let i = 1; i < sm.length - 1; i++) {
    if (sm[i] > threshold && sm[i] > sm[i - 1] && sm[i] > sm[i + 1]) {
      if (!peaks.length || i - peaks[peaks.length - 1] >= minIntervalFrames) {
        peaks.push(i);
      }
    }
  }

  if (peaks.length < 2) return null;
  const onsetTimes = peaks.map((idx) => idx * hopSec);

  if (!isFinite(baseBpm) || baseBpm <= 0) {
    const beatTimes = onsetTimes;
    const bpms = beatTimes.map((t, i) => {
      if (i === 0) return null;
      const interval = t - beatTimes[i - 1];
      if (interval <= 0) return null;
      const bpm = 60 / interval;
      return Math.max(30, Math.min(240, bpm));
    });
    return { beatTimes, bpms };
  }

  const interval = 60 / baseBpm;
  const durationSec = data.length / sampleRate;
  const start = ((beatOffsetSec ?? 0) % interval + interval) % interval;
  const beatTimes = [];
  const followWindowSec = Math.min(0.06, interval * 0.25);
  const followStrength = 0.25;
  const maxNudgeSec = Math.min(0.02, interval * 0.1);

  let onsetIndex = 0;
  for (let t = start; t <= durationSec + 0.001; t += interval) {
    while (onsetIndex < onsetTimes.length && onsetTimes[onsetIndex] < t - followWindowSec) {
      onsetIndex++;
    }
    let adjusted = t;
    if (onsetIndex < onsetTimes.length) {
      const candidate = onsetTimes[onsetIndex];
      if (Math.abs(candidate - t) <= followWindowSec) {
        const delta = candidate - t;
        const nudged = t + delta * followStrength;
        adjusted = t + Math.max(-maxNudgeSec, Math.min(maxNudgeSec, nudged - t));
      }
    }
    if (beatTimes.length > 0) {
      adjusted = Math.max(adjusted, beatTimes[beatTimes.length - 1] + interval * 0.5);
    }
    beatTimes.push(adjusted);
  }

  const bpmMin = baseBpm * 0.96;
  const bpmMax = baseBpm * 1.04;
  const bpms = beatTimes.map((t, i) => {
    if (i === 0) return null;
    const intervalSec = t - beatTimes[i - 1];
    if (intervalSec <= 0) return null;
    const bpm = 60 / intervalSec;
    return Math.max(bpmMin, Math.min(bpmMax, bpm));
  });
  return { beatTimes, bpms };
}

function buildConstantBeatTimes(bpm, durationSec) {
  if (!isFinite(bpm) || bpm <= 0) return [];
  const interval = 60 / bpm;
  const beats = [];
  for (let t = 0; t <= durationSec + 0.001; t += interval) {
    beats.push(t);
  }
  return beats;
}
