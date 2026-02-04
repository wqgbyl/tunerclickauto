import { PitchTracker } from "./dsp/pitchTracker.js";
import { TempoTracker } from "./dsp/tempoTracker.js";
import { createClickBuffer, scheduleMetronome } from "./audio/metronome.js";
import { choosePulseAndGrouping, buildClickGrid } from "./beat_grid.js";

const AI_BASE_URL = "https://oboetunner-navktmnknm.cn-hangzhou.fcapp.run";
const $ = (id) => document.getElementById(id);

const btnStart = $("btnStart");
const btnStop = $("btnStop");
const statusEl = $("status");

const bpmInput = $("bpmInput");
const bpmRange = $("bpmRange");
const bpmRangeVal = $("bpmRangeVal");

const noteNameEl = $("noteName");
const freqHzEl = $("freqHz");
const centsEl = $("cents");
const tempoEl = $("tempo");
const durEl = $("dur");
const tempoLiveEl = $("tempoLive");
const tempoLevelEl = $("tempoLevel");

const btnPlay = $("btnPlay");
const btnStopPlay = $("btnStopPlay");
const metOn = $("metOn");
const metGainPlay = $("metGainPlay");
const metGainPlayVal = $("metGainPlayVal");
const clickOffsetRange = $("clickOffsetRange");
const clickOffsetVal = $("clickOffsetVal");
const metSoloStart = $("metSoloStart");
const metSoloStop = $("metSoloStop");
const metSoloStatus = $("metSoloStatus");
const metSoloGain = $("metSoloGain");
const metSoloGainVal = $("metSoloGainVal");
const meterButtons = Array.from(document.querySelectorAll(".meter-btn"));
const btnExportVideo = $("btnExportVideo");
const exportStatus = $("exportStatus");
const exportLink = $("exportLink");
const exportProgressRow = $("exportProgressRow");
const exportProgress = $("exportProgress");
const exportPercent = $("exportPercent");
const exportActions = $("exportActions");
const btnExportPlayAudio = $("btnExportPlayAudio");
const exportWithMetronome = $("exportWithMetronome");

const uploadAudio = $("uploadAudio");
const btnUploadAnalyze = $("btnUploadAnalyze");
const uploadStatus = $("uploadStatus");

const repOverallScore = $("repOverallScore");
const repLongNoteScore = $("repLongNoteScore");
const repTempoStability = $("repTempoStability");
const repTopNotes = $("repTopNotes");
const aiQuestion = $("aiQuestion");
const aiAskBtn = $("aiAskBtn");
const aiStatus = $("aiStatus");
const aiAnswer = $("aiAnswer");

metGainPlay.addEventListener("input", () => metGainPlayVal.textContent = Number(metGainPlay.value).toFixed(2));
if (clickOffsetRange && clickOffsetVal) {
  const updateClickOffset = (ms) => {
    globalClickOffsetSec = ms / 1000;
    clickOffsetVal.textContent = `${ms.toFixed(0)} ms`;
  };
  clickOffsetRange.addEventListener("input", () => {
    updateClickOffset(Number(clickOffsetRange.value));
  });
  updateClickOffset(Number(clickOffsetRange.value));
}
metSoloGain.addEventListener("input", () => {
  metSoloGainVal.textContent = Number(metSoloGain.value).toFixed(2);
  if (soloMetronome.gainNode) soloMetronome.gainNode.gain.value = Number(metSoloGain.value);
});

const AudioContextClass = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;
let micStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let decodedAudioBuffer = null;
let detectedTempo = null;
let beatTimeline = null;
let analyzedPitchLog = [];
let reportVersion = 0;
let canAskAi = false;
let latestReportPayload = null;
let globalClickOffsetSec = -0.03;

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD_SEC = 0.15;
const PLAY_START_DELAY_SEC = 0.2;

let workletNode = null;
let workletReady = false;

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
  clickTimeline: null,
};
let exportProgressTimer = null;
let soloMetronome = {
  stopScheduler: null,
  gainNode: null,
  meter: 2,
};

btnStart.addEventListener("click", startRecording);
btnStop.addEventListener("click", stopRecording);
btnPlay.addEventListener("click", play);
btnStopPlay.addEventListener("click", stopPlayback);
metSoloStart.addEventListener("click", startSoloMetronome);
metSoloStop.addEventListener("click", stopSoloMetronome);
btnUploadAnalyze.addEventListener("click", analyzeUploadedAudio);
btnExportVideo.addEventListener("click", exportVideo);
btnExportPlayAudio.addEventListener("click", playAudioOnly);
aiAskBtn.addEventListener("click", submitAiQuestion);
uploadAudio.addEventListener("change", () => {
  uploadStatus.textContent = uploadAudio.files?.[0]?.name || "未选择文件";
});
meterButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const meter = Number(btn.dataset.meter);
    if (!Number.isFinite(meter)) return;
    soloMetronome.meter = meter;
    updateMeterButtons();
    if (soloMetronome.stopScheduler) {
      stopSoloMetronome();
      startSoloMetronome();
    }
  });
});
updateMeterButtons();

