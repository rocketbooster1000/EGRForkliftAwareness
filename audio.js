'use strict';
// One oscillator with a scheduled envelope; no overlapping independent sensor beeps.
class ProximityAudio {
  constructor() { this.context = null; this.oscillator = null; this.gain = null; this.profile = null; this.volume = 0.3; this.nextPulse = 0; this.signature = ''; }
  async start() {
    if (!this.context) {
      this.context = new (window.AudioContext || window.webkitAudioContext)();
      this.oscillator = this.context.createOscillator();
      this.gain = this.context.createGain(); this.gain.gain.value = 0;
      this.oscillator.type = 'sine'; this.oscillator.connect(this.gain); this.gain.connect(this.context.destination); this.oscillator.start();
      this.timer = setInterval(() => this.tick(), 25);
    }
    await this.context.resume();
    if (this.context.state !== 'running') throw new Error('Browser audio is unavailable.');
  }
  setProfile(profile) { this.profile = profile?.active ? profile : null; }
  tick() {
    if (!this.context || this.context.state !== 'running') return;
    const t = this.context.currentTime, p = this.profile;
    const signature = p ? `${Math.round(p.progress * 40)}:${this.volume}` : 'off';
    if (signature !== this.signature) {
      const gain = this.gain.gain;
      if (gain.cancelAndHoldAtTime) gain.cancelAndHoldAtTime(t); else gain.cancelScheduledValues(t);
      gain.setTargetAtTime(0, t, 0.008); this.nextPulse = t + 0.025; this.signature = signature;
    }
    if (!p) return;
    this.oscillator.frequency.setTargetAtTime(p.frequencyHz, t, 0.04);
    if (p.continuous) { this.gain.gain.setTargetAtTime(this.volume * 0.18, t + 0.01, 0.02); return; }
    while (this.nextPulse < t + 0.12) {
      const start = Math.max(this.nextPulse, t + 0.005);
      const duration = p.periodSeconds * p.duty;
      const gain = this.gain.gain;
      gain.setValueAtTime(0, start);
      gain.linearRampToValueAtTime(this.volume * 0.18, start + Math.min(0.01, duration / 4));
      gain.setValueAtTime(this.volume * 0.18, start + Math.max(0.01, duration - 0.01));
      gain.linearRampToValueAtTime(0, start + duration);
      this.nextPulse = start + p.periodSeconds;
    }
  }
  stop() { this.setProfile(null); this.tick(); }
  async test() {
    await this.start();
    const oscillator = this.context.createOscillator(), gain = this.context.createGain(), t = this.context.currentTime;
    oscillator.frequency.setValueAtTime(SurroundLogic.AUDIO_MIN_HZ, t); oscillator.frequency.exponentialRampToValueAtTime(SurroundLogic.AUDIO_MAX_HZ, t + 0.7);
    gain.gain.setValueAtTime(0, t); gain.gain.linearRampToValueAtTime(this.volume * 0.18, t + 0.02); gain.gain.setValueAtTime(this.volume * 0.18, t + 0.65); gain.gain.linearRampToValueAtTime(0, t + 0.72);
    oscillator.connect(gain); gain.connect(this.context.destination); oscillator.start(t); oscillator.stop(t + 0.75);
  }
  close() { clearInterval(this.timer); return this.context?.close(); }
}
