// --- State ---
let currentVideo = null;
let playbackStartTime = null;
let timerInterval = null;

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
  loadVideos();

  refreshBtn.addEventListener('click', () => loadVideos(true));
  fullscreenBtn.addEventListener('click', toggleFullscreen);
  stopBtn.addEventListener('click', stopPlayback);

  videoPlayer.addEventListener('playing', handleVideoPlaying);
  videoPlayer.addEventListener('pause', handleVideoPause);
  videoPlayer.addEventListener('error', handleVideoError);
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
  downloadTitle.textContent = `Préparation : ${video.name}`;
  progressFill.style.width = '0%';
  downloadInfo.textContent = 'Démarrage...';

  try {
    await downloadVideo(video);
    video.cached = true;
    video.hlsReady = true;
    startPlayback(video);
    loadVideos();
  } catch (err) {
    downloadTitle.textContent = 'Erreur';
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

// --- Playback (VOD HLS — 6h looped playlist, no JS loop needed) ---

function startPlayback(video) {
  showState('player');
  nowPlayingName.textContent = video.name;

  // Relative URL — page is on network IP (auto-redirected from localhost)
  // so AirPlay sends the correct URL to the Apple TV
  videoPlayer.src = `/api/hls/${video.id}/playlist.m3u8`;
  videoPlayer.load();

  // Auto-play locally (AirPlay requires manual activation by user)
  videoPlayer.play().catch(() => {});

  playbackStartTime = Date.now();
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(updateTimer, 1000);
}

function stopPlayback() {
  const videoToClean = currentVideo;

  videoPlayer.pause();
  videoPlayer.removeAttribute('src');
  videoPlayer.load();

  currentVideo = null;
  playbackStartTime = null;
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
}

function handleVideoPause() {
  playStatus.textContent = 'En pause';
  playStatus.className = 'stat-value status-paused';
}

function handleVideoError() {
  if (!currentVideo) return;
  const err = videoPlayer.error;
  console.error('Video error:', err?.code, err?.message);
  playStatus.textContent = 'Erreur — nouvelle tentative...';
  playStatus.className = 'stat-value status-waiting';

  setTimeout(() => {
    if (currentVideo) {
      videoPlayer.load();
      videoPlayer.play().catch(() => {});
    }
  }, 3000);
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