const BPM_MIN = 40;
const BPM_MAX = 280;
const BPM_DEFAULT = 80;

function clampBpm(value) {
  if (!isFinite(value)) return BPM_DEFAULT;
  return Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(value)));
}

function syncBpmInputs(value, source = "both") {
  const bpm = clampBpm(value);
  if (source !== "number") bpmInput.value = bpm;
  if (source !== "range") bpmRange.value = bpm;
  bpmRangeVal.textContent = bpm;
}

syncBpmInputs(bpmInput.value);
bpmInput.addEventListener("input", () => syncBpmInputs(bpmInput.value, "number"));
bpmRange.addEventListener("input", () => syncBpmInputs(bpmRange.value, "range"));

async function ensureAudioContext() {
  if (audioCtx) return audioCtx;
  if (!AudioContextClass) {
    setStatus("当前浏览器不支持 WebAudio，请使用最新版 Chrome/Edge。");
    throw new Error("WebAudio not supported");
  }
  audioCtx = new AudioContextClass({ latencyHint: "interactive" });
  return audioCtx;
}

async function ensureWorklet(ctx) {
  if (workletReady) return;
  if (!ctx?.audioWorklet?.addModule) {
    throw new Error("AudioWorklet not supported");
  }
  await ctx.audioWorklet.addModule("./src/audio/audio-worklet-processor.js");
  workletReady = true;
}

function decodeAudioDataCompat(ctx, arrayBuffer) {
  if (!ctx || !arrayBuffer) return Promise.reject(new Error("Invalid audio buffer"));
  if (ctx.decodeAudioData.length >= 2) {
    return new Promise((resolve, reject) => {
      ctx.decodeAudioData(arrayBuffer, resolve, reject);
    });
  }
  return ctx.decodeAudioData(arrayBuffer);
}

