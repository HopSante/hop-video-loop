// --- State ---
let currentVideo = null;
let loopCount = 0;
let playbackStartTime = null;
let timerInterval = null;

// --- DOM ---
const videoList = document.getElementById('video-list');
const refreshBtn = document.getElementById('refresh-btn');
const serverInfo = document.getElementById('server-info');
const networkUrl = document.getElementById('network-url');

const emptyState = document.getElementById('empty-state');
const downloadState = document.getElementById('download-state');
const playerState = document.getElementById('player-state');

const downloadTitle = document.getElementById('download-title');
const progressFill = document.getElementById('progress-fill');
const downloadInfo = document.getElementById('download-info');

const videoPlayer = document.getElementById('video-player');
const nowPlayingName = document.getElementById('now-playing-name');
const loopCountEl = document.getElementById('loop-count');
const totalTimeEl = document.getElementById('total-time');
const playStatus = document.getElementById('play-status');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const stopBtn = document.getElementById('stop-btn');

// --- Init ---
async function init() {
  await loadServerInfo();
  await loadVideos();

  refreshBtn.addEventListener('click', loadVideos);
  fullscreenBtn.addEventListener('click', toggleFullscreen);
  stopBtn.addEventListener('click', stopPlayback);

  // Video events for seamless looping
  videoPlayer.addEventListener('ended', handleVideoEnded);
  videoPlayer.addEventListener('playing', handleVideoPlaying);
  videoPlayer.addEventListener('pause', handleVideoPause);
  videoPlayer.addEventListener('error', handleVideoError);
}

// --- Server info ---
async function loadServerInfo() {
  try {
    const res = await fetch('/api/info');
    const info = await res.json();
    const url = `http://${info.ip}:${info.port}`;
    networkUrl.textContent = url;
    serverInfo.classList.remove('hidden');
  } catch {
    // Non-critical
  }
}

// --- Video list ---
async function loadVideos() {
  refreshBtn.classList.add('spinning');
  videoList.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Chargement des vidéos...</p></div>';

  try {
    const res = await fetch('/api/videos');
    const videos = await res.json();

    if (videos.error) {
      videoList.innerHTML = `<div class="error-state"><h3>Erreur</h3><p>${videos.error}</p></div>`;
      return;
    }

    if (videos.length === 0) {
      videoList.innerHTML = '<div class="loading-state"><p>Aucune vidéo trouvée dans le dossier Google Drive</p></div>';
      return;
    }

    videoList.innerHTML = '';
    videos.forEach(video => {
      const item = document.createElement('div');
      item.className = 'video-item' + (currentVideo?.id === video.id ? ' active' : '');
      item.innerHTML = `
        <div class="video-item-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
        </div>
        <div class="video-item-info">
          <div class="video-item-name" title="${video.name}">${video.name}</div>
          <div class="video-item-meta">
            <span>${formatFileSize(video.size)}</span>
            ${video.duration ? `<span>${formatDuration(video.duration)}</span>` : ''}
            ${video.cached ? '<span class="video-item-cached">En cache</span>' : ''}
          </div>
        </div>
      `;
      item.addEventListener('click', () => selectVideo(video));
      videoList.appendChild(item);
    });
  } catch (err) {
    videoList.innerHTML = `<div class="error-state"><h3>Erreur de connexion</h3><p>${err.message}</p></div>`;
  } finally {
    refreshBtn.classList.remove('spinning');
  }
}

// --- Video selection & download ---
async function selectVideo(video) {
  // Update active state in list
  document.querySelectorAll('.video-item').forEach(el => el.classList.remove('active'));
  const items = document.querySelectorAll('.video-item');
  items.forEach(el => {
    if (el.querySelector('.video-item-name').textContent === video.name) {
      el.classList.add('active');
    }
  });

  currentVideo = video;

  if (video.cached) {
    // Play directly from cache
    startPlayback(video);
    return;
  }

  // Download first
  showState('download');
  downloadTitle.textContent = `Téléchargement : ${video.name}`;
  progressFill.style.width = '0%';
  downloadInfo.textContent = 'Démarrage...';

  try {
    await downloadVideo(video);
    video.cached = true;
    startPlayback(video);
    // Refresh list to show cached status
    loadVideos();
  } catch (err) {
    downloadTitle.textContent = 'Erreur de téléchargement';
    downloadInfo.textContent = err.message;
  }
}

