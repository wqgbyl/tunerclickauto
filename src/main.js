import { PitchTracker } from "./dsp/pitchTracker.js";
import { TempoTracker } from "./dsp/tempoTracker.js";
import { createClickBuffer, scheduleMetronome } from "./audio/metronome.js";

const $ = (id) => document.getElementById(id);

const btnStart = $("btnStart");
const btnStop = $("btnStop");
const statusEl = $("status");

const bpmInput = $("bpmInput");
const metDuringRec = $("metDuringRec");
const metGainRec = $("metGainRec");
const metGainRecVal = $("metGainRecVal");
const ledBeat = $("ledBeat");

const noteNameEl = $("noteName");
const freqHzEl = $("freqHz");
const centsEl = $("cents");
const tempoEl = $("tempo");
const durEl = $("dur");
const detectedBpmEl = $("detectedBpm");
const detectedConfEl = $("detectedConf");
const detectedStartEl = $("detectedStart");
const detectedRangeEl = $("detectedRange");
const detectedDominantEl = $("detectedDominant");
const detectedScoreEl = $("detectedScore");

const btnPlay = $("btnPlay");
const btnStopPlay = $("btnStopPlay");
const metOn = $("metOn");
const metGainPlay = $("metGainPlay");
const metGainPlayVal = $("metGainPlayVal");

const repMeanAbs = $("repMeanAbs");
const repIn10 = $("repIn10");
const repIn25 = $("repIn25");
const repN = $("repN");
const repTop = $("repTop");

metGainRec.addEventListener("input", () => metGainRecVal.textContent = Number(metGainRec.value).toFixed(2));
metGainPlay.addEventListener("input", () => metGainPlayVal.textContent = Number(metGainPlay.value).toFixed(2));

let audioCtx = null;
let micStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let decodedAudioBuffer = null;

let workletNode = null;

// analysis
const frameSize = 1024;
let hopSize = 480;
let hopMs = 10;

let pitchTracker = null;
let analysisTimer = null;
let detectedTempo = {
  bpm: null,
  confidence: 0,
  beatOffsetSec: null,
  tempoCurve: [],
  beatTimes: [],
  stats: null,
};

const tempoConfidenceThreshold = 0.35;

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

// metronome during recording
let recMet = {
  stopScheduler: null,
  gainNode: null,
  startTime: 0,
  bpm: 0,
  ledTimer: null,
};

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

  // Start metronome DURING recording (sound + LED)
  if (metDuringRec.checked) startRecordingMetronome(ctx, bpm);

  setStatus("录音中…（节拍器已启动）");

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

  stopRecordingMetronome();

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

  const tempoResult = analyzeTempoOffline(decodedAudioBuffer);
  updateDetectedTempo(tempoResult);

  renderReport(pitchLog);

  btnStart.disabled = false;
  btnPlay.disabled = false;
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

function startRecordingMetronome(ctx, bpm) {
  stopRecordingMetronome();
  recMet.bpm = bpm;

  const gain = ctx.createGain();
  gain.gain.value = Number(metGainRec.value);
  gain.connect(ctx.destination);

  const clickStrong = createClickBuffer(ctx, { freq: 1900, durationMs: 16 });
  const clickWeak = createClickBuffer(ctx, { freq: 1400, durationMs: 12 });

  // Start a tiny bit later to reduce "button press" jitter
  const startDelay = 0.03;
  const t0 = ctx.currentTime + startDelay;
  recMet.startTime = t0;
  recMet.gainNode = gain;

  // Use meter=2 with strong/weak = beat/half-beat? We'll schedule at quarter-note BPM and use LED for half-beat separately.
  recMet.stopScheduler = scheduleMetronome(ctx, {
    bpm,
    meter: 999999, // no accent in audio (all strong)
    startTime: t0,
    durationSec: 3600, // effectively until stop
    clickBufferStrong: clickStrong,
    clickBufferWeak: clickStrong,
    clickGainNode: gain,
  });

  // LED timer: flash on beat and half-beat
  if (recMet.ledTimer) clearInterval(recMet.ledTimer);
  recMet.ledTimer = setInterval(() => {
    const now = ctx.currentTime;
    const dt = now - recMet.startTime;
    if (dt < 0) return;
    const interval = 60 / bpm;
    const phase = dt % interval;
    const halfPhase = dt % (interval / 2);

    // beat flash window
    if (phase < 0.03) setLed("on");
    else if (halfPhase < 0.03) setLed("half");
    else setLed("off");
  }, 10);
}