function decodeWavToAudioBuffer(arrayBuffer, ctx) {
  if (!arrayBuffer || !ctx) throw new Error("Invalid WAV buffer");
  const view = new DataView(arrayBuffer);
  const text = (offset, length) =>
    String.fromCharCode(...new Uint8Array(arrayBuffer.slice(offset, offset + length)));
  if (text(0, 4) !== "RIFF" || text(8, 4) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file");
  }

  let offset = 12;
  let fmt = null;
  let dataOffset = null;
  let dataSize = null;
  while (offset + 8 <= view.byteLength) {
    const chunkId = text(offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;
    if (chunkId === "fmt ") {
      fmt = {
        audioFormat: view.getUint16(chunkDataOffset, true),
        numChannels: view.getUint16(chunkDataOffset + 2, true),
        sampleRate: view.getUint32(chunkDataOffset + 4, true),
        byteRate: view.getUint32(chunkDataOffset + 8, true),
        blockAlign: view.getUint16(chunkDataOffset + 12, true),
        bitsPerSample: view.getUint16(chunkDataOffset + 14, true),
      };
    } else if (chunkId === "data") {
      dataOffset = chunkDataOffset;
      dataSize = chunkSize;
    }
    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (!fmt || dataOffset == null || dataSize == null) {
    throw new Error("Missing WAV chunks");
  }

  const bytesPerSample = fmt.bitsPerSample / 8;
  if (!Number.isInteger(bytesPerSample) || bytesPerSample <= 0) {
    throw new Error("Unsupported WAV bit depth");
  }
  const frameCount = Math.floor(dataSize / fmt.blockAlign);
  if (!frameCount || frameCount <= 0) {
    throw new Error("Empty WAV data");
  }

  const audioBuffer = ctx.createBuffer(fmt.numChannels, frameCount, fmt.sampleRate);
  const isFloat = fmt.audioFormat === 3;
  const isPCM = fmt.audioFormat === 1;
  if (!isFloat && !isPCM) {
    throw new Error("Unsupported WAV format");
  }

  for (let ch = 0; ch < fmt.numChannels; ch += 1) {
    const channelData = audioBuffer.getChannelData(ch);
    for (let i = 0; i < frameCount; i += 1) {
      const sampleOffset = dataOffset + i * fmt.blockAlign + ch * bytesPerSample;
      let sample = 0;
      if (isFloat) {
        sample =
          fmt.bitsPerSample === 64
            ? view.getFloat64(sampleOffset, true)
            : view.getFloat32(sampleOffset, true);
      } else {
        if (fmt.bitsPerSample === 8) {
          sample = (view.getUint8(sampleOffset) - 128) / 128;
        } else if (fmt.bitsPerSample === 16) {
          sample = view.getInt16(sampleOffset, true) / 32768;
        } else if (fmt.bitsPerSample === 24) {
          const b0 = view.getUint8(sampleOffset);
          const b1 = view.getUint8(sampleOffset + 1);
          const b2 = view.getUint8(sampleOffset + 2);
          const raw = (b2 << 16) | (b1 << 8) | b0;
          sample = (raw & 0x800000 ? raw | 0xff000000 : raw) / 8388608;
        } else if (fmt.bitsPerSample === 32) {
          sample = view.getInt32(sampleOffset, true) / 2147483648;
        } else {
          throw new Error("Unsupported PCM bit depth");
        }
      }
      channelData[i] = Math.max(-1, Math.min(1, sample));
    }
  }

  return audioBuffer;
}

function isLikelyWav(file, arrayBuffer) {
  if (file?.type && file.type.toLowerCase().includes("wav")) return true;
  if (file?.name && file.name.toLowerCase().endsWith(".wav")) return true;
  if (!arrayBuffer || arrayBuffer.byteLength < 12) return false;
  const view = new DataView(arrayBuffer);
  const toText = (offset) =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
  return toText(0) === "RIFF" && toText(8) === "WAVE";
}

function getBpmPreset() {
  const bpm = Number(bpmInput.value);
  return clampBpm(bpm);
}

async function startRecording() {
  btnStart.disabled = true;
  btnStop.disabled = false;
  btnPlay.disabled = true;
  btnStopPlay.disabled = true;

  resetUIForNewTake();

  const bpm = getBpmPreset();
  tempoEl.textContent = `♩=${bpm}`;

  let ctx;
  try {
    setStatus("请求麦克风权限…");
    ctx = await ensureAudioContext();
    await ctx.resume();
    await ensureWorklet(ctx);
  } catch (err) {
    console.error("startRecording init failed:", err);
    setStatus("无法启动录音：浏览器不支持 AudioWorklet 或权限被拒绝。");
    btnStart.disabled = false;
    btnStop.disabled = true;
    return;
  }

  hopSize = Math.max(240, Math.round(ctx.sampleRate * 0.01)); // ~10ms
  hopMs = (hopSize / ctx.sampleRate) * 1000;

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
  } catch (err) {
    console.error("getUserMedia failed:", err);
    setStatus("麦克风权限被拒绝或设备不可用。");
    btnStart.disabled = false;
    btnStop.disabled = true;
    return;
  }

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

  try {
    const blob = await stopMediaRecorderSafely();
    setStatus("处理中…");

    if (!blob || blob.size === 0) {
      decodedAudioBuffer = null;
      durEl.textContent = "0.00s";
      btnStart.disabled = false;
      btnPlay.disabled = true;
      btnExportVideo.disabled = true;
      setStatus("未检测到录音内容，可直接重新录制");
      return;
    }

    const ctx = await ensureAudioContext();
    const arrayBuf = await blob.arrayBuffer();
    decodedAudioBuffer = await decodeAudioBufferWithTimeout(ctx, arrayBuf);
  } catch (err) {
    console.error("stopRecording failed:", err);
    decodedAudioBuffer = null;
    durEl.textContent = "0.00s";
    btnStart.disabled = false;
    btnPlay.disabled = true;
    btnExportVideo.disabled = true;
    aiStatus.textContent = "报表生成失败，请重试";
    setStatus("录音处理失败，请重新录制");
    return;
  } finally {
    if (micStream) micStream.getTracks().forEach(t => t.stop());
    micStream = null;

    if (workletNode) {
      workletNode.port.onmessage = null;
      try { workletNode.disconnect(); } catch {}
      workletNode = null;
    }
  }

  durEl.textContent = `${decodedAudioBuffer.duration.toFixed(2)}s`;
  try {
    const report = analyzeAudioBuffer(decodedAudioBuffer, { bpm: getBpmPreset() });
    updateDetectedTempo(report.detectedTempo);
    beatTimeline = report.beatTimeline;
    analyzedPitchLog = report.pitchLog || [];
    renderReport(report);
    setStatus("已录制，准备回放");
  } catch (err) {
    console.error("analyzeAudioBuffer failed:", err);
    beatTimeline = null;
    analyzedPitchLog = [];
    renderReport(null);
    aiStatus.textContent = "报表生成失败，请重试";
    setStatus("已录制，报表生成失败");
  } finally {
    btnStart.disabled = false;
    btnPlay.disabled = false;
    btnExportVideo.disabled = false;
  }
}

function stopMediaRecorderSafely() {
  return new Promise((resolve) => {
    if (!mediaRecorder) return resolve(new Blob());
    const mr = mediaRecorder;
    mediaRecorder = null;

    let settled = false;
    const finalize = () => {
      if (settled) return;
      settled = true;
      resolve(new Blob(recordedChunks, { type: mr.mimeType || "audio/webm" }));
    };

    mr.onstop = finalize;

    if (mr.state === "inactive") {
      return finalize();
    }

    const timeoutId = setTimeout(finalize, 800);
    mr.onstop = () => {
      clearTimeout(timeoutId);
      finalize();
    };

    try {
      if (typeof mr.requestData === "function") {
        try { mr.requestData(); } catch {}
      }
      mr.stop();
    } catch {
      finalize();
    }
  });
}

async function decodeAudioBufferWithTimeout(ctx, arrayBuffer) {
  const timeoutMs = 8000;
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("decode-timeout")), timeoutMs);
  });
  const decodePromise = decodeAudioDataCompat(ctx, arrayBuffer.slice(0));
  try {
    return await Promise.race([decodePromise, timeoutPromise]);
  } catch (error) {
    if (isLikelyWav(null, arrayBuffer)) {
      return decodeWavToAudioBuffer(arrayBuffer, ctx);
    }
    throw error;
  }
}

