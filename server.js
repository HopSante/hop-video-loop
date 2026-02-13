const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GOOGLE_API_KEY;
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const CACHE_DIR = path.join(__dirname, '.cache');

// --- CORS (Apple TV fetches HLS segments directly via AirPlay) ---
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

function clearCacheDir() {
  if (fs.existsSync(CACHE_DIR)) {
    for (const entry of fs.readdirSync(CACHE_DIR)) {
      try { fs.rmSync(path.join(CACHE_DIR, entry), { recursive: true, force: true }); } catch {}
    }
  }
}

try { clearCacheDir(); } catch {}
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// Redirect localhost to network IP (AirPlay sends video URL to Apple TV,
// which can't reach "localhost" — it needs the real network IP)
app.use((req, res, next) => {
  const host = req.hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    const ip = getLocalIp();
    if (ip !== 'localhost') {
      return res.redirect(301, `http://${ip}:${PORT}${req.originalUrl}`);
    }
  }
  next();
});

// Request logging
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    const ua = req.headers['user-agent'] || '';
    const from = req.ip || req.connection.remoteAddress;
    console.log(`  [${new Date().toLocaleTimeString()}] ${req.method} ${req.path} — from ${from} — UA: ${ua.substring(0, 60)}`);
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// --- Helpers ---

function getLocalIp() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) return alias.address;
    }
  }
  return 'localhost';
}

function getCachedFile(fileId) {
  if (!fs.existsSync(CACHE_DIR)) return null;
  const cached = fs.readdirSync(CACHE_DIR)
    .find(f => f.startsWith(fileId) && !f.endsWith('.json') && !f.includes('_hls'));
  return cached ? path.join(CACHE_DIR, cached) : null;
}

function getHlsDir(fileId) {
  return path.join(CACHE_DIR, `${fileId}_hls`);
}

function getPlaylistPath(fileId) {
  return path.join(getHlsDir(fileId), 'playlist.m3u8');
}