function stopRecordingMetronome() {
  if (recMet.stopScheduler) { recMet.stopScheduler(); recMet.stopScheduler = null; }
  if (recMet.ledTimer) { clearInterval(recMet.ledTimer); recMet.ledTimer = null; }
  if (recMet.gainNode) { try { recMet.gainNode.disconnect(); } catch {} recMet.gainNode = null; }
  setLed("off");
}

function setLed(mode) {
  ledBeat.classList.remove("on","half");
  if (mode === "on") ledBeat.classList.add("on");
  else if (mode === "half") ledBeat.classList.add("half");
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
  const metOffset = (useMet && detectedTempo.beatOffsetSec != null && detectedTempo.confidence >= tempoConfidenceThreshold)
    ? detectedTempo.beatOffsetSec
    : 0;
  const metStartTime = t0 + metOffset;

  let stopScheduler = null;
  if (useMet) {
    if (detectedTempo.stats?.hasReliableCurve && detectedTempo.beatTimes.length) {
      stopScheduler = scheduleAdaptiveMetronome(ctx, {
        beatTimes: detectedTempo.beatTimes,
        startTime: t0,
        clickBuffer: clickStrong,
        clickGainNode: clickGain,
      });
    } else {
      stopScheduler = scheduleMetronome(ctx, {
        bpm,
        meter: 999999,
        startTime: metStartTime,
        durationSec: decodedAudioBuffer.duration,
        clickBufferStrong: clickStrong,
        clickBufferWeak: clickStrong,
        clickGainNode: clickGain,
      });
    }
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

function analyzeTempoOffline(buffer) {
  const sampleRate = buffer.sampleRate;
  const channelData = mixdownToMono(buffer);
  const tempoTracker = new TempoTracker({ sampleRate, frameSize, hopSize });

  for (let i = 0; i + frameSize <= channelData.length; i += hopSize) {
    tempoTracker.pushFrame(channelData.subarray(i, i + frameSize));
  }

  const result = tempoTracker.finalize();
  const hopSec = hopSize / sampleRate;
  const tempoCurve = buildTempoCurve(result.sm, hopSec, buffer.duration);
  const stats = summarizeTempoCurve(tempoCurve);
  const beatTimes = buildBeatTimeline({
    tempoCurve,
    beatOffsetSec: result.beatOffsetSec,
    durationSec: buffer.duration,
    fallbackBpm: result.bpm ?? getBpmPreset(),
  });

  return {
    ...result,
    tempoCurve,
    stats,
    beatTimes,
  };
}

function updateDetectedTempo(result) {
  if (!result) return;
  const { bpm, confidence, beatOffsetSec, stats, beatTimes } = result;
  const confPct = `${(confidence * 100).toFixed(1)}%`;
  detectedConfEl.textContent = confPct;

  if (bpm && confidence >= tempoConfidenceThreshold) {
    detectedTempo = {
      bpm,
      confidence,
      beatOffsetSec,
      tempoCurve: result.tempoCurve ?? [],
      beatTimes: beatTimes ?? [],
      stats,
    };
    detectedBpmEl.textContent = `${bpm}`;
    tempoEl.textContent = `♩=${getBpmPreset()}`;
    setStatus("已录制，检测到 BPM，可回放对齐节拍");
  } else {
    detectedTempo = {
      bpm: null,
      confidence,
      beatOffsetSec: null,
      tempoCurve: result.tempoCurve ?? [],
      beatTimes: [],
      stats,
    };
    detectedBpmEl.textContent = bpm
      ? `${bpm}（低置信度，请手动设置 BPM）`
      : "低置信度，请手动设置 BPM";
    setStatus("已录制，检测 BPM 置信度不足，请手动设置");
  }

  updateTempoStatsUI(stats);
}

function updateTempoStatsUI(stats) {
  if (!stats) {
    detectedStartEl.textContent = "—";
    detectedRangeEl.textContent = "—";
    detectedDominantEl.textContent = "—";
    detectedScoreEl.textContent = "—";
    return;
  }
  detectedStartEl.textContent = stats.startBpm ? `${stats.startBpm} BPM` : "—";
  detectedRangeEl.textContent = stats.minBpm && stats.maxBpm
    ? `${stats.minBpm}–${stats.maxBpm} BPM`
    : "—";
  detectedDominantEl.textContent = stats.dominantBpm ? `${stats.dominantBpm} BPM` : "—";
  detectedScoreEl.textContent = stats.score != null ? `${stats.score.toFixed(0)} 分` : "—";
}

function mixdownToMono(buffer) {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const length = buffer.length;
  const mono = new Float32Array(length);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) mono[i] += data[i];
  }
  for (let i = 0; i < length; i++) mono[i] /= buffer.numberOfChannels;
  return mono;
}