function computeClickAbsTime(clickT, playStartCtxTime, audioStartOffsetSec, offsetSec) {
  return playStartCtxTime + (clickT - audioStartOffsetSec) + offsetSec;
}

function scheduleClickLookahead(ctx, clicks, {
  playStartCtxTime,
  audioStartOffsetSec,
  clickBuffer,
  clickGainNode,
  scheduleAheadSec = SCHEDULE_AHEAD_SEC,
  lookaheadMs = LOOKAHEAD_MS,
  offsetSec = 0,
  onClickScheduled,
}) {
  if (!clicks?.length) return null;
  let nextIndex = 0;
  const scheduledSources = new Set();

  const scheduleClickAt = (when) => {
    const src = ctx.createBufferSource();
    src.buffer = clickBuffer;
    src.connect(clickGainNode);
    src.start(when);
    scheduledSources.add(src);
    src.onended = () => scheduledSources.delete(src);
    onClickScheduled?.(src);
  };

  const tick = () => {
    const now = ctx.currentTime;
    const maxTime = now + scheduleAheadSec;
    while (nextIndex < clicks.length) {
      const clickT = clicks[nextIndex];
      const absTime = computeClickAbsTime(clickT, playStartCtxTime, audioStartOffsetSec, offsetSec);
      if (absTime < now) {
        nextIndex += 1;
        continue;
      }
      if (absTime <= maxTime) {
        scheduleClickAt(absTime);
        nextIndex += 1;
        continue;
      }
      break;
    }
  };

  const intervalId = setInterval(tick, lookaheadMs);
  tick();
  return () => {
    clearInterval(intervalId);
    scheduledSources.forEach((src) => {
      try { src.stop(); } catch {}
    });
    scheduledSources.clear();
  };
}

function buildBeatGridPeaks() {
  if (beatTimeline?.beatTimes?.length) {
    return beatTimeline.beatTimes.map((t) => ({ t, w: 1 }));
  }
  if (Array.isArray(analyzedPitchLog) && analyzedPitchLog.length) {
    const noteEvents = buildNoteEventsFromPitchLog(analyzedPitchLog);
    if (noteEvents.length) {
      return noteEvents.map((note) => ({ t: note.startSec, w: 1 }));
    }
    return analyzedPitchLog.map((p) => ({ t: p.tSec, w: 1 }));
  }
  return [];
}

function buildNoteEventsFromPitchLog(pitchLog) {
  if (!Array.isArray(pitchLog) || pitchLog.length < 2) return [];
  const span = pitchLog[pitchLog.length - 1].tSec - pitchLog[0].tSec;
  const avg = span / Math.max(1, pitchLog.length - 1);
  const stepSec = Math.min(0.2, Math.max(0.01, avg || 0.03));
  const segments = [];
  let current = null;
  for (const item of pitchLog) {
    if (!current) {
      current = {
        noteName: item.noteName,
        startSec: item.tSec,
        lastSec: item.tSec,
      };
      continue;
    }
    const gap = item.tSec - current.lastSec;
    if (item.noteName === current.noteName && gap <= stepSec * 2) {
      current.lastSec = item.tSec;
    } else {
      segments.push(current);
      current = {
        noteName: item.noteName,
        startSec: item.tSec,
        lastSec: item.tSec,
      };
    }
  }
  if (current) segments.push(current);
  return segments;
}

