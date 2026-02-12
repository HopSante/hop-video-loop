const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Readable } = require('stream');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GOOGLE_API_KEY;
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const CACHE_DIR = path.join(__dirname, '.cache');

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

app.use(express.static(path.join(__dirname, 'public')));

// --- Helpers ---

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) {
        return alias.address;
      }
    }
  }
  return 'localhost';
}

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const types = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.m4v': 'video/x-m4v',
  };
  return types[ext] || 'video/mp4';
}

function getCachedFile(fileId) {
  if (!fs.existsSync(CACHE_DIR)) return null;
  const files = fs.readdirSync(CACHE_DIR);
  const cached = files.find(f => f.startsWith(fileId) && !f.endsWith('.json'));
  return cached ? path.join(CACHE_DIR, cached) : null;
}

// --- Routes ---

// Server info (local IP for AirPlay)
app.get('/api/info', (req, res) => {
  res.json({ ip: getLocalIp(), port: PORT });
});

// List videos from Google Drive folder
app.get('/api/videos', async (req, res) => {
  try {
    const query = encodeURIComponent(`'${FOLDER_ID}' in parents and mimeType contains 'video/' and trashed = false`);
    const fields = encodeURIComponent('files(id,name,mimeType,size,thumbnailLink,videoMediaMetadata)');
    const url = `https://www.googleapis.com/drive/v3/files?q=${query}&key=${API_KEY}&fields=${fields}&orderBy=name&pageSize=100`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.error) {
      console.error('Google Drive API error:', data.error);
      return res.status(data.error.code || 500).json({ error: data.error.message });
    }

    const files = (data.files || []).map(f => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      size: f.size ? parseInt(f.size) : 0,
      cached: !!getCachedFile(f.id),
      duration: f.videoMediaMetadata?.durationMillis
        ? Math.round(parseInt(f.videoMediaMetadata.durationMillis) / 1000)
        : null,
    }));

    res.json(files);
  } catch (err) {
    console.error('Error listing videos:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Download video to local cache (SSE progress)
app.get('/api/download/:fileId', async (req, res) => {
  const fileId = req.params.fileId;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    // Check if already cached
    const existing = getCachedFile(fileId);
    if (existing) {
      send({ type: 'complete', message: 'Vidéo déjà en cache' });
      return res.end();
    }

    // Get file metadata
    send({ type: 'status', message: 'Récupération des métadonnées...' });
    const metaUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,size,mimeType&key=${API_KEY}`;
    const metaRes = await fetch(metaUrl);
    const meta = await metaRes.json();

    if (meta.error) {
      send({ type: 'error', message: meta.error.message });
      return res.end();
    }

    const totalSize = parseInt(meta.size) || 0;
    const ext = path.extname(meta.name) || '.mp4';
    const cachePath = path.join(CACHE_DIR, `${fileId}${ext}`);

    // Save metadata
    fs.writeFileSync(
      path.join(CACHE_DIR, `${fileId}.json`),
      JSON.stringify({ name: meta.name, mimeType: meta.mimeType, size: totalSize })
    );

    // Download file
    send({ type: 'status', message: `Téléchargement de "${meta.name}"...` });
    const downloadUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${API_KEY}`;
    const downloadRes = await fetch(downloadUrl);

    if (!downloadRes.ok) {
      const errText = await downloadRes.text();
      send({ type: 'error', message: `Erreur de téléchargement (${downloadRes.status}): ${errText.substring(0, 200)}` });
      return res.end();
    }

    const fileStream = fs.createWriteStream(cachePath);
    let downloaded = 0;
    let lastProgressSent = 0;

    const reader = downloadRes.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      fileStream.write(Buffer.from(value));
      downloaded += value.length;

      // Send progress every 2%
      const percent = totalSize > 0 ? Math.round((downloaded / totalSize) * 100) : 0;
      if (percent >= lastProgressSent + 2 || percent === 100) {
        lastProgressSent = percent;
        send({
          type: 'progress',
          downloaded,
          total: totalSize,
          percent,
        });
      }
    }

    fileStream.end();
    await new Promise((resolve, reject) => {
      fileStream.on('finish', resolve);
      fileStream.on('error', reject);
    });

    send({ type: 'complete', message: 'Téléchargement terminé' });
    res.end();
  } catch (err) {
    console.error('Download error:', err.message);
    send({ type: 'error', message: err.message });
    res.end();
  }

  req.on('close', () => {
    // Client disconnected during download
  });
});

// Serve cached video with range request support
app.get('/api/play/:fileId', (req, res) => {
  const fileId = req.params.fileId;
  const filePath = getCachedFile(fileId);

  if (!filePath) {
    return res.status(404).json({ error: 'Vidéo non trouvée en cache. Téléchargez-la d\'abord.' });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const mimeType = getMimeType(filePath);
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': mimeType,
    });

    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
    });

    fs.createReadStream(filePath).pipe(res);
  }
});

// Delete cached video
app.delete('/api/cache/:fileId', (req, res) => {
  const fileId = req.params.fileId;
  const filePath = getCachedFile(fileId);
  const metaPath = path.join(CACHE_DIR, `${fileId}.json`);

  if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);

  res.json({ success: true });
});

// --- Start server ---

app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIp();
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║         🎬  Hop Video Loop               ║');
  console.log('  ╠══════════════════════════════════════════╣');
  console.log(`  ║  Local:   http://localhost:${PORT}          ║`);
  console.log(`  ║  Réseau:  http://${ip}:${PORT}    ║`);
  console.log('  ╠══════════════════════════════════════════╣');
  console.log('  ║  Ouvrez dans Safari pour AirPlay         ║');
  console.log('  ║  Les TV LG doivent être sur le même WiFi ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
});