function buildTempoCurve(sm, hopSec, durationSec, minBPM = 40, maxBPM = 200) {
  if (!sm || !sm.length) return [];
  const windowSec = 8;
  const stepSec = 1.5;
  const windowFrames = Math.max(8, Math.floor(windowSec / hopSec));
  const stepFrames = Math.max(1, Math.floor(stepSec / hopSec));
  const curve = [];

  for (let start = 0; start + windowFrames <= sm.length; start += stepFrames) {
    const end = start + windowFrames;
    const timeSec = Math.min(durationSec, (start + windowFrames / 2) * hopSec);
    const { bpm, confidence } = estimateBpmFromOnset(sm, hopSec, start, end, minBPM, maxBPM);
    if (bpm) curve.push({ timeSec, bpm, confidence });
  }
  return curve;
}

function estimateBpmFromOnset(sm, hopSec, startIdx, endIdx, minBPM, maxBPM) {
  const seg = sm.slice(startIdx, endIdx);
  if (seg.length < 8) return { bpm: null, confidence: 0 };

  let maxVal = 1e-12;
  for (const v of seg) if (v > maxVal) maxVal = v;
  for (let i = 0; i < seg.length; i++) seg[i] /= maxVal;

  const minLag = Math.floor((60 / maxBPM) / hopSec);
  const maxLag = Math.min(seg.length - 2, Math.floor((60 / minBPM) / hopSec));
  if (maxLag <= minLag) return { bpm: null, confidence: 0 };

  const acf = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < seg.length; i++) s += seg[i] * seg[i + lag];
    acf[lag] = s;
  }

  const peaks = [];
  for (let lag = minLag + 1; lag < maxLag - 1; lag++) {
    if (acf[lag] > acf[lag - 1] && acf[lag] > acf[lag + 1]) peaks.push({ lag, val: acf[lag] });
  }
  if (!peaks.length) return { bpm: null, confidence: 0 };

  peaks.sort((a, b) => b.val - a.val);
  const top = peaks.slice(0, 6);
  const totalStrength = top.reduce((s, p) => s + p.val, 1e-9);
  const best = top[0];
  const bpm = Math.round(60 / (best.lag * hopSec));
  const confidence = best.val / totalStrength;
  return { bpm, confidence };
}