function downloadVideo(video) {
  return new Promise((resolve, reject) => {
    const evtSource = new EventSource(`/api/download/${video.id}`);

    evtSource.onmessage = (event) => {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case 'progress':
          progressFill.style.width = `${data.percent}%`;
          downloadInfo.textContent = `${data.percent}% — ${formatFileSize(data.downloaded)} / ${formatFileSize(data.total)}`;
          break;

        case 'status':
          downloadInfo.textContent = data.message;
          break;

        case 'complete':
          evtSource.close();
          resolve();
          break;

        case 'error':
          evtSource.close();
          reject(new Error(data.message));
          break;
      }
    };

    evtSource.onerror = () => {
      evtSource.close();
      reject(new Error('Connexion perdue pendant le téléchargement'));
    };
  });
}

// --- Playback ---
function startPlayback(video) {
  showState('player');
  nowPlayingName.textContent = video.name;
  loopCount = 0;
  loopCountEl.textContent = '0';

  // Set video source
  videoPlayer.src = `/api/play/${video.id}`;
  videoPlayer.load();

  const playPromise = videoPlayer.play();
  if (playPromise) {
    playPromise.catch(() => {
      // Autoplay blocked — user must interact
      playStatus.textContent = 'Cliquez sur la vidéo';
      playStatus.className = 'stat-value status-waiting';
      videoPlayer.addEventListener('click', () => videoPlayer.play(), { once: true });
    });
  }

  // Start timer
  playbackStartTime = Date.now();
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(updateTimer, 1000);
}

function stopPlayback() {
  videoPlayer.pause();
  videoPlayer.removeAttribute('src');
  videoPlayer.load();

  currentVideo = null;
  loopCount = 0;
  playbackStartTime = null;
  if (timerInterval) clearInterval(timerInterval);

  document.querySelectorAll('.video-item').forEach(el => el.classList.remove('active'));
  showState('empty');
}

function handleVideoEnded() {
  // Fallback: if loop attribute didn't work, manually restart
  loopCount++;
  loopCountEl.textContent = loopCount.toString();

  if (videoPlayer.paused) {
    videoPlayer.currentTime = 0;
    videoPlayer.play();
  }
}

function handleVideoPlaying() {
  playStatus.textContent = 'En lecture';
  playStatus.className = 'stat-value status-playing';
}

function handleVideoPause() {
  // Don't update status if video is seeking for loop
  if (videoPlayer.currentTime < videoPlayer.duration - 0.5) {
    playStatus.textContent = 'En pause';
    playStatus.className = 'stat-value status-paused';
  }
}

function handleVideoError() {
  playStatus.textContent = 'Erreur';
  playStatus.className = 'stat-value';
  playStatus.style.color = 'var(--danger)';

  // Try to recover after 3 seconds
  setTimeout(() => {
    if (currentVideo) {
      videoPlayer.load();
      videoPlayer.play();
    }
  }, 3000);
}

// Also count loops from the 'seeked' event when loop attribute works
videoPlayer.addEventListener('seeked', () => {
  // The loop attribute causes a seek to 0 at the end
  if (videoPlayer.currentTime === 0 && loopCount >= 0) {
    loopCount++;
    loopCountEl.textContent = loopCount.toString();
  }
});

function toggleFullscreen() {
  const container = document.querySelector('.video-container');
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else if (container.requestFullscreen) {
    container.requestFullscreen();
  } else if (container.webkitRequestFullscreen) {
    container.webkitRequestFullscreen();
  }
}

// --- UI Helpers ---
function showState(state) {
  emptyState.classList.toggle('hidden', state !== 'empty');
  downloadState.classList.toggle('hidden', state !== 'download');
  playerState.classList.toggle('hidden', state !== 'player');
}

function updateTimer() {
  if (!playbackStartTime) return;
  const elapsed = Math.floor((Date.now() - playbackStartTime) / 1000);
  totalTimeEl.textContent = formatTime(elapsed);
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}min`;
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}min`;
}

function formatFileSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return bytes + ' o';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' Ko';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' Mo';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' Go';
}

// --- Start ---
init();