function segmentCount(fileId) {
  const m3u8Path = getPlaylistPath(fileId);
  if (!fs.existsSync(m3u8Path)) return 0;
  const content = fs.readFileSync(m3u8Path, 'utf8');
  return (content.match(/#EXTINF/g) || []).length;
}

// VOD ready = playlist exists and contains #EXT-X-ENDLIST (ffmpeg finished)
function hlsReady(fileId) {
  const m3u8Path = getPlaylistPath(fileId);
  if (!fs.existsSync(m3u8Path)) return false;
  const content = fs.readFileSync(m3u8Path, 'utf8');
  return content.includes('#EXT-X-ENDLIST');
}

// --- ffmpeg processes ---
const ffmpegProcesses = {};

function spawnFfmpeg(fileId, videoPath, reencode = false) {
  const hlsDir = getHlsDir(fileId);
  if (fs.existsSync(hlsDir)) {
    try { fs.rmSync(hlsDir, { recursive: true, force: true }); } catch {}
  }
  fs.mkdirSync(hlsDir, { recursive: true });

  // VOD HLS: segment once, no real-time constraint, no loop
  // Apple AirPlay best practices: Main profile, level 4.0, yuv420p, AAC-LC
  const codecArgs = reencode
    ? ['-c:v', 'libx264', '-profile:v', 'main', '-level', '4.0', '-pix_fmt', 'yuv420p',
       '-preset', 'fast', '-crf', '23', '-sc_threshold', '0',
       '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2']
    : ['-c', 'copy'];

  const args = [
    '-i', videoPath,
    ...codecArgs,
    '-f', 'hls',
    '-hls_time', '6',
    '-hls_list_size', '0',
    '-hls_playlist_type', 'vod',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', 'seg_%05d.ts',
    '-y', 'playlist.m3u8'
  ];

  const label = reencode ? 'ffmpeg VOD re-encode' : 'ffmpeg VOD segment';
  console.log(`  ${label} démarré pour ${fileId}`);

  const proc = spawn('ffmpeg', args, {
    cwd: hlsDir,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  ffmpegProcesses[fileId] = proc;

  proc.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('Error') || msg.includes('error')) {
      console.error(`  ${label} [${fileId}]: ${msg.trim()}`);
    }
  });

  proc.on('exit', (code) => {
    console.log(`  ${label} [${fileId}] terminé (code ${code})`);
    delete ffmpegProcesses[fileId];
  });

  return proc;
}

function stopFfmpeg(fileId) {
  const proc = ffmpegProcesses[fileId];
  if (proc) {
    try { proc.kill('SIGTERM'); } catch {}
    delete ffmpegProcesses[fileId];
  }
}

function stopAllFfmpeg() {
  Object.keys(ffmpegProcesses).forEach(id => stopFfmpeg(id));
}

// --- Video list cache ---
let videoListCache = null;
let videoListCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

function formatDriveVideo(f) {
  return {
    id: f.id, name: f.name, folder: f.folder, mimeType: f.mimeType,
    size: f.size ? parseInt(f.size) : 0,
    duration: f.videoMediaMetadata?.durationMillis
      ? Math.round(parseInt(f.videoMediaMetadata.durationMillis) / 1000) : null,
  };
}

function enrichWithStatus(f) {
  return { ...f, cached: !!getCachedFile(f.id), hlsReady: hlsReady(f.id) };
}

// --- Routes ---

app.get('/api/info', (req, res) => {
  res.json({ ip: getLocalIp(), port: PORT });
});

async function listDriveFiles(folderId, mimeFilter) {
  const q = mimeFilter
    ? `'${folderId}' in parents and ${mimeFilter} and trashed = false`
    : `'${folderId}' in parents and trashed = false`;
  const fields = encodeURIComponent('files(id,name,mimeType,size,videoMediaMetadata)');
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&key=${API_KEY}&fields=${fields}&orderBy=name&pageSize=100`;
  const response = await fetch(url);
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.files || [];
}

async function fetchAllVideos() {
  const rootItems = await listDriveFiles(FOLDER_ID);
  const folders = rootItems.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
  const rootVideos = rootItems.filter(f => f.mimeType.startsWith('video/'));
  const subResults = await Promise.all(
    folders.map(async (folder) => {
      const videos = await listDriveFiles(folder.id, "mimeType contains 'video/'");
      return videos.map(v => ({ ...v, folder: folder.name }));
    })
  );
  return [...rootVideos.map(v => ({ ...v, folder: null })), ...subResults.flat()];
}

function updateVideoListCache(videos) {
  videoListCache = videos.map(formatDriveVideo);
  videoListCacheTime = Date.now();
}

app.get('/api/videos', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1';
    const now = Date.now();

    if (forceRefresh || !videoListCache || (now - videoListCacheTime) >= CACHE_TTL) {
      updateVideoListCache(await fetchAllVideos());
    }

    res.json(videoListCache.map(enrichWithStatus));
  } catch (err) {
    console.error('Error listing videos:', err.message);
    res.status(500).json({ error: err.message });
  }
});

fetchAllVideos().then(videos => {
  updateVideoListCache(videos);
  console.log(`  Liste pré-chargée : ${videoListCache.length} vidéos`);
}).catch(() => {});

// Wait for ffmpeg VOD segmentation to complete (#EXT-X-ENDLIST present)
async function waitForVodReady(fileId, maxSeconds, send, statusPrefix) {
  for (let i = 0; i < maxSeconds; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (hlsReady(fileId)) return true;
    const count = segmentCount(fileId);
    send({ type: 'status', message: `${statusPrefix} (${count} segments, ${i + 1}s)` });
    // ffmpeg exited — check one last time
    if (!ffmpegProcesses[fileId]) return hlsReady(fileId);
  }
  return false;
}

app.get('/api/download/:fileId', async (req, res) => {
  const fileId = req.params.fileId;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    if (hlsReady(fileId)) {
      send({ type: 'complete', message: 'Prêt' });
      return res.end();
    }

    let cachedPath = getCachedFile(fileId);

    if (!cachedPath) {
      send({ type: 'status', message: 'Récupération des métadonnées...' });
      const metaUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,size,mimeType&key=${API_KEY}`;
      const metaRes = await fetch(metaUrl);
      const meta = await metaRes.json();
      if (meta.error) { send({ type: 'error', message: meta.error.message }); return res.end(); }

      const totalSize = parseInt(meta.size) || 0;
      const ext = path.extname(meta.name) || '.mp4';
      cachedPath = path.join(CACHE_DIR, `${fileId}${ext}`);

      fs.writeFileSync(path.join(CACHE_DIR, `${fileId}.json`),
        JSON.stringify({ name: meta.name, mimeType: meta.mimeType, size: totalSize }));

      send({ type: 'status', message: 'Téléchargement...' });
      const downloadUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${API_KEY}`;
      const downloadRes = await fetch(downloadUrl);
      if (!downloadRes.ok) {
        send({ type: 'error', message: `Erreur ${downloadRes.status}` });
        return res.end();
      }

      const fileStream = fs.createWriteStream(cachedPath);
      let downloaded = 0;
      let lastPct = 0;
      const reader = downloadRes.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fileStream.write(Buffer.from(value));
        downloaded += value.length;
        const pct = totalSize > 0 ? Math.round((downloaded / totalSize) * 100) : 0;
        if (pct >= lastPct + 2 || pct === 100) {
          lastPct = pct;
          send({ type: 'progress', downloaded, total: totalSize, percent: pct });
        }
      }
      fileStream.end();
      await new Promise((resolve, reject) => {
        fileStream.on('finish', resolve);
        fileStream.on('error', reject);
      });
    }

    // Segment as VOD HLS (fast, no real-time constraint)
    send({ type: 'status', message: 'Préparation des segments vidéo...' });
    stopFfmpeg(fileId);
    spawnFfmpeg(fileId, cachedPath);

    let ready = await waitForVodReady(fileId, 120, send, 'Segmentation en cours...');

    if (!ready && !ffmpegProcesses[fileId]) {
      send({ type: 'status', message: 'Ré-encodage pour compatibilité AirPlay...' });
      spawnFfmpeg(fileId, cachedPath, true);
      ready = await waitForVodReady(fileId, 300, send, 'Ré-encodage...');
    }

    if (!ready) {
      stopFfmpeg(fileId);
      send({ type: 'error', message: 'Impossible de préparer la vidéo' });
      return res.end();
    }

    console.log(`  VOD HLS prêt pour ${fileId} (${segmentCount(fileId)} segments)`);
    send({ type: 'complete', message: 'Prêt' });
    res.end();
  } catch (err) {
    console.error('Download/HLS error:', err.message);
    send({ type: 'error', message: err.message });
    res.end();
  }
});

// --- HLS serving (static VOD segments) ---

app.get('/api/hls/:fileId/playlist.m3u8', (req, res) => {
  const m3u8Path = getPlaylistPath(req.params.fileId);
  if (!fs.existsSync(m3u8Path)) return res.status(404).json({ error: 'Vidéo non prête' });

  const content = fs.readFileSync(m3u8Path, 'utf8');
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  // VOD playlist is static — cache it but allow refresh
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Connection', 'keep-alive');
  res.send(content);
});

app.get('/api/hls/:fileId/:segFile', (req, res) => {
  const { fileId, segFile } = req.params;
  if (!segFile.endsWith('.ts')) return res.status(400).end();

  const segPath = path.join(getHlsDir(fileId), segFile);
  if (!fs.existsSync(segPath)) return res.status(404).end();

  const stat = fs.statSync(segPath);
  res.setHeader('Content-Type', 'video/MP2T');
  res.setHeader('Content-Length', stat.size);
  // VOD segments never change — cache aggressively
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Connection', 'keep-alive');
  fs.createReadStream(segPath).pipe(res);
});

app.get('/api/play/:fileId', (req, res) => {
  const filePath = getCachedFile(req.params.fileId);
  if (!filePath) return res.status(404).json({ error: 'Non trouvé' });

  const fileSize = fs.statSync(filePath).size;
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v' };
  const mimeType = mimeTypes[ext] || 'video/mp4';
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': mimeType,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize, 'Content-Type': mimeType, 'Accept-Ranges': 'bytes'
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

app.delete('/api/cache/:fileId', (req, res) => {
  const fileId = req.params.fileId;
  stopFfmpeg(fileId);
  const filePath = getCachedFile(fileId);
  const metaPath = path.join(CACHE_DIR, `${fileId}.json`);
  const hlsDir = getHlsDir(fileId);
  if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
  try { if (fs.existsSync(hlsDir)) fs.rmSync(hlsDir, { recursive: true, force: true }); } catch {}
  res.json({ success: true });
});

function handleClearCache(req, res) {
  stopAllFfmpeg();
  clearCacheDir();
  res.json({ success: true });
}
app.post('/api/cache/clear', handleClearCache);
app.delete('/api/cache', handleClearCache);

process.on('SIGTERM', () => { stopAllFfmpeg(); process.exit(0); });
process.on('SIGINT', () => { stopAllFfmpeg(); process.exit(0); });

const server = app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIp();
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║           Hop Video Loop                     ║');
  console.log('  ╠══════════════════════════════════════════════╣');
  console.log(`  ║  Local:   http://localhost:${PORT}              ║`);
  console.log(`  ║  Réseau:  http://${ip}:${PORT}        ║`);
  console.log('  ╠══════════════════════════════════════════════╣');
  console.log('  ║  VOD HLS — AirPlay optimisé — boucle auto   ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');

  // Keep-alive for AirPlay connections
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 125000;
});
