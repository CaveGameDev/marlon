// audio-worklet.js - plays the 32 kHz stereo stream mixed by runtime/ax.c from the shared ring.
// PITCH IS NEVER TOUCHED: the resample step is exactly 32000/sampleRate for every sample, always.
// The guest only writes about 512 samples per rendered frame (~30-31 kHz), 4-6 % less than real time,
// so the ring slowly drains. That shortfall is paid in the time domain: a grain of recent audio is
// repeated with a crossfade at both ends, so no pitch change and no gap, just a short smear now and
// then.
// Everything the audio thread touches is allocated up front: process() creates no objects and does no
// garbage collection, which matters at 5 ms per block.
//   * margin 190 ms, growing to 375 ms after a stall and shrinking back when calm.
//   * if it still runs dry the last sample is held and faded instead of falling silent.
class RghAudio extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const o = opts.processorOptions;
    this.buf = o.memory.buffer; this.ring = new Int16Array(this.buf, o.ring, o.len * 2); this.len = o.len;
    this.w = new Int32Array(this.buf, o.wpos, 1); this.r = new Int32Array(this.buf, o.rpos, 1);
    this.ratio = 32000 / sampleRate;            // source samples per output sample: the true pitch, fixed
    this.minTarget = 6000;                      // 190 ms at 32 kHz
    this.maxTarget = 12000;                     // 375 ms
    this.target = this.minTarget;
    this.calm = 0;
    this.started = false; this.live = false; this.gain = 0;
    this.lastL = 0; this.lastR = 0;
    this.st = { n: 0, sq: 0, dry: 0, drop: 0, buf: 0 };
    this.wLast = 0; this.rateW = 0; this.rateN = 0; this.prod = 0;
    this.err = 0; this.owed = 0; this.grains = 0;
    // grain: 1024 output samples (43 ms at 24 kHz), crossfaded 128 in and 128 out, so one repeat
    // adds 768 samples of time and hides both joins
    this.G = 1024; this.XF = 128; this.NET = this.G - 2 * this.XF;
    this.histL = new Float32Array(this.G); this.histR = new Float32Array(this.G);
    this.histW = 0; this.histN = 0;
    this.grainL = new Float32Array(this.G); this.grainR = new Float32Array(this.G);
    this.insLeft = 0;
    // read() state, reused: pr = source pointer, pf = fraction, pa = samples left, ol/or = sample out
    this.pr = 0; this.pf = 0; this.pa = 0; this.ol = 0; this.or = 0;
  }
  // one source sample at the true rate
  read() {
    const len = this.len, ring = this.ring, f = this.pf;
    const k0 = (this.pr % len) * 2, k1 = ((this.pr + 1) % len) * 2;
    const l0 = ring[k0], l1 = ring[k1], r0 = ring[k0 + 1], r1 = ring[k1 + 1];
    this.ol = (l0 + (l1 - l0) * f) / 32768;
    this.or = (r0 + (r1 - r0) * f) / 32768;
    let pf = f + this.ratio;
    while (pf >= 1) { pf -= 1; this.pr = (this.pr + 1) >>> 0; this.pa--; }
    this.pf = pf;
  }
  push(l, r) {
    this.histL[this.histW] = l; this.histR[this.histW] = r;
    const w = this.histW + 1; this.histW = w === this.G ? 0 : w;
    if (this.histN < this.G) this.histN++;
  }
  // freeze the last G output samples: the grain must not be read out of the ring it is written into
  snapshot() {
    const G = this.G, hw = this.histW;
    for (let i = 0; i < G; i++) {
      const j = hw + i;
      const k = j >= G ? j - G : j;
      this.grainL[i] = this.histL[k]; this.grainR[i] = this.histR[k];
    }
  }
  process(inputs, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0];
    const w = Atomics.load(this.w, 0) >>> 0;
    this.pr = Atomics.load(this.r, 0) >>> 0;
    this.pa = (w - this.pr) >>> 0;
    this.pf = this.pf || 0;
    const dW = (w - this.wLast) >>> 0; this.wLast = w;      // samples the guest wrote since the last block
    this.rateW += dW; this.rateN += L.length;
    if (this.rateN >= sampleRate) {                          // ~1 s window: what the guest really produces
      const measured = this.rateW * sampleRate / this.rateN;
      if (measured > 8000) this.prod = measured;
      this.rateW = 0; this.rateN = 0;
    }
    if (this.pa > this.len) { this.pr = (w - this.target) >>> 0; this.pa = this.target; }
    if (!this.started) {                                     // first start: wait for 40 % of the margin
      if (this.pa < this.target * 0.4) {
        for (let i = 0; i < L.length; i++) { this.lastL *= 0.995; this.lastR *= 0.995; L[i] = this.lastL; R[i] = this.lastR; }
        return true;
      }
      this.started = true; this.live = true; this.gain = 0;
    }
    // a real stall is the only case worth throwing the backlog away
    if (this.pa > this.target * 4) { this.pr = (w - this.target) >>> 0; this.pa = this.target; this.st.drop++; }
    // how much audio the buffer is short by, in output samples (slow: the grain rate follows the
    // guest's real speed, nothing jumps around)
    const err = (this.pa - this.target) / this.target;
    this.err += (err - this.err) * 0.05;
    // only a shortfall is ever paid back: an over-full ring is left to the buffer control above,
    // because accumulating a "debt" while the ring is high delays the guard by seconds and the ring
    // is then empty by the time it reacts (that was the clicking).
    if (this.err < -0.15) this.owed += (-this.err - 0.15) * L.length;
    if (this.owed > this.NET * 4) this.owed = this.NET * 4;
    if (this.owed >= this.NET && this.insLeft === 0 && this.histN >= this.G) {
      this.owed -= this.NET; this.snapshot(); this.insLeft = this.G; this.grains++;
    }
    let gain = this.gain;
    for (let i = 0; i < L.length; i++) {
      if (this.insLeft > 0) {                 // repeat the frozen grain, crossfaded at both ends
        const hp = this.G - this.insLeft;
        let gl = this.grainL[hp], gr = this.grainR[hp];
        const edge = hp < this.XF || hp >= this.G - this.XF;
        if (edge && this.pa > 1) {            // blend the join with the live stream
          this.read();
          const k = hp < this.XF ? hp / this.XF : (this.G - 1 - hp) / this.XF;
          gl = this.ol * (1 - k) + gl * k;
          gr = this.or * (1 - k) + gr * k;
        }
        this.ol = gl; this.or = gr;
        this.insLeft--;
      } else if (this.pa < 2) {               // ran dry: hold the tail, never fall silent mid-stream
        if (this.live) { this.st.dry++; this.live = false; this.target = Math.min(this.maxTarget, this.target + 1200); this.calm = 0; }
        this.lastL *= 0.9995; this.lastR *= 0.9995;
        this.ol = this.lastL; this.or = this.lastR;
        L[i] = this.ol; R[i] = this.or;
        this.push(this.ol, this.or);
        continue;
      } else {
        if (!this.live) { this.live = true; gain = 0; }   // data is back: fade in over ~64 samples
        this.read();
      }
      if (gain < 1) gain = Math.min(1, gain + 1 / 64);
      this.lastL = this.ol; this.lastR = this.or;
      L[i] = this.ol * gain; R[i] = this.or * gain;
      this.push(this.ol, this.or);
    }
    this.gain = gain;
    Atomics.store(this.r, 0, this.pr | 0);
    const s = this.st;
    for (let i = 0; i < L.length; i += 4) s.sq += L[i] * L[i];
    s.n += L.length / 4; s.buf = this.pa;
    if (s.n >= sampleRate / 4) {
      this.port.postMessage({ rms: Math.round(Math.sqrt(s.sq / s.n) * 32768), dry: s.dry, drop: s.drop, buf: Math.round(s.buf / 32), target: Math.round(this.target / 32), step: Math.round(this.ratio * 10000) / 10000, skip: 0, grains: this.grains, ring: Math.round(this.len / 32), prod: Math.round(this.prod || 0) });
      s.n = 0; s.sq = 0; s.dry = 0; s.drop = 0;
      if (++this.calm > 40 && this.target > this.minTarget) { this.target -= 96; this.calm = 38; }   // calm: give the margin back
    }
    return true;
  }
}
registerProcessor('rgh-audio', RghAudio);
