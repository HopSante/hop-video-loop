const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');
require('dotenv').config();

// --- Resolve ffmpeg/ffprobe paths (system or npm-installed) ---
let FFMPEG_PATH = 'ffmpeg';
let FFPROBE_PATH = 'ffprobe';
try { execSync('ffmpeg -version', { stdio: 'ignore' }); } catch {
  try { FFMPEG_PATH = require('@ffmpeg-installer/ffmpeg').path; } catch {}
}
try { execSync('ffprobe -version', { stdio: 'ignore' }); } catch {
  try { FFPROBE_PATH = require('@ffprobe-installer/ffprobe').path; } catch {}
}

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GOOGLE_API_KEY || 'AIzaSyAmk1UrzlVmGWdAeQ-dtYo0gyrktrMPOu8';
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || '19C-tRucX8LkVxHVOh3bxQMG9qc3C9jyC';
const CACHE_DIR = path.join(__dirname, '.cache');

// LIVE HLS state — sliding window playlist instead of massive VOD
const liveStreams = new Map();

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
  liveStreams.clear();
  if (fs.existsSync(CACHE_DIR)) {
    for (const entry of fs.readdirSync(CACHE_DIR)) {
      try { fs.rmSync(path.join(CACHE_DIR, entry), { recursive: true, force: true }); } catch {}
    }
  }
}

try { clearCacheDir(); } catch {}
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// Redirect localhost → network IP (Apple TV can't reach localhost)
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

function getHlsDir(fileId) { return path.join(CACHE_DIR, `${fileId}_hls`); }
function getOriginalPlaylistPath(fileId) { return path.join(getHlsDir(fileId), 'original.m3u8'); }

function hlsReady(fileId) {
  const p = getOriginalPlaylistPath(fileId);
  return fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes('#EXT-X-ENDLIST');
}

// --- Video Processing Pipeline ---
// 1. reencodeForAirPlay: Re-encode ONCE (Main profile, 4Mbps, add audio) → ~5-10s
// 2. segmentToHls: Segment into HLS VOD with -c copy → instant
// 3. LIVE playlist served dynamically (sliding window — no massive VOD file)