function buildClickGridTimeline(durationSec, bpmEstimate) {
  const peaks = buildBeatGridPeaks();
  const pulseInfo = choosePulseAndGrouping({ peaks, bpmEstimate });
  const { clicks, beats } = buildClickGrid({
    peaks,
    startTime: 0,
    endTime: durationSec,
    pulsePeriod: pulseInfo.pulsePeriod,
    grouping: pulseInfo.grouping,
  });
  const bpms = beats.map((t, i) => {
    if (i === 0) return null;
    const interval = t - beats[i - 1];
    if (interval <= 0) return null;
    return 60 / interval;
  });
  return { clicks, beats, bpms, pulseInfo };
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

  let ctx;
  try {
    ctx = await ensureAudioContext();
    await ctx.resume();
  } catch (err) {
    console.error("play init failed:", err);
    setStatus("无法启动回放：浏览器不支持 WebAudio。");
    btnPlay.disabled = false;
    btnStopPlay.disabled = true;
    return;
  }
  stopPlayback();

  const bpm = getBpmPreset();
  const bpmEstimate = Number.isFinite(detectedTempo?.bpm) ? detectedTempo.bpm : bpm;
  const useMet = metOn.checked;
  const audioStartOffsetSec = 0;

  const beatGrid = buildClickGridTimeline(decodedAudioBuffer.duration, bpmEstimate);
  playback.clickTimeline = beatGrid;

  const src = ctx.createBufferSource();
  src.buffer = decodedAudioBuffer;

  const musicGain = ctx.createGain();
  musicGain.gain.value = 1.0;
  musicGain.connect(ctx.destination);

  const clickGain = ctx.createGain();
  clickGain.gain.value = Number(metGainPlay.value);
  clickGain.connect(ctx.destination);

  const clickBuffer = createClickBuffer(ctx, { freq: 1700, durationMs: 14 });

  const playStartCtxTime = ctx.currentTime + PLAY_START_DELAY_SEC;
  const firstClickAbsTime = beatGrid.clicks?.length
    ? computeClickAbsTime(beatGrid.clicks[0], playStartCtxTime, audioStartOffsetSec, globalClickOffsetSec)
    : null;
  const firstAudioAbsTime = playStartCtxTime;
  console.log("playback timing", {
    audioCtxTime: ctx.currentTime,
    playStartCtxTime,
    firstClickAbsTime,
    firstAudioAbsTime,
  });

  const stopScheduler = useMet
    ? scheduleClickLookahead(ctx, beatGrid.clicks, {
        playStartCtxTime,
        audioStartOffsetSec,
        clickBuffer,
        clickGainNode: clickGain,
        offsetSec: globalClickOffsetSec,
      })
    : null;

  const initialBpm = beatGrid.bpms?.[1] ?? beatGrid.bpms?.[0] ?? bpmEstimate;
  const { pulsePeriod, beatPeriod, grouping, scores } = beatGrid.pulseInfo;
  const pulseBpm = pulsePeriod > 0 ? 60 / pulsePeriod : 0;
  const beatBpm = beatPeriod > 0 ? 60 / beatPeriod : 0;
  tempoLiveEl.textContent = `♩=${initialBpm.toFixed(0)}`;
  tempoLevelEl.textContent =
    `pulse=${pulseBpm.toFixed(1)} bpm · grouping=${grouping} · beat=${beatBpm.toFixed(1)} bpm` +
    ` · score[g1=${scores.g1.toFixed(2)}, g2=${scores.g2.toFixed(2)}, g3=${scores.g3.toFixed(2)}]`;
  playback.tempoTimers = scheduleTempoUpdates(
    ctx,
    playStartCtxTime,
    { beatTimes: beatGrid.beats, bpms: beatGrid.bpms },
    (tempo) => {
      tempoLiveEl.textContent = `♩=${tempo.toFixed(0)}`;
    },
  );

  src.connect(musicGain);
  src.start(playStartCtxTime, audioStartOffsetSec);

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
  tempoLevelEl.textContent = "—";
}

async function playAudioOnly() {
  if (!decodedAudioBuffer) return;
  btnPlay.disabled = true;
  btnStopPlay.disabled = false;

  let ctx;
  try {
    ctx = await ensureAudioContext();
    await ctx.resume();
  } catch (err) {
    console.error("playAudioOnly init failed:", err);
    setStatus("无法启动回放：浏览器不支持 WebAudio。");
    btnPlay.disabled = false;
    btnStopPlay.disabled = true;
    return;
  }
  stopPlayback();

  const src = ctx.createBufferSource();
  src.buffer = decodedAudioBuffer;
  const musicGain = ctx.createGain();
  musicGain.gain.value = 1.0;
  src.connect(musicGain);
  musicGain.connect(ctx.destination);
  src.start();

  playback.source = src;
  src.onended = () => stopPlayback();
  setStatus("回放中（原始音频）");
}

