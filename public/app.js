// --- State ---
let currentVideo = null;
let playbackStartTime = null;
let timerInterval = null;
let networkBaseUrl = '';
let recoveryAttempts = 0;
let recoveryTimer = null;
let playlistPollInterval = null;
const MAX_RECOVERY_ATTEMPTS = 10;

// --- DOM ---
const videoList = document.getElementById('video-list');
const refreshBtn = document.getElementById('refresh-btn');

const emptyState = document.getElementById('empty-state');
const downloadState = document.getElementById('download-state');
const playerState = document.getElementById('player-state');

const downloadTitle = document.getElementById('download-title');
const progressFill = document.getElementById('progress-fill');
const downloadInfo = document.getElementById('download-info');

const videoPlayer = document.getElementById('video-player');
const nowPlayingName = document.getElementById('now-playing-name');
const totalTimeEl = document.getElementById('total-time');
const playStatus = document.getElementById('play-status');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const stopBtn = document.getElementById('stop-btn');

// --- Init ---
async function init() {
  loadServerInfo();
  loadVideos();

  refreshBtn.addEventListener('click', () => loadVideos(true));
  fullscreenBtn.addEventListener('click', toggleFullscreen);
  stopBtn.addEventListener('click', stopPlayback);

  videoPlayer.addEventListener('playing', handleVideoPlaying);
  videoPlayer.addEventListener('pause', handleVideoPause);
  videoPlayer.addEventListener('error', handleVideoError);
  videoPlayer.addEventListener('stalled', handleVideoStalled);
  videoPlayer.addEventListener('waiting', handleVideoWaiting);
}

// --- Server info ---
async function loadServerInfo() {
  try {
    const res = await fetch('/api/info');
    const info = await res.json();
    networkBaseUrl = `http://${info.ip}:${info.port}`;
  } catch {
    // Non-critical
  }
}

// --- Video list ---
function createVideoItem(video) {
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
  return item;
}

async function loadVideos(forceRefresh = false) {
  refreshBtn.classList.add('spinning');
  videoList.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Chargement des vidéos...</p></div>';

  try {
    const url = forceRefresh ? '/api/videos?refresh=1' : '/api/videos';
    const res = await fetch(url);
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
    const groups = {};
    videos.forEach(video => {
      const key = video.folder || '_root';
      if (!groups[key]) groups[key] = [];
      groups[key].push(video);
    });

    const sortedKeys = Object.keys(groups).sort((a, b) => {
      if (a === '_root') return -1;
      if (b === '_root') return 1;
      return b.localeCompare(a);
    });

    sortedKeys.forEach((key, index) => {
      const isRoot = key === '_root';
      const videosInGroup = groups[key];

      if (isRoot) {
        videosInGroup.forEach(video => {
          videoList.appendChild(createVideoItem(video));
        });
        return;
      }

      const folder = document.createElement('div');
      folder.className = 'folder-group';

      const header = document.createElement('button');
      header.className = 'folder-header';
      const isOpen = index === 0 || (index === 1 && groups['_root']);
      header.innerHTML = `
        <svg class="folder-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
        <span class="folder-name">${key}</span>
        <span class="folder-count">${videosInGroup.length}</span>
      `;

      const content = document.createElement('div');
      content.className = 'folder-content';

      if (isOpen) {
        header.classList.add('open');
        content.style.maxHeight = 'none';
      }

      header.addEventListener('click', () => {
        header.classList.toggle('open');
        if (header.classList.contains('open')) {
          content.style.maxHeight = content.scrollHeight + 'px';
          setTimeout(() => content.style.maxHeight = 'none', 250);
        } else {
          content.style.maxHeight = content.scrollHeight + 'px';
          requestAnimationFrame(() => content.style.maxHeight = '0');
        }
      });

      videosInGroup.forEach(video => {
        content.appendChild(createVideoItem(video));
      });

      folder.appendChild(header);
      folder.appendChild(content);
      videoList.appendChild(folder);
    });
  } catch (err) {
    videoList.innerHTML = `<div class="error-state"><h3>Erreur de connexion</h3><p>${err.message}</p></div>`;
  } finally {
    refreshBtn.classList.remove('spinning');
  }
}