function summarizeTempoCurve(curve) {
  if (!curve.length) return null;
  const reliable = curve.filter((p) => p.confidence >= tempoConfidenceThreshold);
  if (!reliable.length) return { hasReliableCurve: false };
  const bpms = reliable.map((p) => p.bpm);
  const startBpm = reliable[0]?.bpm ?? null;
  const minBpm = Math.min(...bpms);
  const maxBpm = Math.max(...bpms);

  const histogram = new Map();
  for (const bpm of bpms) {
    const key = Math.round(bpm);
    histogram.set(key, (histogram.get(key) || 0) + 1);
  }
  const sorted = [...histogram.entries()].sort((a, b) => b[1] - a[1]);
  const dominantBpm = sorted[0]?.[0] ?? null;
  const dominantRatio = sorted[0]?.[1] ? sorted[0][1] / bpms.length : 0;
  const score = Math.min(100, Math.max(0, dominantRatio * 100));

  return {
    hasReliableCurve: true,
    startBpm,
    minBpm,
    maxBpm,
    dominantBpm,
    score,
  };
}

function buildBeatTimeline({ tempoCurve, beatOffsetSec, durationSec, fallbackBpm }) {
  if (!tempoCurve.length || !isFinite(durationSec)) return [];
  const sorted = [...tempoCurve].sort((a, b) => a.timeSec - b.timeSec);
  const beats = [];
  let t = Math.max(0, beatOffsetSec || 0);
  let idx = 0;
  while (t < durationSec) {
    while (idx + 1 < sorted.length && sorted[idx + 1].timeSec <= t) idx++;
    const bpm = sorted[idx]?.bpm || fallbackBpm;
    const interval = bpm ? 60 / bpm : 0;
    if (!interval) break;
    beats.push(t);
    t += interval;
  }
  return beats;
}

function scheduleAdaptiveMetronome(ctx, { beatTimes, startTime, clickBuffer, clickGainNode }) {
  const sources = [];
  for (const beatTime of beatTimes) {
    const src = ctx.createBufferSource();
    src.buffer = clickBuffer;
    src.connect(clickGainNode);
    src.start(startTime + beatTime);
    sources.push(src);
  }
  return () => {
    for (const src of sources) {
      try { src.stop(); } catch {}
      try { src.disconnect(); } catch {}
    }
  };
}

function renderReport(log) {
  if (!log || log.length === 0) {
    repMeanAbs.textContent = "—";
    repIn10.textContent = "—";
    repIn25.textContent = "—";
    repN.textContent = "0";
    repTop.textContent = "—";
    return;
  }
  const centsAbs = log.map(x => Math.abs(x.cents));
  const meanAbs = centsAbs.reduce((a,b)=>a+b,0) / centsAbs.length;
  const in10 = centsAbs.filter(x => x <= 10).length / centsAbs.length;
  const in25 = centsAbs.filter(x => x <= 25).length / centsAbs.length;

  repMeanAbs.textContent = meanAbs.toFixed(1);
  repIn10.textContent = (in10*100).toFixed(1) + "%";
  repIn25.textContent = (in25*100).toFixed(1) + "%";
  repN.textContent = String(log.length);

  const counts = new Map();
  for (const x of log) counts.set(x.noteName, (counts.get(x.noteName)||0)+1);
  const top = [...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5)
    .map(([k,v])=>`${k}(${v})`).join(", ");
  repTop.textContent = top || "—";
}

function resetUIForNewTake() {
  noteNameEl.textContent = "—";
  freqHzEl.textContent = "—";
  centsEl.textContent = "—";
  durEl.textContent = "—";
  detectedBpmEl.textContent = "—";
  detectedConfEl.textContent = "—";
  detectedStartEl.textContent = "—";
  detectedRangeEl.textContent = "—";
  detectedDominantEl.textContent = "—";
  detectedScoreEl.textContent = "—";
  detectedTempo = {
    bpm: null,
    confidence: 0,
    beatOffsetSec: null,
    tempoCurve: [],
    beatTimes: [],
    stats: null,
  };

  repMeanAbs.textContent = "—";
  repIn10.textContent = "—";
  repIn25.textContent = "—";
  repN.textContent = "—";
  repTop.textContent = "—";

  setLed("off");
}

function setStatus(s) { statusEl.textContent = s; }
