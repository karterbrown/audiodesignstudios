// ============================================================================
// SHARED MATRIX ANIMATION CODE
// Consolidated matrix rain logic for all pages
// ============================================================================

const MATRIX_CONFIG = {
  chars: '01♩♪♫♬♭♮♯♩♪♫♬♭♮♯♩♪♫♬ツシミサケアイウエオカキクコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン∴∵†‡§¶∞Ω∑∏∫≈≠∂∇√∛∜',
  phaseDuration: 15000,
  pureDuration: 5000,
  transitionDuration: 10000,
  frameInterval: 30,
  brightnessDecay: 0.95,
  binaryChars: [0, 1],
  musicalNotes: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
  japaneseChars: [22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65],
  mathChars: [66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84]
};

class MatrixAnimation {
  constructor(canvasId, config = {}) {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) return;
    
    this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.config = { ...MATRIX_CONFIG, ...config };
    this.phaseStartTime = Date.now();
    this.lastFrameTime = 0;
    this.animationId = null;
    
    // Arrays
    this.drops = [];
    this.speeds = [];
    this.charGrid = [];
    this.charAge = [];
    this.cycleSpeeds = [];
    this.brightness = [];
    
    this.init();
  }

  getCurrentPhase() {
    const elapsed = Date.now() - this.phaseStartTime;
    const totalCycle = this.config.phaseDuration * 5;
    const cyclePosition = elapsed % totalCycle;
    const phase = Math.floor(cyclePosition / this.config.phaseDuration);
    const phaseElapsed = cyclePosition % this.config.phaseDuration;
    return { phase, phaseElapsed };
  }

  randomChar(isLeading = false) {
    const { phase, phaseElapsed } = this.getCurrentPhase();
    let charSet = this.config.binaryChars;
    
    const phaseCharSets = [
      this.config.binaryChars,
      this.config.mathChars,
      this.config.japaneseChars,
      this.config.musicalNotes,
      null // Mixed phase
    ];

    if (phaseElapsed < this.config.pureDuration) {
      charSet = phaseCharSets[phase] || this.config.binaryChars;
      if (phase === 4) {
        const rand = Math.random();
        if (rand < 0.25) charSet = this.config.binaryChars;
        else if (rand < 0.5) charSet = this.config.musicalNotes;
        else if (rand < 0.75) charSet = this.config.japaneseChars;
        else charSet = this.config.mathChars;
      }
    } else {
      const progress = (phaseElapsed - this.config.pureDuration) / this.config.transitionDuration;
      const currentSet = phaseCharSets[phase] || this.config.binaryChars;
      const nextPhase = (phase + 1) % 5;
      const nextSet = phaseCharSets[nextPhase] || this.config.binaryChars;

      if (phase === 4) {
        if (Math.random() < progress) {
          charSet = this.config.binaryChars;
        } else {
          const rand = Math.random();
          if (rand < 0.25) charSet = this.config.binaryChars;
          else if (rand < 0.5) charSet = this.config.musicalNotes;
          else if (rand < 0.75) charSet = this.config.japaneseChars;
          else charSet = this.config.mathChars;
        }
      } else if (nextPhase === 4) {
        if (Math.random() < progress) {
          const rand = Math.random();
          if (rand < 0.25) charSet = this.config.binaryChars;
          else if (rand < 0.5) charSet = this.config.musicalNotes;
          else if (rand < 0.75) charSet = this.config.japaneseChars;
          else charSet = this.config.mathChars;
        } else {
          charSet = currentSet;
        }
      } else {
        charSet = Math.random() < progress ? nextSet : currentSet;
      }
    }
    
    const index = charSet[Math.floor(Math.random() * charSet.length)];
    return index !== undefined ? index : 0;
  }

  resize() {
    // Override in subclass
  }

  draw(timestamp) {
    if (timestamp - this.lastFrameTime < this.config.frameInterval) {
      this.animationId = requestAnimationFrame((t) => this.draw(t));
      return;
    }
    this.lastFrameTime = timestamp;

    // Override in subclass for specific drawing logic
  }

  start() {
    this.resize();
    this.animationId = requestAnimationFrame((t) => this.draw(t));
  }

  stop() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  init() {
    window.addEventListener('resize', () => this.resize());
    this.start();
  }
}