function renderReport(report) {
  if (!report) {
    repOverallScore.textContent = "—";
    repLongNoteScore.textContent = "—";
    repTempoStability.textContent = "—";
    repTopNotes.textContent = "—";
    aiAnswer.textContent = "—";
    aiStatus.textContent = "等待报表更新…";
    aiAskBtn.disabled = true;
    canAskAi = false;
    latestReportPayload = null;
    return;
  }

  const pitchLog = Array.isArray(report.pitchLog) ? report.pitchLog : [];
  const hasPitchLog = pitchLog.length > 0;
  const { tempoStability } = report;
  const centsAbs = hasPitchLog ? pitchLog.map(x => Math.abs(x.cents)) : [];
  const meanAbs = hasPitchLog ? centsAbs.reduce((a,b)=>a+b,0) / centsAbs.length : null;

  const scoreFromMeanAbs = (value) => {
    const score = 100 - value * 1.5;
    return Math.min(100, Math.max(0, score));
  };

  const estimateStep = () => {
    if (pitchLog.length < 2) return 0.03;
    const span = pitchLog[pitchLog.length - 1].tSec - pitchLog[0].tSec;
    const avg = span / (pitchLog.length - 1);
    return Math.min(0.2, Math.max(0.01, avg || 0.03));
  };

  const stepSec = estimateStep();
  const segments = [];
  let current = null;
  if (hasPitchLog) {
    for (const item of pitchLog) {
      if (!current) {
        current = {
          noteName: item.noteName,
          startSec: item.tSec,
          lastSec: item.tSec,
          centsAbsSum: Math.abs(item.cents),
          count: 1,
        };
        continue;
      }
      const gap = item.tSec - current.lastSec;
      if (item.noteName === current.noteName && gap <= stepSec * 2) {
        current.lastSec = item.tSec;
        current.centsAbsSum += Math.abs(item.cents);
        current.count += 1;
      } else {
        segments.push(current);
        current = {
          noteName: item.noteName,
          startSec: item.tSec,
          lastSec: item.tSec,
          centsAbsSum: Math.abs(item.cents),
          count: 1,
        };
      }
    }
  }
  if (current) segments.push(current);

  const longSegments = segments
    .map((seg) => {
      const duration = (seg.lastSec - seg.startSec) + stepSec;
      return {
        duration,
        meanAbs: seg.centsAbsSum / seg.count,
      };
    })
    .filter(seg => seg.duration >= 0.3);

  const longNoteScore = longSegments.length > 0
    ? (() => {
        const totalDuration = longSegments.reduce((acc, seg) => acc + seg.duration, 0);
        const weightedAbs = longSegments.reduce((acc, seg) => acc + seg.meanAbs * seg.duration, 0) / totalDuration;
        return scoreFromMeanAbs(weightedAbs);
      })()
    : null;

  repOverallScore.textContent = meanAbs === null ? "—" : `${scoreFromMeanAbs(meanAbs).toFixed(1)} / 100`;
  repLongNoteScore.textContent = longNoteScore === null ? "—" : `${longNoteScore.toFixed(1)} / 100`;
  repTempoStability.textContent = tempoStability === null ? "—" : `${tempoStability.toFixed(1)} / 100`;

  const counts = new Map();
  for (const x of pitchLog) counts.set(x.noteName, (counts.get(x.noteName)||0)+1);
  const top = [...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5)
    .map(([k,v])=>`${k}(${v})`).join(", ");
  repTopNotes.textContent = top || "—";

  reportVersion += 1;
  canAskAi = true;
  latestReportPayload = buildReportPayload({
    overallScore: meanAbs === null ? null : scoreFromMeanAbs(meanAbs),
    longNoteScore,
    tempoStability,
    topNotes: top || "—",
    pitchLog,
    durationSec: decodedAudioBuffer?.duration,
  });
  aiStatus.textContent = "可以提问（本次报表限一次）";
  aiAskBtn.disabled = false;
  aiAnswer.textContent = "—";
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
  exportProgressRow.classList.remove("show");
  exportActions.classList.remove("show");
  exportProgress.value = 0;
  exportPercent.textContent = "0%";
  btnExportPlayAudio.disabled = true;

  repOverallScore.textContent = "—";
  repLongNoteScore.textContent = "—";
  repTempoStability.textContent = "—";
  repTopNotes.textContent = "—";
  aiQuestion.value = "";
  aiAnswer.textContent = "—";
  aiStatus.textContent = "等待报表更新…";
  aiAskBtn.disabled = true;
  canAskAi = false;
  latestReportPayload = null;
}

function buildReportPayload({ overallScore, longNoteScore, tempoStability, topNotes, pitchLog, durationSec }) {
  const duration = pitchLog.length > 0
    ? (pitchLog[pitchLog.length - 1].tSec - pitchLog[0].tSec).toFixed(2)
    : (Number.isFinite(durationSec) ? durationSec.toFixed(2) : "0.00");
  return {
    overallScore: Number.isFinite(overallScore) ? Number(overallScore.toFixed(1)) : null,
    longNoteScore: Number.isFinite(longNoteScore) ? Number(longNoteScore.toFixed(1)) : null,
    tempoStability: Number.isFinite(tempoStability) ? Number(tempoStability.toFixed(1)) : null,
    topNotes,
    detectedTempo: Number.isFinite(detectedTempo?.bpm) ? Number(detectedTempo.bpm.toFixed(1)) : null,
    durationSec: Number(duration),
  };
}

