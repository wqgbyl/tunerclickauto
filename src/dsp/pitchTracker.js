import { freqToNote } from "./pitchUtils.js";

export class PitchTracker {
  constructor({ sampleRate, minFreq = 70, maxFreq = 1600 } = {}) {
    this.sampleRate = sampleRate;
    this.minFreq = minFreq;
    this.maxFreq = maxFreq;
    this._last = null;
  }

  pushFrame(frame) {
    const freq = estimateF0_YINlite(frame, this.sampleRate, this.minFreq, this.maxFreq);
    if (!freq) return null;
    const { noteName, cents } = freqToNote(freq);
    this._last = { freqHz: freq, noteName, cents };
    return this._last;
  }

  get last() { return this._last; }
}

function estimateF0_YINlite(frame, sr, minFreq, maxFreq) {
  // 更低的能量门限：手机端更容易有偏小振幅
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  const rms = Math.sqrt(sum / frame.length);
  if (rms < 0.003) return null;

  const n = frame.length;
  const minLag = Math.floor(sr / maxFreq);
  const maxLag = Math.floor(sr / minFreq);

  const d = new Float32Array(maxLag + 1);
  for (let tau = minLag; tau <= maxLag; tau++) {
    let s = 0;
    for (let i = 0; i + tau < n; i++) {
      const diff = frame[i] - frame[i + tau];
      s += diff * diff;
    }
    d[tau] = s;
  }

  const cmnd = new Float32Array(maxLag + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= maxLag; tau++) {
    running += d[tau];
    cmnd[tau] = d[tau] * tau / (running + 1e-12);
  }

  const threshold = 0.12;
  let tau0 = -1;
  for (let tau = minLag; tau <= maxLag; tau++) {
    if (cmnd[tau] < threshold) {
      while (tau + 1 <= maxLag && cmnd[tau + 1] < cmnd[tau]) tau++;
      tau0 = tau;
      break;
    }
  }
  if (tau0 < 0) return null;

  const betterTau = parabolicInterp(cmnd, tau0);
  const f0 = sr / betterTau;
  if (!isFinite(f0) || f0 < minFreq || f0 > maxFreq) return null;
  return f0;
}

function parabolicInterp(arr, i) {
  const x0 = i - 1, x1 = i, x2 = i + 1;
  if (x0 < 0 || x2 >= arr.length) return i;
  const y0 = arr[x0], y1 = arr[x1], y2 = arr[x2];
  const denom = (y0 - 2*y1 + y2);
  if (Math.abs(denom) < 1e-12) return i;
  const delta = 0.5 * (y0 - y2) / denom;
  return i + delta;
}
