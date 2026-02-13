#!/bin/bash

# --- Hop Video Loop - Lancement automatique ---
# Fonctionne SANS droits administrateur ni Homebrew

APP_DIR=~/Desktop/hop-video-loop
DEPS_DIR=~/.hop-video-loop
ARCH=$(uname -m)

# Ajouter les chemins connus au PATH
[ -d /opt/homebrew/bin ] && export PATH="/opt/homebrew/bin:$PATH"
[ -d /usr/local/bin ] && export PATH="/usr/local/bin:$PATH"
[ -d "$DEPS_DIR/node/bin" ] && export PATH="$DEPS_DIR/node/bin:$PATH"
[ -d "$DEPS_DIR/bin" ] && export PATH="$DEPS_DIR/bin:$PATH"

# --- 1. Node.js ---
if ! command -v node &>/dev/null; then
  echo "📦 Installation de Node.js..."
  mkdir -p "$DEPS_DIR"
  NODE_VER="v20.11.1"
  [ "$ARCH" = "arm64" ] && PLATFORM="darwin-arm64" || PLATFORM="darwin-x64"
  echo "   Téléchargement pour $PLATFORM..."
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-$PLATFORM.tar.gz" \
    | tar -xz -C "$DEPS_DIR"
  mv "$DEPS_DIR/node-$NODE_VER-$PLATFORM" "$DEPS_DIR/node"
  export PATH="$DEPS_DIR/node/bin:$PATH"
  echo "✅ Node.js $(node --version) installé"
else
  echo "✅ Node.js $(node --version) déjà installé"
fi

# --- 2. Projet ---
if [ -d "$APP_DIR" ]; then
  echo "🔄 Mise à jour..."
  cd "$APP_DIR" && git pull
else
  echo "⬇️ Téléchargement du projet..."
  git clone https://github.com/HopSante/hop-video-loop.git "$APP_DIR"
  cd "$APP_DIR"
fi

# --- 3. Dépendances npm ---
cd "$APP_DIR"
npm install

# --- 4. ffmpeg (via npm si absent du système) ---
if ! command -v ffmpeg &>/dev/null; then
  echo "📦 Installation de ffmpeg..."
  npm install --save @ffmpeg-installer/ffmpeg @ffprobe-installer/ffprobe 2>/dev/null

  mkdir -p "$DEPS_DIR/bin"
  FFMPEG_PATH=$(node -e "try{console.log(require('@ffmpeg-installer/ffmpeg').path)}catch{}" 2>/dev/null)
  FFPROBE_PATH=$(node -e "try{console.log(require('@ffprobe-installer/ffprobe').path)}catch{}" 2>/dev/null)

  if [ -n "$FFMPEG_PATH" ] && [ -f "$FFMPEG_PATH" ]; then
    ln -sf "$FFMPEG_PATH" "$DEPS_DIR/bin/ffmpeg"
    chmod +x "$FFMPEG_PATH"
    echo "✅ ffmpeg installé"
  fi
  if [ -n "$FFPROBE_PATH" ] && [ -f "$FFPROBE_PATH" ]; then
    ln -sf "$FFPROBE_PATH" "$DEPS_DIR/bin/ffprobe"
    chmod +x "$FFPROBE_PATH"
    echo "✅ ffprobe installé"
  fi
  export PATH="$DEPS_DIR/bin:$PATH"
else
  echo "✅ ffmpeg déjà installé"
fi

# --- 5. Arrêter l'ancien serveur si actif ---
lsof -ti:3000 | xargs kill -9 2>/dev/null

# --- 6. Lancer ---
echo "🚀 Lancement de Hop Video Loop..."
export PATH="$DEPS_DIR/bin:$DEPS_DIR/node/bin:$PATH"
npm start &
sleep 3
open -a Safari http://localhost:3000
