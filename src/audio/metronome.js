export function createClickBuffer(audioCtx, { freq = 1500, durationMs = 15 } = {}) {
  const sr = audioCtx.sampleRate;
  const len = Math.floor(sr * durationMs / 1000);
  const buffer = audioCtx.createBuffer(1, len, sr);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const env = Math.exp(-t * 120);
    data[i] = Math.sin(2 * Math.PI * freq * t) * env;
  }
  return buffer;
}

export function scheduleMetronome(audioCtx, {
  bpm,
  meter = 4,
  startTime,
  durationSec,
  clickBufferStrong,
  clickBufferWeak,
  clickGainNode,
  lookaheadSec = 0.2,
  scheduleIntervalMs = 25,
} = {}) {
  const interval = 60 / bpm;
  let nextClickTime = startTime;
  let beatIndex = 0; // 0..meter-1

  const timer = setInterval(() => {
    const now = audioCtx.currentTime;
    const horizon = now + lookaheadSec;
    while (nextClickTime < horizon && nextClickTime < startTime + durationSec) {
      const src = audioCtx.createBufferSource();
      const isStrong = (beatIndex % meter) === 0;
      src.buffer = isStrong ? clickBufferStrong : clickBufferWeak;
      src.connect(clickGainNode);
      src.start(nextClickTime);

      nextClickTime += interval;
      beatIndex++;
    }
  }, scheduleIntervalMs);

  return () => clearInterval(timer);
}