async function submitAiQuestion() {
  const question = aiQuestion.value.trim();
  if (!question) {
    aiStatus.textContent = "请先输入问题";
    return;
  }
  if (!canAskAi || !latestReportPayload) {
    aiStatus.textContent = "本次报表已提问，请等待下一次报表更新";
    return;
  }

  aiAskBtn.disabled = true;
  aiStatus.textContent = "AI 分析中…";
  aiAnswer.textContent = "生成中…";

  const payload = {
    question,
    report: latestReportPayload,
  };

  try {
    const resp = await fetch(`${AI_BASE_URL}/api/ai-report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await resp.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (parseErr) {
      console.error("AI response parse failed:", parseErr);
    }
    if (!resp.ok) {
      aiAnswer.textContent = data?.detail || data?.error || text;
      aiStatus.textContent = `AI 请求失败（${resp.status}）`;
      aiAskBtn.disabled = false;
      return;
    }
    if (typeof data?.report === "string" && data.report.length > 0) {
      aiAnswer.textContent = data.report;
      aiStatus.textContent = "完成";
    } else {
      aiAnswer.textContent = `${text}\n\nAI 返回为空`;
      aiStatus.textContent = "AI 返回为空";
    }
    canAskAi = false;
  } catch (err) {
    console.error(err);
    aiAnswer.textContent = err?.message || "AI 请求失败（网络或解析错误）";
    aiStatus.textContent = "AI 请求失败";
    aiAskBtn.disabled = false;
  }
}

function setStatus(s) { statusEl.textContent = s; }
function setSoloStatus(s) { metSoloStatus.textContent = s; }

function updateMeterButtons() {
  meterButtons.forEach((btn) => {
    const meter = Number(btn.dataset.meter);
    btn.classList.toggle("active", meter === soloMetronome.meter);
  });
}

async function startSoloMetronome() {
  if (soloMetronome.stopScheduler) stopSoloMetronome();
  metSoloStart.disabled = true;
  metSoloStop.disabled = false;
  setSoloStatus("启动中…");

  let ctx;
  try {
    ctx = await ensureAudioContext();
    await ctx.resume();
  } catch (err) {
    console.error("startSoloMetronome init failed:", err);
    setSoloStatus("无法启动：浏览器不支持 WebAudio。");
    metSoloStart.disabled = false;
    metSoloStop.disabled = true;
    return;
  }

  const bpm = getBpmPreset();
  const clickStrong = createClickBuffer(ctx, { freq: 1900, durationMs: 16 });
  const clickWeak = createClickBuffer(ctx, { freq: 1400, durationMs: 12 });
  const gain = ctx.createGain();
  gain.gain.value = Number(metSoloGain.value);
  gain.connect(ctx.destination);

  const t0 = ctx.currentTime + 0.05;
  soloMetronome.stopScheduler = scheduleMetronome(ctx, {
    bpm,
    meter: soloMetronome.meter,
    startTime: t0,
    durationSec: Number.POSITIVE_INFINITY,
    clickBufferStrong: clickStrong,
    clickBufferWeak: clickWeak,
    clickGainNode: gain,
  });
  soloMetronome.gainNode = gain;
  setSoloStatus(`运行中（${soloMetronome.meter} 拍子，♩=${bpm}）`);
}

function stopSoloMetronome() {
  if (soloMetronome.stopScheduler) {
    soloMetronome.stopScheduler();
    soloMetronome.stopScheduler = null;
  }
  if (soloMetronome.gainNode) {
    try { soloMetronome.gainNode.disconnect(); } catch {}
    soloMetronome.gainNode = null;
  }
  metSoloStart.disabled = false;
  metSoloStop.disabled = true;
  setSoloStatus("已停止");
}

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
    try {
      decodedAudioBuffer = await decodeAudioDataCompat(ctx, buf.slice(0));
    } catch (decodeError) {
      if (isLikelyWav(file, buf)) {
        decodedAudioBuffer = decodeWavToAudioBuffer(buf, ctx);
      } else {
        throw decodeError;
      }
    }
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
    const typeLabel = file.type ? `${file.type}` : "未知格式";
    uploadStatus.textContent = `解析失败（${typeLabel}），建议导出为 44.1kHz/48kHz PCM WAV 或 MP3 后重试。`;
    if (!AudioContextClass) {
      setStatus("无法解析：浏览器不支持 WebAudio。");
    }
  }
}

async function exportVideo() {
  if (!decodedAudioBuffer) return;
  btnExportVideo.disabled = true;
  btnExportPlayAudio.disabled = true;
  exportStatus.textContent = "导出中…";
  exportLink.classList.remove("show");
  exportLink.removeAttribute("href");
  exportActions.classList.remove("show");
  exportProgressRow.classList.add("show");
  exportProgress.value = 0;
  exportPercent.textContent = "0%";
  if (exportProgressTimer) {
    clearInterval(exportProgressTimer);
    exportProgressTimer = null;
  }

  let ctx;
  try {
    ctx = await ensureAudioContext();
    await ctx.resume();
  } catch (err) {
    console.error("exportVideo init failed:", err);
    exportStatus.textContent = "导出失败：浏览器不支持 WebAudio";
    btnExportVideo.disabled = false;
    return;
  }
  stopPlayback();

  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const c2d = canvas.getContext("2d");
  if (!c2d) {
    exportStatus.textContent = "导出失败：无法创建画布";
    btnExportVideo.disabled = false;
    exportProgressRow.classList.remove("show");
    if (exportProgressTimer) {
      clearInterval(exportProgressTimer);
      exportProgressTimer = null;
    }
    return;
  }

  const stream = canvas.captureStream(30);
  const dest = ctx.createMediaStreamDestination();

  const src = ctx.createBufferSource();
  src.buffer = decodedAudioBuffer;

  const musicGain = ctx.createGain();
  musicGain.gain.value = 1.0;
  const clickGain = ctx.createGain();
  const includeMetronome = exportWithMetronome?.checked ?? true;
  clickGain.gain.value = includeMetronome ? Number(metGainPlay.value) : 0;

  musicGain.connect(dest);
  clickGain.connect(dest);

  src.connect(musicGain);

  const clickBuffer = includeMetronome
    ? createClickBuffer(ctx, { freq: 1700, durationMs: 14 })
    : null;

  const previewGain = ctx.createGain();
  previewGain.gain.value = 0;
  musicGain.connect(previewGain);
  clickGain.connect(previewGain);
  previewGain.connect(ctx.destination);

  const audioStartOffsetSec = 0;
  const playStartCtxTime = ctx.currentTime + PLAY_START_DELAY_SEC;
  const bpmEstimate = Number.isFinite(detectedTempo?.bpm) ? detectedTempo.bpm : getBpmPreset();
  const beatGrid = buildClickGridTimeline(decodedAudioBuffer.duration, bpmEstimate);

  const stopScheduler = includeMetronome
    ? scheduleClickLookahead(ctx, beatGrid.clicks, {
        playStartCtxTime,
        audioStartOffsetSec,
        clickBuffer,
        clickGainNode: clickGain,
        offsetSec: globalClickOffsetSec,
      })
    : null;

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
    exportProgress.value = 100;
    exportPercent.textContent = "100%";
    exportProgressRow.classList.remove("show");
    exportActions.classList.add("show");
    btnExportVideo.disabled = false;
    btnExportPlayAudio.disabled = false;
    if (exportProgressTimer) {
      clearInterval(exportProgressTimer);
      exportProgressTimer = null;
    }
  };

  const durationSec = decodedAudioBuffer.duration;
  const beatTimes = beatGrid.beats;
  const beatBpms = beatGrid.bpms;
  let beatIndex = 0;
  let lastBeatTime = 0;
  let currentBpm = beatBpms?.[1] ?? beatBpms?.[0] ?? bpmEstimate;
  const pitchData = Array.isArray(analyzedPitchLog) ? analyzedPitchLog : [];
  let pitchIndex = 0;
  let currentPitch = null;

  const drawFrame = () => {
    const now = ctx.currentTime;
    const elapsed = now - playStartCtxTime;
    c2d.clearRect(0, 0, canvas.width, canvas.height);
    c2d.fillStyle = "#0b0f14";
    c2d.fillRect(0, 0, canvas.width, canvas.height);

    if (elapsed >= 0) {
      while (beatIndex < beatTimes.length && beatTimes[beatIndex] <= elapsed) {
        lastBeatTime = beatTimes[beatIndex];
        if (beatBpms?.[beatIndex]) {
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
    c2d.fillText(
      includeMetronome ? "同步节拍器导出" : "纯音乐导出",
      centerX,
      centerY + 72,
    );

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
  src.start(playStartCtxTime, audioStartOffsetSec);
  requestAnimationFrame(drawFrame);

  const durationMs = Math.max(1, Math.ceil(durationSec * 1000));
  exportProgressTimer = setInterval(() => {
    const now = ctx.currentTime;
    const elapsed = Math.max(0, now - playStartCtxTime);
    const ratio = Math.min(1, elapsed / durationSec);
    const percent = Math.round(ratio * 100);
    exportProgress.value = percent;
    exportPercent.textContent = `${percent}%`;
    exportStatus.textContent = `导出中…${percent}%`;
  }, 120);

  setTimeout(() => {
    try { recorder.stop(); } catch {}
  }, durationMs + 500);
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

  const detectedTempo = tempoTracker.finalize({ minBPM: 40, maxBPM: 200 });
  const hasReliableTempo = !!(detectedTempo?.bpm && detectedTempo?.confidence >= 0.2);
  const baseBpm = hasReliableTempo ? detectedTempo.bpm : bpm;
  const beatTimeline = computeBeatTimeline(data, sampleRate, localHopSize, {
    baseBpm,
    beatOffsetSec: hasReliableTempo ? detectedTempo.beatOffsetSec : 0,
  });
  const tempoStability = computeTempoStabilityFromBeats(
    beatTimeline,
    detectedTempo?.bpm ?? bpm,
  ) ?? computeTempoStability(
    data,
    sampleRate,
    localHopSize,
    detectedTempo?.bpm ?? bpm,
  );
  return { pitchLog: pitchLogLocal, tempoStability, detectedTempo, beatTimeline };
}

function computeTempoStabilityFromBeats(beatTimeline, bpm) {
  if (!isFinite(bpm) || bpm <= 0) return null;
  if (!beatTimeline || !Array.isArray(beatTimeline.beatTimes)) return null;
  const { beatTimes } = beatTimeline;
  if (beatTimes.length < 3) return null;

  const intervals = [];
  for (let i = 1; i < beatTimes.length; i++) {
    const interval = beatTimes[i] - beatTimes[i - 1];
    if (interval > 0) intervals.push(interval);
  }
  if (intervals.length < 2) return null;

  const intervalMean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const intervalVar = intervals.reduce((a, b) => a + (b - intervalMean) * (b - intervalMean), 0) / intervals.length;
  const intervalStd = Math.sqrt(intervalVar);
  const targetInterval = 60 / bpm;
  const jitterRatio = intervalStd / intervalMean;
  const offsetRatio = Math.abs(intervalMean - targetInterval) / targetInterval;
  const penalty = Math.min(1, jitterRatio * 2 + offsetRatio * 1.5);
  return Math.max(0, 1 - penalty) * 100;
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

  let sum = 0;
  for (let i = 0; i < sm.length; i++) sum += sm[i];
  const mean = sum / sm.length;
  let varianceAcc = 0;
  for (let i = 0; i < sm.length; i++) {
    const delta = sm[i] - mean;
    varianceAcc += delta * delta;
  }
  const variance = varianceAcc / sm.length;
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
