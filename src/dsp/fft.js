export function fftRadix2(real, imag) {
  const n = real.length;
  if ((n & (n - 1)) !== 0) throw new Error("FFT length must be power of 2");

  let j = 0;
  for (let i = 0; i < n; i++) {
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wlenR = Math.cos(ang);
    const wlenI = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1, wi = 0;
      for (let k = 0; k < len / 2; k++) {
        const uR = real[i + k];
        const uI = imag[i + k];
        const vR = real[i + k + len/2] * wr - imag[i + k + len/2] * wi;
        const vI = real[i + k + len/2] * wi + imag[i + k + len/2] * wr;

        real[i + k] = uR + vR;
        imag[i + k] = uI + vI;
        real[i + k + len/2] = uR - vR;
        imag[i + k + len/2] = uI - vI;

        const nextWr = wr * wlenR - wi * wlenI;
        wi = wr * wlenI + wi * wlenR;
        wr = nextWr;
      }
    }
  }
}

export function magnitudeSpectrumFromTimeDomain(frame, windowFunc = hannWindow) {
  const n = frame.length;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let i = 0; i < n; i++) real[i] = frame[i] * windowFunc(i, n);
  fftRadix2(real, imag);
  const mag = new Float32Array(n/2);
  for (let i = 0; i < n/2; i++) mag[i] = Math.hypot(real[i], imag[i]);
  return mag;
}

function hannWindow(i, n) {
  return 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
}
