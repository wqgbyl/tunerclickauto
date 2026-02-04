// src/beat_grid.js
export function chooseBeatLevel({ peaks, basePeriod }) {
  if (!peaks?.length || !basePeriod) return { mult: 1, period: basePeriod, label: "quarter", score: 0 };
  const CAND = [
    { mult: 1, label: "quarter" },
    { mult: 2 / 3, label: "dottedQuarter(6/8)" },
    { mult: 3 / 2, label: "triplet-subdivision" },
    { mult: 2, label: "double-time" },
    { mult: 1 / 2, label: "half-time" },
  ];
  const ts = peaks.map(p => p.t);
  const ws = peaks.map(p => (Number.isFinite(p.w) ? p.w : 1));
  function scorePeriod(period) {
    const t0 = ts[0];
    let totalW = 0, s = 0;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i], w = ws[i];
      totalW += w;
      const n = Math.round((t - t0) / period);
      const tBeat = t0 + n * period;
      const d = Math.abs(t - tBeat);
      const tol = period * 0.12;
      s += w * Math.exp(-0.5 * (d / tol) ** 2);
    }
    return totalW > 0 ? s / totalW : 0;
  }
  let best = null;
  for (const c of CAND) {
    const period = basePeriod / c.mult;
    const score = scorePeriod(period);
    if (!best || score > best.score) best = { ...c, period, score };
  }
  return best;
}

export function buildBeatGrid({ peaks, startTime, endTime, period, meter = 4 }) {
  if (!period || !Number.isFinite(period)) return { beats: [], downbeats: [] };
  const pts = peaks
    .map(p => ({ t: p.t, w: Number.isFinite(p.w) ? p.w : 1 }))
    .filter(p => p.t >= startTime && p.t <= endTime)
    .sort((a, b) => a.t - b.t);

  const beats = [];
  const searchWin = period * 0.18;
  const maxStepChange = 0.08;

  function snapToPeak(tPred) {
    let best = null;
    for (const p of pts) {
      if (p.t < tPred - searchWin) continue;
      if (p.t > tPred + searchWin) break;
      if (!best || p.w > best.w) best = p;
    }
    return best ? best.t : tPred;
  }

  let t0 = startTime;
  if (pts.length) {
    const near0 = pts.find(p => Math.abs(p.t - startTime) <= period) ?? pts[0];
    t0 = near0.t;
  }

  let t = t0;
  let curPeriod = period;
  while (t <= endTime + period * 0.5) {
    const tSnapped = snapToPeak(t);
    beats.push(tSnapped);
    const predNext = t + curPeriod;
    const last = beats.length >= 2 ? beats[beats.length - 2] : null;
    const observed = last != null ? (beats[beats.length - 1] - last) : curPeriod;
    const target = observed > 0 ? observed : curPeriod;
    const minP = period * (1 - maxStepChange);
    const maxP = period * (1 + maxStepChange);
    curPeriod = Math.max(minP, Math.min(maxP, target));
    t = predNext;
    if (beats.length > 20000) break;
  }
  const downbeats = [];
  for (let i = 0; i < beats.length; i++) if (i % meter === 0) downbeats.push(beats[i]);
  return { beats, downbeats };
}
