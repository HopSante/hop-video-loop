#!/bin/bash

# --- Hop Video Loop - Lancement automatique ---
# Fonctionne sur TOUS les Mac : pas besoin d'admin, Homebrew, git ni Xcode

set -e

APP_DIR=~/Desktop/hop-video-loop
DEPS_DIR=~/.hop-video-loop
ARCH=$(uname -m)
REPO_URL="https://github.com/HopSante/hop-video-loop/archive/refs/heads/main.tar.gz"

# Ajouter les chemins connus au PATH
[ -d /opt/homebrew/bin ] && export PATH="/opt/homebrew/bin:$PATH"
[ -d /usr/local/bin ] && export PATH="/usr/local/bin:$PATH"
[ -d "$DEPS_DIR/node/bin" ] && export PATH="$DEPS_DIR/node/bin:$PATH"
[ -d "$DEPS_DIR/bin" ] && export PATH="$DEPS_DIR/bin:$PATH"

# --- 1. Node.js (téléchargement direct, aucun admin requis) ---
if ! command -v node &>/dev/null; then
  echo "📦 Installation de Node.js..."
  mkdir -p "$DEPS_DIR"
  NODE_VER="v20.11.1"
  [ "$ARCH" = "arm64" ] && PLATFORM="darwin-arm64" || PLATFORM="darwin-x64"
  echo "   Architecture détectée : $PLATFORM"
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-$PLATFORM.tar.gz" \
    | tar -xz -C "$DEPS_DIR"
  mv "$DEPS_DIR/node-$NODE_VER-$PLATFORM" "$DEPS_DIR/node"
  # Retirer la quarantaine macOS (Gatekeeper) pour autoriser l'exécution
  xattr -rd com.apple.quarantine "$DEPS_DIR/node" 2>/dev/null || true
  export PATH="$DEPS_DIR/node/bin:$PATH"
  echo "✅ Node.js $(node --version) installé"
else
  echo "✅ Node.js $(node --version) déjà installé"
fi

# --- 2. Projet (téléchargement via curl, pas besoin de git) ---
if [ -d "$APP_DIR/server.js" ] 2>/dev/null || [ -d "$APP_DIR" ] && [ -f "$APP_DIR/server.js" ]; then
  echo "🔄 Mise à jour du projet..."
  curl -fsSL "$REPO_URL" | tar -xz -C /tmp
  # Copier les fichiers source sans écraser node_modules, .env, .cache
  rsync -a --exclude='node_modules' --exclude='.env' --exclude='.cache' \
    /tmp/hop-video-loop-main/ "$APP_DIR/"
  rm -rf /tmp/hop-video-loop-main
else
  echo "⬇️ Téléchargement du projet..."
  curl -fsSL "$REPO_URL" | tar -xz -C /tmp
  mv /tmp/hop-video-loop-main "$APP_DIR"
fi

cd "$APP_DIR"

# --- 3. Dépendances npm ---
echo "📚 Installation des dépendances..."
npm install --no-fund --no-audit 2>&1 | tail -1

# --- 4. ffmpeg (via npm si absent du système) ---
if ! command -v ffmpeg &>/dev/null; then
  echo "📦 Installation de ffmpeg..."
  npm install --save --no-fund --no-audit \
    @ffmpeg-installer/ffmpeg @ffprobe-installer/ffprobe 2>/dev/null

  mkdir -p "$DEPS_DIR/bin"
  FFMPEG_PATH=$(node -e "try{console.log(require('@ffmpeg-installer/ffmpeg').path)}catch{}" 2>/dev/null)
  FFPROBE_PATH=$(node -e "try{console.log(require('@ffprobe-installer/ffprobe').path)}catch{}" 2>/dev/null)

  if [ -n "$FFMPEG_PATH" ] && [ -f "$FFMPEG_PATH" ]; then
    ln -sf "$FFMPEG_PATH" "$DEPS_DIR/bin/ffmpeg"
    chmod +x "$FFMPEG_PATH"
    xattr -d com.apple.quarantine "$FFMPEG_PATH" 2>/dev/null || true
    echo "✅ ffmpeg installé"
  else
    echo "⚠️  ffmpeg n'a pas pu être installé automatiquement"
  fi
  if [ -n "$FFPROBE_PATH" ] && [ -f "$FFPROBE_PATH" ]; then
    ln -sf "$FFPROBE_PATH" "$DEPS_DIR/bin/ffprobe"
    chmod +x "$FFPROBE_PATH"
    xattr -d com.apple.quarantine "$FFPROBE_PATH" 2>/dev/null || true
    echo "✅ ffprobe installé"
  fi
  export PATH="$DEPS_DIR/bin:$PATH"
else
  echo "✅ ffmpeg déjà installé"
fi

# --- 5. Arrêter l'ancien serveur si actif ---
lsof -ti:3000 2>/dev/null | xargs kill -9 2>/dev/null || true

# --- 6. Lancer ---
echo ""
echo "🚀 Lancement de Hop Video Loop..."
echo ""
export PATH="$DEPS_DIR/bin:$DEPS_DIR/node/bin:$PATH"

# Ouvrir Safari après un délai (en arrière-plan)
(sleep 3 && open -a Safari "http://localhost:3000") &

# Lancer le serveur au premier plan (exec remplace le shell → le serveur survit)
exec npm start
