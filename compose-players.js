// Compose Players - Modular Audio Player System
// Based on proven demo.html player pattern

function createBAPlayer(config) {
  const {
    tracks,
    meterNeedleId,
    toggleButtonId,
    beforeLabelClass,
    afterLabelClass,
    bypassLabelId,
    volumeKnobId,
    volumeValueId,
    playPauseBtnId,
    prevBtnId,
    nextBtnId,
    nowPlayingId,
    progressWrapperId,
    trackListId,
    meterDisplayId
  } = config;

  let idx = -1;
  let afterMode = true;
  let isPlaying = false;
  let volumeDb = 0;
  let knobAngle = 360;
  let currentNeedleAngle = -50;
  let progressRAF = null;
  let vuMeterRAF = null;
  let knobStartY = 0;
  let knobStartAngle = 0;
  let isDragging = false;
  let knobMoved = false;

  const beforeAudio = new Audio();
  const afterAudio = new Audio();
  beforeAudio.preload = 'auto';
  afterAudio.preload = 'auto';

  const audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const beforeAnalyser = audioContext.createAnalyser();
  const afterAnalyser = audioContext.createAnalyser();
  const beforeGain = audioContext.createGain();
  const afterGain = audioContext.createGain();

  beforeAnalyser.fftSize = 256;
  afterAnalyser.fftSize = 256;
  beforeAnalyser.smoothingTimeConstant = 0.92;
  afterAnalyser.smoothingTimeConstant = 0.92;

  const beforeDataArray = new Uint8Array(beforeAnalyser.frequencyBinCount);
  const afterDataArray = new Uint8Array(afterAnalyser.frequencyBinCount);

  let beforeSourceConnected = false;
  let afterSourceConnected = false;

  // Get DOM elements
  const meterNeedle = document.getElementById(meterNeedleId);
  const toggleButton = document.getElementById(toggleButtonId);
  const beforeLabel = document.querySelector(`.${beforeLabelClass}`);
  const afterLabel = document.querySelector(`.${afterLabelClass}`);
  const bypassLabel = bypassLabelId ? document.getElementById(bypassLabelId) : null;
  const volumeKnob = document.getElementById(volumeKnobId);
  const volumeValue = document.getElementById(volumeValueId);
  const playPauseBtn = document.getElementById(playPauseBtnId);
  const prevBtn = document.getElementById(prevBtnId);
  const nextBtn = document.getElementById(nextBtnId);
  const nowPlaying = document.getElementById(nowPlayingId);
  const progressWrap = document.getElementById(progressWrapperId);
  const trackList = document.getElementById(trackListId);

  let progressFill = null;
  let scrubber = null;

  function ensureAudioGraph() {
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }

    if (!beforeSourceConnected) {
      const source = audioContext.createMediaElementSource(beforeAudio);
      source.connect(beforeAnalyser);
      beforeAnalyser.connect(beforeGain);
      beforeGain.connect(audioContext.destination);
      beforeSourceConnected = true;
    }

    if (!afterSourceConnected) {
      const source = audioContext.createMediaElementSource(afterAudio);
      source.connect(afterAnalyser);
      afterAnalyser.connect(afterGain);
      afterGain.connect(audioContext.destination);
      afterSourceConnected = true;
    }
  }

  function formatTime(sec) {
    const safeSec = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(safeSec / 60);
    const s = safeSec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function updateProgress() {
    const activeAudio = afterMode ? afterAudio : beforeAudio;
    const cur = activeAudio.currentTime || 0;
    const dur = activeAudio.duration || 0;
    const pct = dur ? (cur / dur) : 0;
    progressFill.style.width = (pct * 100) + '%';
    scrubber.style.left = (pct * 100) + '%';
  }

  function startProgressLoop() {
    if (progressRAF) return;
    const step = () => {
      const activeAudio = afterMode ? afterAudio : beforeAudio;
      const inactiveAudio = afterMode ? beforeAudio : afterAudio;
      
      if (activeAudio.paused) {
        progressRAF = null;
        return;
      }
      
      // Sync inactive audio to active audio position
      if (!inactiveAudio.paused) inactiveAudio.pause();
      inactiveAudio.currentTime = activeAudio.currentTime;
      
      updateProgress();
      progressRAF = requestAnimationFrame(step);
    };
    progressRAF = requestAnimationFrame(step);
  }

  function stopProgressLoop() {
    if (progressRAF) {
      cancelAnimationFrame(progressRAF);
      progressRAF = null;
    }
  }

  function updateVUMeter() {
    const analyser = afterMode ? afterAnalyser : beforeAnalyser;
    const dataArray = afterMode ? afterDataArray : beforeDataArray;
    analyser.getByteFrequencyData(dataArray);

    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i] * dataArray[i];
    }
    const rms = Math.sqrt(sum / dataArray.length);
    const normalized = Math.max(rms / 255, 0.001);
    let db = 20 * Math.log10(normalized);
    db += afterMode ? 8 : -2;
    db += volumeDb;

    const vuMin = -20;
    const vuMax = 3;
    const angleMin = -50;
    const angleMax = 50;
    const clampedVU = Math.max(vuMin, Math.min(vuMax, db));

    let normalizedVU = (clampedVU - vuMin) / (vuMax - vuMin);
    if (clampedVU < -5) normalizedVU = Math.pow(normalizedVU, 1.5);

    const targetAngle = angleMin + normalizedVU * (angleMax - angleMin);
    currentNeedleAngle += (targetAngle - currentNeedleAngle) * 0.1;
    meterNeedle.style.transform = `translateX(-50%) rotate(${currentNeedleAngle}deg)`;

    vuMeterRAF = requestAnimationFrame(updateVUMeter);
  }

  function setMode(isAfter) {
    afterMode = isAfter;
    beforeGain.gain.value = isAfter ? 0 : Math.pow(10, volumeDb / 20);
    afterGain.gain.value = isAfter ? Math.pow(10, volumeDb / 20) : 0;

    if (isAfter) {
      beforeLabel.style.opacity = '0.6';
      beforeLabel.style.fontWeight = '500';
      afterLabel.style.opacity = '1';
      afterLabel.style.fontWeight = '600';
      toggleButton.classList.add('active');
      if (bypassLabel) {
        bypassLabel.classList.add('active');
        bypassLabel.textContent = 'Active';
      }
    } else {
      beforeLabel.style.opacity = '1';
      beforeLabel.style.fontWeight = '600';
      afterLabel.style.opacity = '0.6';
      afterLabel.style.fontWeight = '500';
      toggleButton.classList.remove('active');
      if (bypassLabel) {
        bypassLabel.classList.remove('active');
        bypassLabel.textContent = 'Bypass';
      }
    }

    // Swap active audio stream
    const wasPlaying = !beforeAudio.paused || !afterAudio.paused;
    if (wasPlaying) {
      const activeAudio = afterMode ? afterAudio : beforeAudio;
const inactiveAudio = afterMode ? beforeAudio : afterAudio;
      const t = inactiveAudio.currentTime || activeAudio.currentTime;
      inactiveAudio.pause();
      activeAudio.currentTime = t;
      activeAudio.play().catch(() => {});
    }
  }

  function loadTrack(index, autoPlay = true) {
    const track = tracks[index];
    if (!track) return;

    idx = index;
    nowPlaying.textContent = track.title;
    
    beforeAudio.pause();
    afterAudio.pause();
    beforeAudio.src = track.before;
    afterAudio.src = track.after;
    beforeAudio.currentTime = 0;
    afterAudio.currentTime = 0;

    document.querySelectorAll(`#${trackListId} .track-item`).forEach((item, i) => {
      item.classList.toggle('active', i === index);
    });

    if (autoPlay) {
      ensureAudioGraph();
      const activeAudio = afterMode ? afterAudio : beforeAudio;
      activeAudio.play().then(() => {
        isPlaying = true;
        playPauseBtn.classList.add('playing');
        startProgressLoop();
        if (!vuMeterRAF) vuMeterRAF = requestAnimationFrame(updateVUMeter);
      }).catch(() => {});
    }
  }

  function updateVolumeDisplay() {
    const gain = Math.pow(10, volumeDb / 20);
    volumeValue.textContent = `${volumeDb >= 0 ? '+' : ''}${volumeDb.toFixed(1)} dB`;
    volumeKnob.style.transform = `rotate(${knobAngle - 360}deg)`;
    beforeGain.gain.value = afterMode ? 0 : gain;
    afterGain.gain.value = afterMode ? gain : 0;
  }

  // Build track list
  tracks.forEach((track, index) => {
    const row = document.createElement('div');
    row.className = 'track-item';
    row.innerHTML = `
      <div class="track-item-info">
        <span class="track-item-number">${index + 1}</span>
        <span class="track-item-title">${track.title}</span>
      </div>
      <div class="track-item-time">0:00 / 0:00</div>
      <button class="track-item-play-btn" aria-label="Play ${track.title}"></button>
    `;
    
    row.addEventListener('click', () => loadTrack(index));
    trackList.appendChild(row);
  });

  // Create progress UI elements
  if (progressWrap) {
    progressFill = document.createElement('div');
    progressFill.className = 'main-player-progress-fill';
    progressFill.style.width = '0%';
    progressWrap.appendChild(progressFill);

    scrubber = document.createElement('div');
    scrubber.className = 'main-player-scrubber';
    progressWrap.appendChild(scrubber);

    progressWrap.addEventListener('click', (e) => {
      const rect = progressWrap.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const activeAudio = afterMode ? afterAudio : beforeAudio;
      if (activeAudio.duration) {
        activeAudio.currentTime = pct * activeAudio.duration;
        beforeAudio.currentTime = activeAudio.currentTime;
        afterAudio.currentTime = activeAudio.currentTime;
        updateProgress();
      }
    });
  }

  // Event listeners
  toggleButton.addEventListener('click', () => setMode(!afterMode));
  beforeLabel.addEventListener('click', () => setMode(false));
  afterLabel.addEventListener('click', () => setMode(true));

  playPauseBtn.addEventListener('click', () => {
    if (idx === -1) {
      loadTrack(0);
    } else if (isPlaying) {
      const activeAudio = afterMode ? afterAudio : beforeAudio;
      activeAudio.pause();
      isPlaying = false;
      playPauseBtn.classList.remove('playing');
    } else {
      ensureAudioGraph();
      const activeAudio = afterMode ? afterAudio : beforeAudio;
      activeAudio.play().then(() => {
        isPlaying = true;
        playPauseBtn.classList.add('playing');
        startProgressLoop();
        if (!vuMeterRAF) vuMeterRAF = requestAnimationFrame(updateVUMeter);
      }).catch(() => {});
    }
  });

  prevBtn.addEventListener('click', () => {
    const newIdx = idx > 0 ? idx - 1 : tracks.length - 1;
    loadTrack(newIdx);
  });

  nextBtn.addEventListener('click', () => {
    const newIdx = (idx + 1) % tracks.length;
    loadTrack(newIdx);
  });

  volumeKnob.addEventListener('mousedown', (e) => {
    isDragging = true;
    knobMoved = false;
    knobStartY = e.clientY;
    knobStartAngle = knobAngle;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const deltaY = knobStartY - e.clientY;
    if (Math.abs(deltaY) > 2) knobMoved = true;
    const newAngle = Math.max(180, Math.min(420, knobStartAngle + deltaY));
    knobAngle = newAngle;
    const normalizedPos = (knobAngle - 180) / 240;
    volumeDb = -40 + normalizedPos * 52;
    updateVolumeDisplay();
  });

  document.addEventListener('mouseup', () => {
    if (isDragging && !knobMoved) {
      volumeDb = 0;
      knobAngle = 360;
      updateVolumeDisplay();
    }
    isDragging = false;
  });

  beforeAudio.addEventListener('ended', () => {
    const nextIdx = (idx + 1) % tracks.length;
    loadTrack(nextIdx);
  });

  afterAudio.addEventListener('ended', () => {
    const nextIdx = (idx + 1) % tracks.length;
    loadTrack(nextIdx);
  });

  // Initialize
  beforeGain.gain.value = 0;
  afterGain.gain.value = 1;
  updateVolumeDisplay();
  setMode(true);
  loadTrack(0, false);

  return { audioContext, beforeAudio, afterAudio };
}

// Export for use in compose.html
window.createBAPlayer = createBAPlayer;
