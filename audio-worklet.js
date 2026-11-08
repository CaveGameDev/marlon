// audio-worklet.js - plays the 32 kHz stereo stream mixed by runtime/ax.c from the shared ring.
// Pitch is always the true source rate, so music can never play slow. The guest does not always
// produce a full 32 kHz (a heavy scene can drop to ~30 kHz), and the ring is filled in bursts, so
// the buffer is kept near its target by dropping or repeating single samples at a steady, low rate.
// That is a deliberately cheap trade: a faint roughness instead of a 100 ms jump every few seconds.
class RghAudio extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const o = opts.processorOptions;
    this.buf = o.memory.buffer; this.ring = new Int16Array(this.buf, o.ring, o.len * 2); this.len = o.len;
    this.w = new Int32Array(this.buf, o.wpos, 1); this.r = new Int32Array(this.buf, o.rpos, 1);
    this.ratio = 32000 / sampleRate;            // source samples per output sample (pitch: never changed)
    this.target = 3840;                         // 120 ms at 32 kHz (grows up to 400 ms if it starves)
    this.calm = 0;
    this.started = false; this.frac = 0; this.lastL = 0; this.lastR = 0;
    this.st = { n: 0, sq: 0, dry: 0, drop: 0, buf: 0 };   // once a quarter second to the page
    this.wLast = 0; this.rateW = 0; this.rateN = 0; this.prod = 0;
    this.err = 0; this.skip = 0; this.rate = 0;
  }
  process(inputs, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0];
    let r = Atomics.load(this.r, 0) >>> 0; const w = Atomics.load(this.w, 0) >>> 0;
    let avail = (w - r) >>> 0;
    const dW = (w - this.wLast) >>> 0; this.wLast = w;      // samples the guest wrote since the last block
    this.rateW += dW; this.rateN += L.length;
    if (this.rateN >= sampleRate) {                          // ~1 s window: what the guest really produces
      const measured = this.rateW * sampleRate / this.rateN;
      if (measured > 8000) this.prod = measured;             // ignore pauses and starved stretches
      this.rateW = 0; this.rateN = 0;
    }
    if (avail > this.len) { r = (w - this.target) >>> 0; avail = this.target; }
    if (!this.started) {
      if (avail < this.target * 0.75) { for (let i = 0; i < L.length; i++) { this.lastL *= 0.995; this.lastR *= 0.995; L[i] = this.lastL; R[i] = this.lastR; } return true; }
      this.started = true;
    }
    // only a real stall (tab in the background, a long hitch) is worth throwing the backlog away
    if (avail > this.target * 6) { r = (w - this.target) >>> 0; avail = this.target; this.st.drop++; }
    // drift correction: inside ±18 % of the target nothing happens; outside it, a fraction of the
    // samples (at most 6 %) is swallowed or repeated, ramped so the amount never jumps
    const err = (avail - this.target) / this.target;
    this.err += (err - this.err) * 0.05;                     // ~0.2 s: fast enough to follow the bursts
    const over = Math.abs(this.err) - 0.18;
    const want = over > 0 ? (this.err > 0 ? 1 : -1) * Math.min(0.06, over * 0.5) : 0;
    this.rate += (want - this.rate) * 0.02;
    const step = this.ratio;                                 // pitch: exactly the source rate, always
    let frac = this.frac, skip = this.skip;
    for (let i = 0; i < L.length; i++) {
      if (avail < 2) {                          // ran dry: fade out instead of clicking, then re-buffer
        if (this.started) { this.st.dry++; this.target = Math.min(12800, this.target + 1280); this.calm = 0; } this.lastL *= 0.99; this.lastR *= 0.99; L[i] = this.lastL; R[i] = this.lastR; this.started = false; continue;
      }
      const k0 = (r % this.len) * 2, k1 = ((r + 1) % this.len) * 2;
      const l = (this.ring[k0] + (this.ring[k1] - this.ring[k0]) * frac) / 32768;
      const rr = (this.ring[k0 + 1] + (this.ring[k1 + 1] - this.ring[k0 + 1]) * frac) / 32768;
      L[i] = l; R[i] = rr; this.lastL = l; this.lastR = rr;
      frac += step;
      while (frac >= 1) { frac -= 1; r = (r + 1) >>> 0; avail--; }
      skip += this.rate;                        // > 0: buffer too full, < 0: too empty
      if (skip >= 1) { if (avail > 2) { skip -= 1; r = (r + 1) >>> 0; avail--; } else skip = 0; }
      else if (skip <= -1) { if (avail > 1) { skip += 1; r = (r - 1) >>> 0; avail++; } else skip = 0; }
    }
    this.frac = frac; this.skip = skip;
    Atomics.store(this.r, 0, r | 0);
    const st = this.st;
    for (let i = 0; i < L.length; i += 4) st.sq += L[i] * L[i];
    st.n += L.length / 4; st.buf = avail;
    if (st.n >= sampleRate / 4) {
      this.port.postMessage({ rms: Math.round(Math.sqrt(st.sq / st.n) * 32768), dry: st.dry, drop: st.drop, buf: Math.round(st.buf / 32), target: Math.round(this.target / 32), step: Math.round((step ?? 1) * 10000) / 10000, skip: Math.round(this.rate * 10000) / 10000, ring: Math.round(this.len / 32), prod: Math.round(this.prod || 0) });
      st.n = 0; st.sq = 0; st.dry = 0; st.drop = 0;
      if (++this.calm > 40 && this.target > 3840) { this.target -= 16; this.calm = 30; }   // quiet for 10 s: shrink slowly
    }
    return true;
  }
}
registerProcessor('rgh-audio', RghAudio);
