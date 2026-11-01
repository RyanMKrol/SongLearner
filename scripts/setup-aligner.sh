#!/bin/sh
# Installs the Python side of the karaoke fill (aligner/align.py) into aligner/.venv.
# Needs Python 3.10 to 3.13, ffmpeg, and Deno (yt-dlp needs it to download from YouTube). The models (about 1.3GB) download the first time a song
# is aligned, into ~/.cache/torch.
set -e
cd "$(dirname "$0")/../aligner"

PYTHON=""
for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$candidate" >/dev/null 2>&1 &&
    "$candidate" -c 'import sys; sys.exit(0 if (3, 10) <= sys.version_info[:2] <= (3, 13) else 1)' 2>/dev/null; then
    PYTHON="$candidate"
    break
  fi
done
if [ -z "$PYTHON" ]; then
  echo "Needs Python 3.10 to 3.13 (PyTorch doesn't support newer ones yet). Try: brew install python@3.12" >&2
  exit 1
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "Needs ffmpeg to read audio files. Try: brew install ffmpeg" >&2
  exit 1
fi
if ! command -v deno >/dev/null 2>&1; then
  echo "Needs Deno, which yt-dlp uses to unlock YouTube downloads. Try: brew install deno" >&2
  exit 1
fi

echo "Using $($PYTHON --version)"
"$PYTHON" -m venv .venv
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet -r requirements.txt
echo "Done. Restart the dev server if it's running, then use 'Align words' on a song."
