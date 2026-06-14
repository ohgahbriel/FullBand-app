// Multi-track sync engine built on the Web Audio API.
//
// Each stem becomes a decoded AudioBuffer fed through its own GainNode into a
// shared master gain. All sources are started from the same clock reference so
// they stay sample-accurately in sync; seeking tears down and rebuilds the
// source nodes (BufferSourceNodes are single-use) at the new offset.

export class Mixer {
  constructor() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);

    this.tracks = [];      // {name, buffer, gain, source, volume, muted, solo}
    this.playing = false;
    this.duration = 0;     // longest stem, seconds
    this._startedAt = 0;   // ctx.currentTime when playback (re)started
    this._offset = 0;      // playback position, seconds, when last started
    this.onended = null;   // callback when playback reaches the end
  }

  // Fetch + decode every stem. urls: [{name, url}]. onProgress(done,total).
  async load(stems, onProgress) {
    this.unload();
    let done = 0;
    for (const { name, url } of stems) {
      const buf = await fetch(url).then((r) => r.arrayBuffer());
      const audio = await this.ctx.decodeAudioData(buf);
      const gain = this.ctx.createGain();
      gain.connect(this.master);
      const analyser = this.ctx.createAnalyser();   // post-fader tap for the meter
      analyser.fftSize = 256;
      gain.connect(analyser);
      this.tracks.push({
        name, buffer: audio, gain, analyser, source: null,
        volume: 1, muted: false, solo: false,
        _meterBuf: new Uint8Array(analyser.fftSize),
      });
      this.duration = Math.max(this.duration, audio.duration);
      onProgress?.(++done, stems.length);
    }
    this._applyGains();
  }

  unload() {
    this.stop();
    this.tracks = [];
    this.duration = 0;
    this._offset = 0;
  }

  // Replace each track's audio buffer (matched by name) with a new one — e.g.
  // pitch/tempo-shifted renders — keeping volume/mute/solo. Resumes at `offset`
  // (seconds in the NEW timeline) and keeps playing if it was.
  async swapBuffers(stems, offset, onProgress) {
    const wasPlaying = this.playing;
    this.stop();
    let done = 0;
    for (const { name, url } of stems) {
      const buf = await fetch(url).then((r) => r.arrayBuffer());
      const audio = await this.ctx.decodeAudioData(buf);
      const t = this._track(name);
      if (t) t.buffer = audio;
      onProgress?.(++done, stems.length);
    }
    // Fold in every track (swapped stems + any recorded/imported takes) so
    // duration reflects the whole timeline, not just the stems we replaced.
    this._recalcDuration();
    this._offset = Math.max(0, Math.min(offset, this.duration));
    if (wasPlaying) this.play();
  }

  _buildSources(offset) {
    const now = this.ctx.currentTime;
    let lastEnd = -Infinity, lastSrc = null;
    for (const t of this.tracks) {
      t.source = null;
      if (!t.buffer) continue;                 // empty (armed/未recorded) track
      const start = t.start || 0;              // timeline position the buffer begins
      if (start + t.buffer.duration <= offset) continue;   // already behind us
      const src = this.ctx.createBufferSource();
      src.buffer = t.buffer;
      src.connect(t.gain);
      let when = now, into = 0;
      if (start >= offset) when = now + (start - offset);  // delayed start
      else into = offset - start;                          // mid-buffer start
      src.start(when, into);
      t.source = src;
      const projEnd = when + (t.buffer.duration - into);   // wall-clock end
      if (projEnd > lastEnd) { lastEnd = projEnd; lastSrc = src; }
    }
    // Fire onended once, when the last-finishing source ends naturally.
    if (lastSrc) lastSrc.onended = () => { if (this.playing) this._handleEnded(); };
  }

  _handleEnded() {
    this.playing = false;
    this._offset = 0;
    this.onended?.();
  }

  // Resume the AudioContext (browsers start it suspended until a user gesture).
  async resume() { await this.ctx.resume(); }

  // True once at least one track has decoded audio to play.
  get hasAudio() { return this.tracks.some((t) => t.buffer); }

  async play() {
    if (this.playing || !this.hasAudio) return;
    await this.ctx.resume();
    this._buildSources(this._offset);
    this._startedAt = this.ctx.currentTime;
    this.playing = true;
  }

  // --- adding / recording tracks -----------------------------------------
  // An empty track: a fader + gain chain with no buffer yet, ready to receive
  // a recording or an imported file.
  addTrack(name) {
    const gain = this.ctx.createGain();
    gain.connect(this.master);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 256;
    gain.connect(analyser);
    const t = {
      name, buffer: null, gain, analyser, source: null,
      volume: 1, muted: false, solo: false, start: 0,
      _meterBuf: new Uint8Array(analyser.fftSize),
    };
    this.tracks.push(t);
    this._applyGains();
    return t;
  }

  // Attach decoded audio to a track at timeline position `start` (seconds).
  setTrackBuffer(name, audioBuffer, start = 0) {
    const t = this._track(name);
    if (!t) return;
    t.buffer = audioBuffer;
    t.start = Math.max(0, start);
    this.duration = Math.max(this.duration, t.start + audioBuffer.duration);
  }

  removeTrack(name) {
    const i = this.tracks.findIndex((t) => t.name === name);
    if (i < 0) return;
    const t = this.tracks[i];
    try { if (t.source) { t.source.onended = null; t.source.stop(); } } catch {}
    try { t.gain.disconnect(); } catch {}
    this.tracks.splice(i, 1);
    this._recalcDuration();
    this._applyGains();
  }

  _recalcDuration() {
    this.duration = this.tracks.reduce(
      (m, t) => (t.buffer ? Math.max(m, (t.start || 0) + t.buffer.duration) : m), 0);
  }

  pause() {
    if (!this.playing) return;
    this._offset = this.currentTime();
    this.stop();
  }

  // Hard stop: kill all source nodes (they cannot be restarted).
  stop() {
    for (const t of this.tracks) {
      if (t.source) {
        try { t.source.onended = null; t.source.stop(); } catch {}
        t.source = null;
      }
    }
    this.playing = false;
  }

  seek(seconds) {
    const wasPlaying = this.playing;
    this.stop();
    this._offset = Math.max(0, Math.min(seconds, this.duration));
    if (wasPlaying) this.play();
  }

  currentTime() {
    if (!this.playing) return this._offset;
    return Math.min(this._offset + (this.ctx.currentTime - this._startedAt), this.duration);
  }

  // --- per-track controls -------------------------------------------------
  setVolume(name, v) { this._track(name).volume = v; this._applyGains(); }
  toggleMute(name) { const t = this._track(name); t.muted = !t.muted; this._applyGains(); return t.muted; }
  toggleSolo(name) { const t = this._track(name); t.solo = !t.solo; this._applyGains(); return t.solo; }
  setMute(name, on) { const t = this._track(name); if (t) { t.muted = on; this._applyGains(); } }
  setSolo(name, on) { const t = this._track(name); if (t) { t.solo = on; this._applyGains(); } }
  setMasterVolume(v) { this.master.gain.value = v; }

  // Short synthesized click for the count-in. Accented beat is higher + louder.
  beep(accent = false) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = accent ? 1600 : 1000;
    g.gain.setValueAtTime(accent ? 0.5 : 0.32, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.06);
    osc.connect(g).connect(ctx.destination);   // bypass master so volume stays put
    osc.start(t0);
    osc.stop(t0 + 0.07);
  }

  _track(name) { return this.tracks.find((t) => t.name === name); }

  // Post-fader RMS level (0..1) for a track's meter.
  level(track) {
    const a = track.analyser;
    if (!a) return 0;
    a.getByteTimeDomainData(track._meterBuf);
    const b = track._meterBuf;
    let sum = 0;
    for (let i = 0; i < b.length; i++) { const x = (b[i] - 128) / 128; sum += x * x; }
    return Math.sqrt(sum / b.length);
  }

  // The effective per-track gain the user is hearing right now (mute/solo
  // resolved, times volume), plus master. Used to render the mix server-side.
  effectiveGains() {
    const anySolo = this.tracks.some((t) => t.solo);
    const gains = {};
    for (const t of this.tracks) {
      const audible = anySolo ? (t.solo && !t.muted) : !t.muted;
      gains[t.name] = audible ? t.volume : 0;
    }
    return { gains, master: this.master.gain.value };
  }

  // Per-track waveform peaks for the DAW lane view: {name -> Float32Array(bins)},
  // all normalised to ONE shared maximum so relative loudness reads across lanes
  // (loud drums tower over quiet vocals, like a real multitrack).
  getAllPeaks(bins) {
    const out = {};
    let gmax = 0;
    const dur = this.duration || 1;            // bins map to the shared timeline
    for (const t of this.tracks) {
      const p = new Float32Array(bins);
      if (t.buffer) {
        const data = t.buffer.getChannelData(0);
        const sr = t.buffer.sampleRate;
        const start = t.start || 0;            // place the buffer at its offset
        for (let i = 0; i < bins; i++) {
          const ta = (i / bins) * dur - start;
          const tb = ((i + 1) / bins) * dur - start;
          if (tb <= 0 || ta >= t.buffer.duration) continue;   // silence outside the take
          const s = Math.max(0, Math.floor(ta * sr));
          const e = Math.min(data.length, Math.ceil(tb * sr));
          let mx = 0;
          for (let j = s; j < e; j++) { const v = Math.abs(data[j]); if (v > mx) mx = v; }
          p[i] = mx;
          if (mx > gmax) gmax = mx;
        }
      }
      out[t.name] = p;
    }
    if (gmax > 0) for (const n in out) {
      const p = out[n];
      for (let i = 0; i < p.length; i++) p[i] /= gmax;
    }
    return out;
  }

  // Approximate mix waveform: per-bin peak amplitude summed across stems,
  // normalised to 0..1. Computed once after load for the waveform display.
  getPeaks(bins) {
    const peaks = new Float32Array(bins);
    if (!this.tracks.length) return peaks;
    const total = this.duration * (this.tracks[0]?.buffer.sampleRate || 44100);
    const block = Math.max(1, Math.floor(total / bins));
    for (const t of this.tracks) {
      if (!t.buffer) continue;
      const data = t.buffer.getChannelData(0);
      for (let i = 0; i < bins; i++) {
        let max = 0;
        const start = i * block;
        const end = Math.min(start + block, data.length);
        for (let j = start; j < end; j++) {
          const v = Math.abs(data[j]);
          if (v > max) max = v;
        }
        peaks[i] += max;
      }
    }
    let m = 0;
    for (const p of peaks) if (p > m) m = p;
    if (m > 0) for (let i = 0; i < bins; i++) peaks[i] /= m;
    return peaks;
  }

  // Solo wins: if any track is soloed, only soloed (non-muted) tracks sound.
  _applyGains() {
    const anySolo = this.tracks.some((t) => t.solo);
    for (const t of this.tracks) {
      const audible = anySolo ? (t.solo && !t.muted) : !t.muted;
      t.gain.gain.value = audible ? t.volume : 0;
    }
  }
}
