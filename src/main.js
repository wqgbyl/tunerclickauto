import { PitchTracker } from "./dsp/pitchTracker.js";
import { TempoTracker } from "./dsp/tempoTracker.js";
import { createClickBuffer, scheduleMetronome } from "./audio/metronome.js";

const $ = (id) => document.getElementById(id);

const btnStart = $("btnStart");
const btnStop = $("btnStop");
const statusEl = $("status");

const noteNameEl = $("noteName");
const freqHzEl = $("freqHz");
const centsEl = $("cents");
const tempoEl = $("tempo");
const tempoConfEl = $("tempoConf");
const durEl = $("dur");
const beatOffsetEl = $("beatOffset");
const meterEl = $("meter");
const clapEl = $("clap");

const btnPlay = $("btnPlay");
const btnStopPlay = $("btnStopPlay");

const metOnEl = $("metOn");
const accentOnEl = $("accentOn");
const metGainEl = $("metGain");
const metGainValEl = $("metGainVal");

const repMeanAbs = $("repMeanAbs");
const repIn10 = $("repIn10");
const repIn25 = $("repIn25");
const repN = $("repN");
const repTop = $("repTop");

metGainEl.addEventListener("input", () => {
  metGainValEl.textContent = Number(metGainEl.value).toFixed(2);
});

let audioCtx = null;
let micStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let decodedAudioBuffer = null;

let workletNode = null;

const frameSize = 1024;
let hopSize = 480;
let hopMs = 10;

let pitchTracker = null;
let tempoTracker = null;

let analysisTimer = null;

// PCM queue
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

// rolling frame
let rollingFrame = new Float32Array(frameSize);
let rollingInited = false;

// pitch sample log for report
let pitchLog = []; // {tSec, noteName, cents, freqHz}

// clap tracking (energy peak based)
let clapTimes = [];
let clapLocked = false;
let clapIOI = null;
let clapMeter = null; // 3 or 4
let clapBeat0 = 0; // first beat time (sec)

// timekeeping
let hopCount = 0;

// tempo state used for playback
let tempoState = {
  bpm: null,
  confidence: 0,
  beatOffsetSec: 0,
  meter: null,
  source: "auto", // "clap" or "auto"
};

let playback = { source: null, schedulerStop: null };

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

async function startRecording() {
  btnStart.disabled = true;
  btnStop.disabled = false;
  btnPlay.disabled = true;
  btnStopPlay.disabled = true;

  resetUIForNewTake();

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
  const mute = ctx.createGain(); mute.gain.value = 0;

  workletNode = new AudioWorkletNode(ctx, "pcm-grabber");
  src.connect(workletNode).connect(mute).connect(ctx.destination);

  pcmQueue.reset();
  rollingFrame = new Float32Array(frameSize);
  rollingInited = false;

  pitchTracker = new PitchTracker({ sampleRate: ctx.sampleRate });
  tempoTracker = new TempoTracker({ sampleRate: ctx.sampleRate, frameSize, hopSize });

  pitchLog = [];
  hopCount = 0;

  // clap reset
  clapTimes = [];
  clapLocked = false;
  clapIOI = null;
  clapMeter = null;
  clapBeat0 = 0;

  workletNode.port.onmessage = (e) => {
    if (e.data?.type === "pcm") pcmQueue.push(e.data.pcm);
  };

  setStatus("录音中…（先拍手计数，再开始演奏）");

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

  // clap detection first (doesn't block others)
  detectClap(tSec, rollingFrame);

  // pitch update
  const pitch = pitchTracker.pushFrame(rollingFrame);
  if (pitch) {
    noteNameEl.textContent = pitch.noteName;
    freqHzEl.textContent = `${pitch.freqHz.toFixed(1)} Hz`;
    centsEl.textContent = `${pitch.cents} cents`;

    // log for report (downsample: 1 point per ~30ms)
    if (pitchLog.length === 0 || (tSec - pitchLog[pitchLog.length - 1].tSec) > 0.03) {
      pitchLog.push({ tSec, noteName: pitch.noteName, cents: pitch.cents, freqHz: pitch.freqHz });
    }
  }

  // tempo novelty accumulate
  tempoTracker.pushFrame(rollingFrame);

  // UI: clap status live
  if (!clapLocked) {
    clapEl.textContent = `检测到 ${clapTimes.length} 下`;
  } else {
    clapEl.textContent = `已锁定：${clapMeter}/4, IOI≈${clapIOI.toFixed(3)}s`;
  }
}

