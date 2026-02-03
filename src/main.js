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

const btnPlay = $("btnPlay");
const btnStopPlay = $("btnStopPlay");
const metOn = $("metOn");
const metGainPlay = $("metGainPlay");
const metGainPlayVal = $("metGainPlayVal");

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
};

btnStart.addEventListener("click", startRecording);
btnStop.addEventListener("click", stopRecording);
btnPlay.addEventListener("click", play);
btnStopPlay.addEventListener("click", stopPlayback);
btnUploadAnalyze.addEventListener("click", analyzeUploadedAudio);
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
  renderReport(report);

  btnStart.disabled = false;
  btnPlay.disabled = false;
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

async function play() {
  if (!decodedAudioBuffer) return;

  btnPlay.disabled = true;
  btnStopPlay.disabled = false;

  const ctx = await ensureAudioContext();
  await ctx.resume();
  stopPlayback();

  const bpm = getBpmPreset();
  const useMet = metOn.checked;

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
  const tempoConfidenceThreshold = 0.5;
  const metOffset = (useMet && detectedTempo?.beatOffsetSec != null && detectedTempo.confidence >= tempoConfidenceThreshold)
    ? Math.max(0, detectedTempo.beatOffsetSec)
    : 0;
  const metStartTime = t0 + metOffset;
  const metDurationSec = Math.max(0, decodedAudioBuffer.duration - metOffset);

  let stopScheduler = null;
  if (useMet) {
    stopScheduler = scheduleMetronome(ctx, {
      bpm,
      meter: 999999,
      startTime: metStartTime,
      durationSec: metDurationSec,
      clickBufferStrong: clickStrong,
      clickBufferWeak: clickStrong,
      clickGainNode: clickGain,
    });
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
  btnPlay.disabled = !decodedAudioBuffer;
  btnStopPlay.disabled = true;
  if (decodedAudioBuffer) setStatus("已录制，准备回放");
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
  noteNameEl.textContent = "—";
  freqHzEl.textContent = "—";
  centsEl.textContent = "—";
  durEl.textContent = "—";

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
    renderReport(report);

    btnPlay.disabled = false;
    uploadStatus.textContent = "分析完成";
    setStatus("已上传音频，准备回放");
  } catch (err) {
    console.error(err);
    uploadStatus.textContent = "解析失败，请尝试其他音频格式";
  }
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
  return { pitchLog: pitchLogLocal, tempoStability, detectedTempo };
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
