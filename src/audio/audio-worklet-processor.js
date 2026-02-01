// AudioWorkletProcessor: 抓取麦克风输入 PCM（Float32）并批量发送到主线程

class PCMGrabberProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = [];
    this._bufLen = 0;
    this._chunkSize = 2048;
    this._totalSamples = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0];
    if (!ch0) return true;

    const copy = new Float32Array(ch0.length);
    copy.set(ch0);

    this._buf.push(copy);
    this._bufLen += copy.length;
    this._totalSamples += copy.length;

    if (this._bufLen >= this._chunkSize) {
      const out = new Float32Array(this._bufLen);
      let off = 0;
      for (const a of this._buf) {
        out.set(a, off);
        off += a.length;
      }
      this.port.postMessage({ type: "pcm", pcm: out, totalSamples: this._totalSamples }, [out.buffer]);
      this._buf = [];
      this._bufLen = 0;
    }
    return true;
  }
}

registerProcessor("pcm-grabber", PCMGrabberProcessor);