function detectClap(tSec, frame) {
  // 简单 RMS 峰值检测 + 自适应阈值 + refractory
  // 拍手特征：短时能量高、上升沿快
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  const rms = Math.sqrt(sum / frame.length);

  // 维护一个慢速能量均值作为噪声底
  // 用指数滑动：noise = 0.995*noise + 0.005*rms
  if (detectClap.noise === undefined) detectClap.noise = rms;
  detectClap.noise = 0.995 * detectClap.noise + 0.005 * rms;

  const noise = detectClap.noise;
  const thr = Math.max(0.02, noise * 6); // 动态阈值，且有下限

  const lastT = detectClap.lastT ?? -1e9;
  const refractory = 0.15; // 150ms
  const gapEnd = 0.6; // 若间隔 >0.6s 认为拍手段结束，可锁定

  if (rms > thr && (tSec - lastT) > refractory) {
    detectClap.lastT = tSec;
    clapTimes.push(tSec);

    // 够 3 下后开始评估稳定 IOI
    if (!clapLocked && clapTimes.length >= 3) {
      const d = [];
      for (let i = 1; i < clapTimes.length; i++) d.push(clapTimes[i] - clapTimes[i-1]);
      const med = median(d);
      const mad = median(d.map(x => Math.abs(x - med)));

      // “稳定”条件：MAD 相对中位间隔足够小
      if (med > 0.25 && med < 1.5 && (mad / (med + 1e-9)) < 0.12) {
        clapIOI = med;

        // meter 推断：如果拍手数是 3/4 => 3/4；4/5 => 4/4；7 => 3/4；否则用 mod 逻辑
        const n = clapTimes.length;
        if (n === 3 || n === 7) clapMeter = 3;
        else if (n === 4 || n === 5) clapMeter = 4;
        else {
          // fallback: 看更接近 3 or 4（用最后一次作为 downbeat 的假设）
          clapMeter = (n % 4 === 1) ? 4 : ((n % 3 === 1) ? 3 : 4);
        }

        // 若拍手刚好是 3/4/5/7，基本可以立刻锁定；否则等用户停止拍手（gapEnd）再锁
        if (n === 3 || n === 4 || n === 5 || n === 7) {
          clapLocked = true;
          clapBeat0 = clapTimes[0]; // 第一拍位置
        }
      }
    }
  }

  // 如果已经有稳定 IOI，但未锁定，检测“停止拍手的间隔”来锁定
  if (!clapLocked && clapIOI && clapTimes.length >= 3) {
    const last = clapTimes[clapTimes.length - 1];
    if ((tSec - last) > Math.max(gapEnd, 1.8 * clapIOI)) {
      clapLocked = true;
      clapBeat0 = clapTimes[0];
      // meter 再兜底一次
      const n = clapTimes.length;
      if (!clapMeter) clapMeter = (n % 4 === 0 || n % 4 === 1) ? 4 : 3;
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

  // decode
  const ctx = await ensureAudioContext();
  const arrayBuf = await blob.arrayBuffer();
  decodedAudioBuffer = await ctx.decodeAudioData(arrayBuf.slice(0));
  durEl.textContent = `${decodedAudioBuffer.duration.toFixed(2)}s`;

  // Tempo finalize (auto)
  const auto = tempoTracker.finalize({ minBPM: 40, maxBPM: 200 });
  tempoTracker.reset();

  // Choose clap-first if locked and stable
  if (clapLocked && clapIOI) {
    const bpm = Math.round(60 / clapIOI);
    tempoState = {
      bpm,
      confidence: 1.0,
      beatOffsetSec: clapBeat0, // 第一拍相对录音起点
      meter: clapMeter || 4,
      source: "clap",
    };
  } else {
    tempoState = {
      bpm: auto.bpm,
      confidence: auto.confidence,
      beatOffsetSec: auto.beatOffsetSec,
      meter: 4, // 未锁定拍手时不强求拍号，默认4；你后续可做 meter 自动识别
      source: "auto",
    };
  }

  // UI tempo
  if (tempoState.bpm) {
    tempoEl.textContent = `♩=${tempoState.bpm}`;
    tempoConfEl.textContent = tempoState.confidence.toFixed(2);
    beatOffsetEl.textContent = `${tempoState.beatOffsetSec.toFixed(3)}s`;
    meterEl.textContent = `${tempoState.meter}/4 (${tempoState.source})`;
  } else {
    tempoEl.textContent = "♩=—";
    tempoConfEl.textContent = "0.00";
    beatOffsetEl.textContent = "—";
    meterEl.textContent = "—";
  }

  // report
  renderReport(pitchLog);

  btnStart.disabled = false;
  btnPlay.disabled = false;
  setStatus("已录制，准备回放（建议用“回放”按钮，不要用浏览器音频控件）");
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

  const useMet = metOnEl.checked && !!tempoState.bpm;
  const bpm = tempoState.bpm || 0;
  const beatOffsetSec = tempoState.beatOffsetSec || 0;
  const meter = tempoState.meter || 4;

  const src = ctx.createBufferSource();
  src.buffer = decodedAudioBuffer;

  const musicGain = ctx.createGain();
  musicGain.gain.value = 1.0;
  musicGain.connect(ctx.destination);

  const clickGain = ctx.createGain();
  clickGain.gain.value = Number(metGainEl.value);
  clickGain.connect(ctx.destination);

  // strong/weak clicks
  const clickStrong = createClickBuffer(ctx, { freq: 1900, durationMs: 16 });
  const clickWeak = createClickBuffer(ctx, { freq: 1400, durationMs: 12 });

  const startDelay = 0.03;
  const t0 = ctx.currentTime + startDelay;

  let stopScheduler = null;
  if (useMet && bpm > 0) {
    if (accentOnEl.checked) {
      stopScheduler = scheduleMetronome(ctx, {
        bpm,
        meter,
        startTime: t0 + beatOffsetSec,
        durationSec: decodedAudioBuffer.duration,
        clickBufferStrong: clickStrong,
        clickBufferWeak: clickWeak,
        clickGainNode: clickGain,
      });
    } else {
      // no accent: use strong buffer for all
      stopScheduler = scheduleMetronome(ctx, {
        bpm,
        meter: 999999,
        startTime: t0 + beatOffsetSec,
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
  playback.schedulerStop = stopScheduler;

  src.onended = () => stopPlayback();
  setStatus(useMet ? "回放中（节拍器已同步/对齐）" : "回放中（节拍器关闭/无BPM）");
}

function stopPlayback() {
  if (playback.source) {
    try { playback.source.stop(); } catch {}
    playback.source = null;
  }
  if (playback.schedulerStop) {
    playback.schedulerStop();
    playback.schedulerStop = null;
  }
  btnPlay.disabled = !decodedAudioBuffer;
  btnStopPlay.disabled = true;
  if (decodedAudioBuffer) setStatus("已录制，准备回放");
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
  tempoEl.textContent = "♩=—";
  tempoConfEl.textContent = "—";
  durEl.textContent = "—";
  beatOffsetEl.textContent = "—";
  meterEl.textContent = "—";
  clapEl.textContent = "—";
  repMeanAbs.textContent = "—";
  repIn10.textContent = "—";
  repIn25.textContent = "—";
  repN.textContent = "—";
  repTop.textContent = "—";
}

function setStatus(s) { statusEl.textContent = s; }

function median(arr) {
  if (!arr.length) return 0;
  const a = arr.slice().sort((x,y)=>x-y);
  const mid = Math.floor(a.length/2);
  return a.length%2 ? a[mid] : 0.5*(a[mid-1]+a[mid]);
}
