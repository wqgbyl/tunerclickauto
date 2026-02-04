// src/beat_grid.js

function robustMode(values, binWidth) {
  if (!values?.length) return null;
  const bins = new Map();
  for (const v of values) {
    const b = Math.round(v / binWidth);
    bins.set(b, (bins.get(b) || 0) + 1);
  }
  let bestB = null, bestC = -1;
  for (const [b, c] of bins.entries()) {
    if (c > bestC) { bestC = c; bestB = b; }
  }
  return bestB != null ? bestB * binWidth : null;
}

// 选“脉冲 + 合拍方式”：先找最稳定 pulse，再决定 2合拍/3合拍
export function choosePulseAndGrouping({ peaks, bpmEstimate }) {
  const ts = (peaks || []).map(p => Number(p.t)).filter(Number.isFinite).sort((a,b)=>a-b);
  const ioi = [];
  for (let i = 1; i < ts.length; i++) {
    const d = ts[i] - ts[i - 1];
    if (d > 0.08 && d < 2.0) ioi.push(d);
  }
  const basePeriodFromBpm = (Number.isFinite(bpmEstimate) && bpmEstimate > 0) ? (60 / bpmEstimate) : null;
  const bin = basePeriodFromBpm ? Math.max(0.02, Math.min(0.06, basePeriodFromBpm * 0.06)) : 0.04;
  let pulse = robustMode(ioi, bin);
  if (!pulse && basePeriodFromBpm) pulse = basePeriodFromBpm;
  if (!pulse) pulse = 0.6;

  function scoreGrouping(grouping) {
    const beatP = pulse * grouping;
    const t0 = ts.length ? ts[0] : 0;
    let onSum = 0, total = 0;
    let offRun = 0, offRunMax = 0;
    for (const t of ts) {
      const n = Math.round((t - t0) / beatP);
      const tBeat = t0 + n * beatP;
      const d = Math.abs(t - tBeat);
      const tol = beatP * 0.12;
      onSum += Math.exp(-0.5 * (d / tol) ** 2);
      total += 1;
      // 长时间切分不可能持续：连续“明显离拍”超过6次就惩罚
      if (d > beatP * 0.25) { offRun += 1; offRunMax = Math.max(offRunMax, offRun); }
      else offRun = 0;
    }
    const align = total ? onSum / total : 0;
    const penalty = offRunMax >= 6 ? 0.12 : offRunMax >= 4 ? 0.06 : 0.0;
    return align - penalty;
  }

  const g1 = scoreGrouping(1);
  const g2 = scoreGrouping(2);
  const g3 = scoreGrouping(3);

  let grouping = 1;
  let best = g1;
  if (g2 > best + 0.02) { grouping = 2; best = g2; }
  if (g3 > best + 0.02) { grouping = 3; best = g3; }

  return {
    pulsePeriod: pulse,
    beatPeriod: pulse * grouping,
    grouping,
    scores: { g1, g2, g3 },
  };
}

// 构建 click 时间戳（同声、不区分重音）；同时给出合拍后的 beats[]
export function buildClickGrid({ peaks, startTime, endTime, pulsePeriod, grouping = 1 }) {
  const pts = (peaks || [])
    .map(p => ({ t: Number(p.t), w: Number.isFinite(p.w) ? Number(p.w) : 1 }))
    .filter(p => Number.isFinite(p.t) && p.t >= startTime && p.t <= endTime)
    .sort((a,b)=>a.t-b.t);

  const clicks = [];
  const searchWin = pulsePeriod * 0.18;
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
    const near0 = pts.find(p => Math.abs(p.t - startTime) <= pulsePeriod) || pts[0];
    t0 = near0.t;
  }

  let t = t0;
  let curP = pulsePeriod;
  while (t <= endTime + pulsePeriod * 0.5) {
    const tSnapped = snapToPeak(t);
    clicks.push(tSnapped);
    const predNext = t + curP;
    const last = clicks.length >= 2 ? clicks[clicks.length - 2] : null;
    const observed = last != null ? (clicks[clicks.length - 1] - last) : curP;
    const target = observed > 0 ? observed : curP;
    const minP = pulsePeriod * (1 - maxStepChange);
    const maxP = pulsePeriod * (1 + maxStepChange);
    curP = Math.max(minP, Math.min(maxP, target));
    t = predNext;
    if (clicks.length > 40000) break;
  }

  const beats = [];
  for (let i = 0; i < clicks.length; i += Math.max(1, grouping)) beats.push(clicks[i]);
  return { clicks, beats };
}