function runFfmpeg(args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, args, {
      cwd: cwd || undefined,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stderr = '';
    proc.stderr.on('data', d => stderr += d);
    proc.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg code ${code}: ${stderr.slice(-200)}`));
    });
  });
}

function checkHasAudio(videoPath) {
  return new Promise((resolve) => {
    const proc = spawn(FFPROBE_PATH, [
      '-v', 'quiet', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', videoPath
    ]);
    let output = '';
    proc.stdout.on('data', d => output += d);
    proc.on('close', () => resolve(output.includes('audio')));
  });
}

// Step 1: Re-encode for AirPlay compatibility
// Fixes: missing audio, High profile→Main, BT.2020→BT.709, 24Mbps→4Mbps
async function reencodeForAirPlay(videoPath, outputPath, hasAudio) {
  const inputArgs = ['-i', videoPath];
  const mapArgs = ['-map', '0:v:0'];

  if (hasAudio) {
    mapArgs.push('-map', '0:a:0');
  } else {
    inputArgs.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    mapArgs.push('-map', '1:a:0');
  }

  try {
    // Try hardware encoder first (fast)
    await runFfmpeg([
      ...inputArgs, ...mapArgs,
      '-c:v', 'h264_videotoolbox', '-profile:v', 'main', '-b:v', '4000k',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
      '-shortest', '-y', outputPath
    ]);
  } catch {
    // Fallback: software encoder
    await runFfmpeg([
      ...inputArgs, ...mapArgs,
      '-c:v', 'libx264', '-profile:v', 'main', '-level', '4.0',
      '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
      '-shortest', '-y', outputPath
    ]);
  }
}

// Step 2: Segment into HLS VOD (-c copy = instant)
async function segmentToHls(inputPath, hlsDir) {
  await runFfmpeg([
    '-i', inputPath,
    '-c', 'copy',
    '-f', 'hls', '-hls_time', '10', '-hls_list_size', '0',
    '-hls_playlist_type', 'vod', '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', 'seg_%05d.ts',
    '-y', 'original.m3u8'
  ], hlsDir);
}

// Step 3: LIVE HLS — parse original.m3u8 and store segment metadata
function initLiveStream(fileId) {
  const originalPath = getOriginalPlaylistPath(fileId);
  if (!fs.existsSync(originalPath)) return false;

  const content = fs.readFileSync(originalPath, 'utf8');
  const lines = content.split('\n');

  const segments = [];
  let targetDuration = 10;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseInt(line.split(':')[1]);
    }
    if (line.startsWith('#EXTINF:')) {
      const duration = parseFloat(line.split(':')[1]);
      const filename = (lines[i + 1] || '').trim();
      segments.push({ duration, filename, extinf: line });
      i++;
    }
  }

  if (!segments.length) return false;

  const totalDuration = segments.reduce((sum, s) => sum + s.duration, 0);

  liveStreams.set(fileId, {
    segments,
    targetDuration,
    totalDuration,
    startTime: Date.now(),
  });

  console.log(`  LIVE stream : ${segments.length} seg × ~${Math.round(totalDuration)}s — boucle infinie`);
  return true;
}

// Generate a small sliding-window LIVE playlist (7 segments max)
function generateLivePlaylist(fileId) {
  const stream = liveStreams.get(fileId);
  if (!stream) return null;

  const { segments, targetDuration, totalDuration } = stream;
  const segCount = segments.length;

  // Calculate current position based on elapsed time
  const elapsed = (Date.now() - stream.startTime) / 1000;
  const loopsCompleted = Math.floor(elapsed / totalDuration);
  const posInLoop = elapsed % totalDuration;

  // Find which segment we're in
  let segInLoop = 0;
  let acc = 0;
  for (let i = 0; i < segCount; i++) {
    acc += segments[i].duration;
    if (acc >= posInLoop) {
      segInLoop = i;
      break;
    }
  }

  const currentSeg = loopsCompleted * segCount + segInLoop;

  // Sliding window: 3 segments behind + current + 3 ahead
  const startSeq = Math.max(0, currentSeg - 3);
  const windowSize = 7;

  let playlist = '#EXTM3U\n';
  playlist += '#EXT-X-VERSION:3\n';
  playlist += `#EXT-X-TARGETDURATION:${targetDuration}\n`;
  playlist += `#EXT-X-MEDIA-SEQUENCE:${startSeq}\n`;
  // No PLAYLIST-TYPE = LIVE stream
  // No ENDLIST = stream never ends

  let prevLoop = Math.floor(startSeq / segCount);
  for (let i = 0; i < windowSize; i++) {
    const absIdx = startSeq + i;
    const loop = Math.floor(absIdx / segCount);
    const segIdx = absIdx % segCount;

    if (i > 0 && loop !== prevLoop) {
      playlist += '#EXT-X-DISCONTINUITY\n';
    }
    prevLoop = loop;

    playlist += segments[segIdx].extinf + '\n';
    playlist += segments[segIdx].filename + '\n';
  }

  return playlist;
}

// --- Google Drive ---
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

// --- Routes ---

app.get('/api/videos', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1';
    if (forceRefresh || !videoListCache || (Date.now() - videoListCacheTime) >= CACHE_TTL) {
      updateVideoListCache(await fetchAllVideos());
    }
    res.json(videoListCache.map(f => ({ ...f, cached: !!getCachedFile(f.id), hlsReady: hlsReady(f.id) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

fetchAllVideos().then(videos => {
  updateVideoListCache(videos);
  console.log(`  Liste pré-chargée : ${videoListCache.length} vidéos`);
}).catch(() => {});

app.get('/api/download/:fileId', async (req, res) => {
  const fileId = req.params.fileId;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    if (hlsReady(fileId)) {
      send({ type: 'complete' });
      return res.end();
    }

    // --- Download from Google Drive ---
    let cachedPath = getCachedFile(fileId);

    if (!cachedPath) {
      send({ type: 'status', message: 'Récupération...' });
      const metaUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,size,mimeType&key=${API_KEY}`;
      const meta = await (await fetch(metaUrl)).json();
      if (meta.error) { send({ type: 'error', message: meta.error.message }); return res.end(); }

      const totalSize = parseInt(meta.size) || 0;
      const ext = path.extname(meta.name) || '.mp4';
      cachedPath = path.join(CACHE_DIR, `${fileId}${ext}`);
      fs.writeFileSync(path.join(CACHE_DIR, `${fileId}.json`),
        JSON.stringify({ name: meta.name, mimeType: meta.mimeType, size: totalSize }));

      send({ type: 'status', message: 'Téléchargement...' });
      const downloadRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${API_KEY}`);
      if (!downloadRes.ok) { send({ type: 'error', message: `Erreur ${downloadRes.status}` }); return res.end(); }

      const fileStream = fs.createWriteStream(cachedPath);
      let downloaded = 0, lastPct = 0;
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
      await new Promise((resolve, reject) => { fileStream.on('finish', resolve); fileStream.on('error', reject); });
    }

    // --- Prepare HLS for AirPlay ---
    const hlsDir = getHlsDir(fileId);
    if (fs.existsSync(hlsDir)) try { fs.rmSync(hlsDir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(hlsDir, { recursive: true });

    const hasAudio = await checkHasAudio(cachedPath);
    const reencoded = path.join(hlsDir, 'source.mp4');

    // Step 1: Re-encode for AirPlay (~5-10s for a short video)
    send({ type: 'status', message: 'Encodage AirPlay...' });
    console.log(`  Re-encode AirPlay pour ${fileId} (audio: ${hasAudio})`);
    await reencodeForAirPlay(cachedPath, reencoded, hasAudio);

    // Step 2: Segment into HLS VOD (instant)
    send({ type: 'status', message: 'Segmentation...' });
    await segmentToHls(reencoded, hlsDir);

    // Step 3: Initialize LIVE stream (dynamic playlist)
    initLiveStream(fileId);

    // Clean up intermediate
    try { fs.unlinkSync(reencoded); } catch {}

    console.log(`  HLS prêt pour ${fileId}`);
    send({ type: 'complete' });
    res.end();
  } catch (err) {
    console.error('Download/HLS error:', err.message);
    send({ type: 'error', message: err.message });
    res.end();
  }
});

// --- HLS serving (LIVE sliding window) ---

app.get('/api/hls/:fileId/playlist.m3u8', (req, res) => {
  const fileId = req.params.fileId;

  // Lazy-init: if segments exist but stream not in memory (e.g. after page reload)
  if (!liveStreams.has(fileId)) {
    if (!initLiveStream(fileId)) {
      return res.status(404).json({ error: 'Non prêt' });
    }
  }

  const playlist = generateLivePlaylist(fileId);
  if (!playlist) return res.status(404).json({ error: 'Non prêt' });

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  // LIVE = no cache — player must re-fetch to get updated window
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.send(playlist);
});

app.get('/api/hls/:fileId/:segFile', (req, res) => {
  const { fileId, segFile } = req.params;
  if (!segFile.endsWith('.ts')) return res.status(400).end();
  const segPath = path.join(getHlsDir(fileId), segFile);
  if (!fs.existsSync(segPath)) return res.status(404).end();
  const stat = fs.statSync(segPath);
  res.setHeader('Content-Type', 'video/MP2T');
  res.setHeader('Content-Length', stat.size);
  // Short cache — segments repeat in LIVE loops, player must re-fetch
  res.setHeader('Cache-Control', 'public, max-age=30');
  res.setHeader('Accept-Ranges', 'bytes');
  fs.createReadStream(segPath).pipe(res);
});

// --- Cache management ---

app.delete('/api/cache/:fileId', (req, res) => {
  const fileId = req.params.fileId;
  liveStreams.delete(fileId);
  const filePath = getCachedFile(fileId);
  const metaPath = path.join(CACHE_DIR, `${fileId}.json`);
  const hlsDir = getHlsDir(fileId);
  if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
  try { if (fs.existsSync(hlsDir)) fs.rmSync(hlsDir, { recursive: true, force: true }); } catch {}
  res.json({ success: true });
});

function handleClearCache(req, res) { clearCacheDir(); res.json({ success: true }); }
app.post('/api/cache/clear', handleClearCache);
app.delete('/api/cache', handleClearCache);

// --- Start ---

const server = app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIp();
  console.log(`\n  Hop Video Loop — http://${ip}:${PORT}\n  LIVE HLS — AirPlay optimisé — boucle infinie\n`);
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 125000;
});
