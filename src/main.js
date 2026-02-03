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

const uploadAudio = $("uploadAudio");
const btnUploadAnalyze = $("btnUploadAnalyze");
const uploadStatus = $("uploadStatus");

const repOverallScore = $("repOverallScore");
const repLongNoteScore = $("repLongNoteScore");
const repTempoStability = $("repTempoStability");
const repTopNotes = $("repTopNotes");

metGainPlay.addEventListener("input", () => metGainPlayVal.textContent = Number(metGainPlay.value).toFixed(2));
metSoloGain.addEventListener("input", () => {
  metSoloGainVal.textContent = Number(metSoloGain.value).toFixed(2);
  if (soloMetronome.gainNode) soloMetronome.gainNode.gain.value = Number(metSoloGain.value);
});

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
  try {
    const arrayBuf = await blob.arrayBuffer();
    decodedAudioBuffer = await ctx.decodeAudioData(arrayBuf.slice(0));
  } catch (err) {
    decodedAudioBuffer = null;
    durEl.textContent = "0.00s";
    btnStart.disabled = false;
    btnPlay.disabled = true;
    btnExportVideo.disabled = true;
    setStatus("录音为空或解码失败，可直接重新录制");
    return;
  }

  durEl.textContent = `${decodedAudioBuffer.duration.toFixed(2)}s`;

  const report = analyzeAudioBuffer(decodedAudioBuffer, { bpm: getBpmPreset() });
  updateDetectedTempo(report.detectedTempo);
  beatTimeline = report.beatTimeline;
  analyzedPitchLog = report.pitchLog || [];
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

    try { mr.stop(); } catch { finalize(); }
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

async function playAudioOnly() {
  if (!decodedAudioBuffer) return;
  btnPlay.disabled = true;
  btnStopPlay.disabled = false;

  const ctx = await ensureAudioContext();
  await ctx.resume();
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
  if (!report || !report.pitchLog || report.pitchLog.length === 0) {
    repOverallScore.textContent = "—";
    repLongNoteScore.textContent = "—";
    repTempoStability.textContent = "—";
    repTopNotes.textContent = "—";
    return;
  }
  const { pitchLog, tempoStability } = report;
  const centsAbs = pitchLog.map(x => Math.abs(x.cents));
  const meanAbs = centsAbs.reduce((a,b)=>a+b,0) / centsAbs.length;

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

  repOverallScore.textContent = `${scoreFromMeanAbs(meanAbs).toFixed(1)} / 100`;
  repLongNoteScore.textContent = longNoteScore === null ? "—" : `${longNoteScore.toFixed(1)} / 100`;
  repTempoStability.textContent = tempoStability === null ? "—" : `${tempoStability.toFixed(1)} / 100`;

  const counts = new Map();
  for (const x of pitchLog) counts.set(x.noteName, (counts.get(x.noteName)||0)+1);
  const top = [...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5)
    .map(([k,v])=>`${k}(${v})`).join(", ");
  repTopNotes.textContent = top || "—";
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

  const ctx = await ensureAudioContext();
  await ctx.resume();

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
  clickGain.gain.value = Number(metGainPlay.value);

  musicGain.connect(dest);
  clickGain.connect(dest);

  src.connect(musicGain);

  const clickStrong = createClickBuffer(ctx, { freq: 1900, durationMs: 16 });
  const clickWeak = createClickBuffer(ctx, { freq: 1400, durationMs: 12 });

  const previewGain = ctx.createGain();
  previewGain.gain.value = 0;
  musicGain.connect(previewGain);
  clickGain.connect(previewGain);
  previewGain.connect(ctx.destination);

  const startDelay = 0.1;
  const t0 = ctx.currentTime + startDelay;
  const useDynamicBeats = !!(beatTimeline?.beatTimes?.length && beatTimeline.beatTimes.length >= 3);
  const constantBeatTimes = buildConstantBeatTimes(getBpmPreset(), decodedAudioBuffer.duration);
  const constantBpms = constantBeatTimes.map((t, i) => (i === 0 ? null : getBpmPreset()));
  const activeTimeline = useDynamicBeats
    ? beatTimeline
    : { beatTimes: constantBeatTimes, bpms: constantBpms };

  const stopScheduler = scheduleDynamicMetronome(ctx, activeTimeline, {
    startTime: t0,
    clickBufferStrong: clickStrong,
    clickBufferWeak: clickWeak,
    clickGainNode: clickGain,
  });

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
  const beatTimes = activeTimeline.beatTimes;
  const beatBpms = activeTimeline.bpms;
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

  const durationMs = Math.max(1, Math.ceil(durationSec * 1000));
  exportProgressTimer = setInterval(() => {
    const now = ctx.currentTime;
    const elapsed = Math.max(0, now - t0);
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
