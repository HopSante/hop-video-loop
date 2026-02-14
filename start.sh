#!/bin/bash

# --- Hop Video Loop - Lancement automatique ---
# Fonctionne sur TOUS les Mac : pas besoin d'admin, Homebrew, git ni Xcode

set -e

APP_DIR=~/Desktop/hop-video-loop
DEPS_DIR=~/.hop-video-loop
ARCH=$(uname -m)
REPO_URL="https://github.com/HopSante/hop-video-loop/archive/refs/heads/main.tar.gz"

# --- 0. Vérifications préalables ---

# Vérifier l'espace disque (minimum 500 Mo)
AVAIL_MB=$(df -m ~ 2>/dev/null | tail -1 | awk '{print $4}')
if [ -n "$AVAIL_MB" ] && [ "$AVAIL_MB" -lt 500 ] 2>/dev/null; then
  echo "❌ Espace disque insuffisant : ${AVAIL_MB} Mo disponibles (minimum 500 Mo)"
  echo "   Libérez de l'espace sur ce Mac avant de relancer."
  exit 1
fi

# Détecter la version de macOS pour choisir le bon Node.js
MACOS_VER=$(sw_vers -productVersion 2>/dev/null || echo "0.0")
MACOS_MAJOR=$(echo "$MACOS_VER" | cut -d. -f1)
MACOS_MINOR=$(echo "$MACOS_VER" | cut -d. -f2)

if [ "$MACOS_MAJOR" -ge 11 ] 2>/dev/null; then
  # macOS 11 (Big Sur) et + → Node 20
  NODE_VER="v20.11.1"
elif [ "$MACOS_MAJOR" -eq 10 ] && [ "$MACOS_MINOR" -ge 15 ] 2>/dev/null; then
  # macOS 10.15 (Catalina) → Node 18
  NODE_VER="v18.19.1"
elif [ "$MACOS_MAJOR" -eq 10 ] && [ "$MACOS_MINOR" -ge 13 ] 2>/dev/null; then
  # macOS 10.13-10.14 (High Sierra / Mojave) → Node 16
  NODE_VER="v16.20.2"
else
  echo "❌ macOS $MACOS_VER trop ancien. Minimum requis : macOS 10.13 (High Sierra)"
  echo "   Mettez à jour macOS ou utilisez un Mac plus récent."
  exit 1
fi

echo "   macOS $MACOS_VER détecté → Node.js $NODE_VER"

# Ajouter les chemins connus au PATH
[ -d /opt/homebrew/bin ] && export PATH="/opt/homebrew/bin:$PATH"
[ -d /usr/local/bin ] && export PATH="/usr/local/bin:$PATH"
[ -d "$DEPS_DIR/node/bin" ] && export PATH="$DEPS_DIR/node/bin:$PATH"
[ -d "$DEPS_DIR/bin" ] && export PATH="$DEPS_DIR/bin:$PATH"

# --- 1. Node.js (téléchargement direct, aucun admin requis) ---
install_node() {
  echo "📦 Installation de Node.js $NODE_VER..."
  mkdir -p "$DEPS_DIR"
  [ "$ARCH" = "arm64" ] && PLATFORM="darwin-arm64" || PLATFORM="darwin-x64"
  echo "   Architecture détectée : $PLATFORM"
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-$PLATFORM.tar.gz" \
    | tar -xz -C "$DEPS_DIR"
  rm -rf "$DEPS_DIR/node"
  mv "$DEPS_DIR/node-$NODE_VER-$PLATFORM" "$DEPS_DIR/node"
  xattr -rd com.apple.quarantine "$DEPS_DIR/node" 2>/dev/null || true
  export PATH="$DEPS_DIR/node/bin:$PATH"
  # Vérifier que Node.js fonctionne réellement
  if ! "$DEPS_DIR/node/bin/node" --version &>/dev/null; then
    echo "❌ Node.js $NODE_VER ne fonctionne pas sur ce Mac (macOS $MACOS_VER)"
    echo "   Essayez de mettre à jour macOS."
    exit 1
  fi
  echo "✅ Node.js $("$DEPS_DIR/node/bin/node" --version) installé"
}

if ! command -v node &>/dev/null; then
  install_node
else
  CURRENT_NODE=$(node --version 2>/dev/null || echo "")
  if [ -z "$CURRENT_NODE" ]; then
    install_node
  else
    echo "✅ Node.js $CURRENT_NODE déjà installé"
  fi
fi

# --- 2. Projet (téléchargement via curl, pas besoin de git) ---
if [ -d "$APP_DIR" ] && [ -f "$APP_DIR/server.js" ]; then
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

# Obtenir l'IP réseau (pour AirPlay, localhost ne suffit pas)
LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "localhost")
APP_URL="http://${LOCAL_IP}:3000"

# Ouvrir UNIQUEMENT dans Safari (osascript évite que Chrome s'ouvre aussi)
(sleep 3 && osascript -e "tell application \"Safari\" to open location \"$APP_URL\"") &

# Lancer le serveur au premier plan (exec remplace le shell → le serveur survit)
exec npm start
