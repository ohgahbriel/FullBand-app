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
      this.tracks.push({
        name, buffer: audio, gain, source: null,
        volume: 1, muted: false, solo: false,
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

  _buildSources(offset) {
    for (const t of this.tracks) {
      const src = this.ctx.createBufferSource();
      src.buffer = t.buffer;
      src.connect(t.gain);
      src.start(0, offset);
      t.source = src;
    }
    // Fire onended once, when the longest track finishes naturally.
    const longest = this.tracks.reduce((a, b) =>
      b.buffer.duration > a.buffer.duration ? b : a, this.tracks[0]);
    if (longest?.source) {
      longest.source.onended = () => {
        if (this.playing) this._handleEnded();
      };
    }
  }

  _handleEnded() {
    this.playing = false;
    this._offset = 0;
    this.onended?.();
  }

  async play() {
    if (this.playing || !this.tracks.length) return;
    await this.ctx.resume();
    this._buildSources(this._offset);
    this._startedAt = this.ctx.currentTime;
    this.playing = true;
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
  setMasterVolume(v) { this.master.gain.value = v; }

  _track(name) { return this.tracks.find((t) => t.name === name); }

  // Solo wins: if any track is soloed, only soloed (non-muted) tracks sound.
  _applyGains() {
    const anySolo = this.tracks.some((t) => t.solo);
    for (const t of this.tracks) {
      const audible = anySolo ? (t.solo && !t.muted) : !t.muted;
      t.gain.gain.value = audible ? t.volume : 0;
    }
  }
}