// --- Video selection & download ---
async function selectVideo(video) {
  if (currentVideo && currentVideo.id !== video.id) {
    clearVideoCache(currentVideo.id);
    currentVideo.cached = false;
  }

  document.querySelectorAll('.video-item').forEach(el => {
    const name = el.querySelector('.video-item-name').textContent;
    el.classList.toggle('active', name === video.name);
  });

  currentVideo = video;

  if (video.hlsReady) {
    startPlayback(video);
    return;
  }

  showState('download');
  downloadTitle.textContent = `Téléchargement : ${video.name}`;
  progressFill.style.width = '0%';
  downloadInfo.textContent = 'Démarrage...';

  try {
    await downloadVideo(video);
    video.cached = true;
    video.hlsReady = true;
    startPlayback(video);
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
function getStreamUrl(videoId) {
  const baseUrl = networkBaseUrl || window.location.origin;
  return `${baseUrl}/api/hls/${videoId}/live.m3u8`;
}

function startPlayback(video) {
  showState('player');
  nowPlayingName.textContent = video.name;
  recoveryAttempts = 0;

  loadStream(video.id);

  playbackStartTime = Date.now();
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(updateTimer, 1000);

  // Poll the playlist periodically to detect server-side issues early
  startPlaylistPolling(video.id);
}

function loadStream(videoId) {
  const url = getStreamUrl(videoId);
  videoPlayer.src = url;
  videoPlayer.load();

  const playPromise = videoPlayer.play();
  if (playPromise) {
    playPromise.catch(() => {
      playStatus.textContent = 'Cliquez sur la vidéo';
      playStatus.className = 'stat-value status-waiting';
      videoPlayer.addEventListener('click', () => videoPlayer.play(), { once: true });
    });
  }
}

function startPlaylistPolling(videoId) {
  if (playlistPollInterval) clearInterval(playlistPollInterval);
  playlistPollInterval = setInterval(async () => {
    if (!currentVideo || currentVideo.id !== videoId) {
      clearInterval(playlistPollInterval);
      return;
    }
    try {
      const res = await fetch(getStreamUrl(videoId), { cache: 'no-store' });
      if (!res.ok) {
        console.warn('Playlist poll: server returned', res.status);
        attemptRecovery('Playlist indisponible');
      }
    } catch {
      console.warn('Playlist poll: network error');
      attemptRecovery('Connexion perdue');
    }
  }, 10000);
}

function stopPlayback() {
  const videoToClean = currentVideo;

  if (recoveryTimer) { clearTimeout(recoveryTimer); recoveryTimer = null; }
  if (playlistPollInterval) { clearInterval(playlistPollInterval); playlistPollInterval = null; }

  videoPlayer.pause();
  videoPlayer.removeAttribute('src');
  videoPlayer.load();

  currentVideo = null;
  playbackStartTime = null;
  recoveryAttempts = 0;
  if (timerInterval) clearInterval(timerInterval);

  document.querySelectorAll('.video-item').forEach(el => el.classList.remove('active'));
  showState('empty');

  if (videoToClean) {
    clearVideoCache(videoToClean.id);
    videoToClean.cached = false;
    loadVideos();
  }
}

async function clearVideoCache(fileId) {
  try {
    await fetch(`/api/cache/${fileId}`, { method: 'DELETE' });
  } catch {
    // Non-critical
  }
}

function handleVideoPlaying() {
  playStatus.textContent = 'En lecture';
  playStatus.className = 'stat-value status-playing';
  // Reset recovery counter on successful playback
  recoveryAttempts = 0;
  if (recoveryTimer) { clearTimeout(recoveryTimer); recoveryTimer = null; }
}

function handleVideoPause() {
  // Ignore pause events during recovery
  if (recoveryTimer) return;
  playStatus.textContent = 'En pause';
  playStatus.className = 'stat-value status-paused';
}

function handleVideoStalled() {
  if (!currentVideo) return;
  console.warn('Video stalled — waiting for data...');
  playStatus.textContent = 'Mise en tampon...';
  playStatus.className = 'stat-value status-waiting';

  // If stalled for more than 8 seconds, attempt recovery
  if (!recoveryTimer) {
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      if (currentVideo && videoPlayer.readyState < 3) {
        attemptRecovery('Flux bloqué');
      }
    }, 8000);
  }
}

function handleVideoWaiting() {
  if (!currentVideo) return;
  playStatus.textContent = 'Mise en tampon...';
  playStatus.className = 'stat-value status-waiting';
}

function handleVideoError() {
  if (!currentVideo) return;
  const err = videoPlayer.error;
  console.error('Video error:', err?.code, err?.message);
  attemptRecovery('Erreur de lecture');
}

function attemptRecovery(reason) {
  if (!currentVideo) return;
  if (recoveryTimer) return; // Already recovering

  recoveryAttempts++;
  if (recoveryAttempts > MAX_RECOVERY_ATTEMPTS) {
    playStatus.textContent = 'Échec — relancez la vidéo';
    playStatus.className = 'stat-value';
    playStatus.style.color = 'var(--danger)';
    return;
  }

  const delay = Math.min(2000 * recoveryAttempts, 10000);
  console.log(`Recovery attempt ${recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS} (${reason}) in ${delay}ms`);
  playStatus.textContent = `Reconnexion ${recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS}...`;
  playStatus.className = 'stat-value status-waiting';

  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    if (!currentVideo) return;
    loadStream(currentVideo.id);
  }, delay);
}

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

// Clear all cache when leaving the page
window.addEventListener('beforeunload', () => {
  navigator.sendBeacon('/api/cache/clear');
});

// --- Start ---
init();
