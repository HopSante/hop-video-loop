#!/bin/bash

# --- Hop Video Loop - Lancement automatique ---

# 1. Homebrew
if ! command -v brew &>/dev/null; then
  echo "☕ Installation de Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
fi

# 2. Node.js & ffmpeg
for pkg in node ffmpeg; do
  if ! command -v $pkg &>/dev/null; then
    echo "📦 Installation de $pkg..."
    brew install $pkg
  fi
done

# 3. Telecharger ou mettre a jour le projet
if [ -d ~/Desktop/hop-video-loop ]; then
  echo "🔄 Mise a jour..."
  cd ~/Desktop/hop-video-loop && git pull
else
  echo "⬇️ Telechargement..."
  git clone https://github.com/HopSante/hop-video-loop.git ~/Desktop/hop-video-loop
  cd ~/Desktop/hop-video-loop
fi

# 4. Installer les dependances
npm install

# 5. Arreter l'ancien serveur si actif
lsof -ti:3000 | xargs kill -9 2>/dev/null

# 6. Lancer l'app
echo "🚀 Lancement de Hop Video Loop..."
npm start & sleep 3 && open -a Safari http://localhost:3000
