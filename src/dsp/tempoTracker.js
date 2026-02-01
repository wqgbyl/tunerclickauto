import { magnitudeSpectrumFromTimeDomain } from "./fft.js";

export class TempoTracker {
  constructor({ sampleRate, frameSize = 1024, hopSize = 480 } = {}) {
    this.sampleRate = sampleRate;
    this.frameSize = frameSize;
    this.hopSize = hopSize;
    this.hopSeconds = hopSize / sampleRate;

    this._prevRms = 0;
    this._prevMag = null;
    this._pairs = []; // {flux, rmsDiff}
  }

  pushFrame(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    const rmsDiff = Math.max(0, rms - this._prevRms);
    this._prevRms = rms;

    const mag = magnitudeSpectrumFromTimeDomain(frame);
    let flux = 0;
    if (!this._prevMag) {
      this._prevMag = new Float32Array(mag.length);
      this._prevMag.set(mag);
    } else {
      for (let i = 0; i < mag.length; i++) {
        const d = mag[i] - this._prevMag[i];
        if (d > 0) flux += d;
        this._prevMag[i] = mag[i];
      }
    }
    this._pairs.push({ flux, rmsDiff });
  }

  // 返回：bpm/confidence/beatOffsetSec（beatOffsetSec 是“第一拍”相对录音起点的偏移）
  finalize({ minBPM = 40, maxBPM = 200 } = {}) {
    const dur = this._pairs.length * this.hopSeconds;
    if (dur < 3) return { bpm: null, confidence: 0, beatOffsetSec: 0, sm: null };

    let maxFlux = 1e-12, maxRms = 1e-12;
    for (const x of this._pairs) {
      if (x.flux > maxFlux) maxFlux = x.flux;
      if (x.rmsDiff > maxRms) maxRms = x.rmsDiff;
    }

    const v = new Float32Array(this._pairs.length);
    for (let i = 0; i < this._pairs.length; i++) {
      const fluxN = this._pairs[i].flux / maxFlux;
      const rmsN  = this._pairs[i].rmsDiff / maxRms;
      v[i] = 0.7 * fluxN + 0.3 * rmsN;
    }

    const sm = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) {
      let acc = 0, cnt = 0;
      for (let k = -2; k <= 2; k++) {
        const j = i + k;
        if (j >= 0 && j < v.length) { acc += v[j]; cnt++; }
      }
      sm[i] = acc / cnt;
    }

    const hop = this.hopSeconds;
    const minLag = Math.floor((60 / maxBPM) / hop);
    const maxLag = Math.floor((60 / minBPM) / hop);

    const acf = new Float32Array(maxLag + 1);
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = 0; i + lag < sm.length; i++) s += sm[i] * sm[i + lag];
      acf[lag] = s;
    }

    const peaks = [];
    for (let lag = minLag + 1; lag < maxLag - 1; lag++) {
      if (acf[lag] > acf[lag-1] && acf[lag] > acf[lag+1]) peaks.push({ lag, val: acf[lag] });
    }
    peaks.sort((a, b) => b.val - a.val);
    const top = peaks.slice(0, 8);
    if (!top.length) return { bpm: null, confidence: 0, beatOffsetSec: 0, sm };

    const fold = (bpm) => {
      while (bpm > maxBPM) bpm *= 0.5;
      while (bpm < minBPM) bpm *= 2.0;
      return bpm;
    };

    const cands = top.map(p => {
      const periodSec = p.lag * hop;
      const bpm = fold(60 / periodSec);
      return { bpm, strength: p.val };
    });

    cands.sort((a, b) => a.bpm - b.bpm);
    const merged = [];
    const tol = 2.5;
    for (const c of cands) {
      const last = merged[merged.length - 1];
      if (last && Math.abs(last.bpm - c.bpm) < tol) {
        const w1 = last.strength, w2 = c.strength;
        last.bpm = (last.bpm * w1 + c.bpm * w2) / (w1 + w2);
        last.strength += c.strength;
      } else merged.push({ ...c });
    }
    merged.sort((a, b) => b.strength - a.strength);

    const best = merged[0];
    const conf = best.strength / (merged.reduce((s, x) => s + x.strength, 1e-9));
    const bpmInt = Math.round(best.bpm);

    const beatOffsetSec = estimateBeatOffset(sm, hop, bpmInt);
    return { bpm: bpmInt, confidence: conf, beatOffsetSec, sm };
  }

  reset() {
    this._prevRms = 0;
    this._prevMag = null;
    this._pairs.length = 0;
  }
}

function estimateBeatOffset(sm, hopSec, bpm) {
  if (!bpm || bpm <= 0) return 0;
  const intervalSec = 60 / bpm;
  const intervalFrames = intervalSec / hopSec;
  if (intervalFrames < 2) return 0;

  const scanN = Math.max(32, Math.min(128, Math.floor(intervalFrames * 2)));
  let bestO = 0, bestScore = -1;
  const startFrame = Math.floor(0.5 / hopSec);

  for (let s = 0; s < scanN; s++) {
    const o = (s / scanN) * intervalFrames;
    let score = 0;
    for (let t = startFrame + o; t < sm.length; t += intervalFrames) {
      const idx = Math.round(t);
      if (idx >= 0 && idx < sm.length) score += sm[idx];
    }
    if (score > bestScore) { bestScore = score; bestO = o; }
  }
  return (bestO * hopSec) % intervalSec;
}
