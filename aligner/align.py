"""Works out when each word of a song's lyrics is sung, for the karaoke fill.

The app already knows when each line starts (from LRCLIB). This finds the words inside each line:

1. fetch:  download the song's audio from YouTube (YouTube Music's song search first, since that
           finds the album track), picking the result whose length matches Spotify's.
2. align:  separate the vocals with Demucs, line the audio up with Spotify's version, then place
           each word with the MMS forced aligner, searching only inside that line's time window.

The dev server (server/wordAlign.ts) runs this and reads its progress as JSON lines on stdout.
Every message is one JSON object with an "event" key: "progress", "done" or "error".
"""

import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time
import traceback
import unicodedata

# python.org builds of Python have no CA certificates; downloads need these.
try:
    import certifi

    os.environ.setdefault("SSL_CERT_FILE", certifi.where())
    os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())
except ImportError:
    pass

SAMPLE_RATE = 16000
# How far around a line's LRCLIB time to look for its words.
LEAD_MS = 600
TAIL_MS = 500
MAX_WINDOW_MS = 15000
# Resolution of the loudness curve used to line the audio up with Spotify's version.
ENVELOPE_FPS = 50


def emit(event, **data):
    print(json.dumps({"event": event, **data}), flush=True)


def progress(stage, message, pct=None):
    emit("progress", stage=stage, message=message, pct=pct)


# --- fetch -----------------------------------------------------------------------------------

BAD_WORDS = re.compile(
    r"\b(cover|slowed|sped ?up|nightcore|remix|live|instrumental|karaoke|8d|hours|acoustic|piano|reverb|"
    r"music ?box|off ?vocal|lyrics? ?only)\b",
    re.I,
)
# The same for Japanese titles (no word boundaries there): music box, karaoke, instrumental, cover,
# "I tried singing/playing it", piano, acoustic, remix, live.
BAD_WORDS_JA = re.compile(r"オルゴール|カラオケ|インスト|カバー|歌ってみた|弾いてみた|ピアノ|アコースティック|リミックス|ライブ")


def is_other_version(title, wanted):
    """A cover, karaoke track, music-box version and so on, unless that's what the song itself is called."""
    for pattern in (BAD_WORDS, BAD_WORDS_JA):
        if pattern.search(title) and not pattern.search(wanted):
            return True
    return False


def fetch(args):
    import yt_dlp

    target = args.duration_ms / 1000
    quiet = {"quiet": True, "no_warnings": True, "skip_download": True}

    def candidates(url):
        with yt_dlp.YoutubeDL({**quiet, "extract_flat": True}) as ydl:
            info = ydl.extract_info(url, download=False)
        return [e for e in (info.get("entries") or []) if e]

    def details(video_id):
        with yt_dlp.YoutubeDL(quiet) as ydl:
            return ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)

    query = f"{args.artist} {args.title}"
    searches = [
        ("YouTube Music", f"https://music.youtube.com/search?q={query}#songs", 4),
        ("YouTube", f"ytsearch10:{query} audio", 10),
    ]
    for name, url, limit in searches:
        progress("fetch", f"Searching {name} for the song")
        try:
            entries = candidates(url)[:limit]
        except Exception as e:  # noqa: BLE001 - a failed search just moves on to the next one
            progress("fetch", f"The {name} search failed ({e})")
            continue
        for entry in entries:
            title = entry.get("title") or ""
            if title and is_other_version(title, args.title):
                continue
            # Flat search results don't always have a length; the video's page does.
            duration = entry.get("duration")
            if duration is not None and abs(duration - target) > args.tolerance:
                continue
            try:
                info = details(entry["id"])
            except yt_dlp.utils.DownloadError as e:
                # Unavailable here (blocked, private, removed): try the next one.
                progress("fetch", f"Skipping {title or entry['id']}: {short_error(e)}")
                continue
            if is_other_version(info.get("title") or "", args.title):
                continue
            if info.get("duration") is None or abs(info["duration"] - target) > args.tolerance:
                continue
            try:
                download(info["webpage_url"], args.out)
                return 0
            except yt_dlp.utils.DownloadError as e:
                progress("fetch", f"Couldn't download {info.get('title')}: {short_error(e)}. Trying the next match")
    emit(
        "error",
        kind="no_match",
        message=f"Couldn't find a YouTube upload of this song within {args.tolerance:.0f}s of Spotify's length. "
        "Paste a YouTube link or upload a file instead.",
    )
    return 1


def short_error(e):
    return str(e).replace("ERROR: ", "").split("\n")[0][:160]


def download(url, out_base):
    import yt_dlp

    progress("fetch", "Downloading the audio")
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "format": "bestaudio/best",
        "outtmpl": out_base + ".%(ext)s",
    }
    # YouTube sometimes refuses a download link (HTTP 403). Asking again gets a fresh link, which
    # usually works.
    attempts = 3
    for attempt in range(1, attempts + 1):
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=True)
                path = ydl.prepare_filename(info)
            break
        except yt_dlp.utils.DownloadError as e:
            if attempt == attempts or "403" not in str(e):
                raise
            progress("fetch", f"YouTube refused the download (attempt {attempt} of {attempts}), trying again")
            time.sleep(2 * attempt)
    emit(
        "done",
        result={
            "path": path,
            "title": info.get("title"),
            "channel": info.get("channel") or info.get("uploader"),
            "url": info.get("webpage_url") or url,
            "durationMs": round((info.get("duration") or 0) * 1000),
        },
    )


def fetch_url(args):
    download(args.url, args.out)
    return 0


# --- align -----------------------------------------------------------------------------------


def decode(path, rate, channels):
    """Any audio file to float32 samples via ffmpeg, shaped (channels, samples)."""
    import numpy as np

    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", str(channels), "-ar", str(rate), "-"],
        check=True,
        capture_output=True,
    ).stdout
    return np.frombuffer(out, dtype=np.float32).reshape(-1, channels).T.copy()


def pick_device():
    import torch

    return "mps" if torch.backends.mps.is_available() else "cpu"


def separate_vocals(audio_path, cache_path):
    """Vocals only, 16kHz mono. Cached, since this is the slow part."""
    import numpy as np
    import torch
    import torchaudio
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    if cache_path and os.path.exists(cache_path):
        progress("separate", "Using the vocals separated last time")
        return np.load(cache_path)

    progress("separate", "Loading the vocal separation model")
    model = get_model("htdemucs")
    model.eval()
    wav = torch.from_numpy(decode(audio_path, model.samplerate, 2))
    ref = wav.mean(0)
    wav = (wav - ref.mean()) / ref.std()
    progress("separate", "Separating the vocals from the music (about a minute)")
    with torch.no_grad():
        try:
            sources = apply_model(model, wav[None], device=pick_device(), split=True, overlap=0.25, progress=False)[0]
        except Exception:  # noqa: BLE001 - some ops aren't on Apple's GPU yet
            sources = apply_model(model, wav[None], device="cpu", split=True, overlap=0.25, progress=False)[0]
    sources = sources * ref.std() + ref.mean()
    vocals = sources[model.sources.index("vocals")].mean(0)
    vocals = torchaudio.functional.resample(vocals, model.samplerate, SAMPLE_RATE).numpy().astype(np.float32)
    if cache_path:
        np.save(cache_path, vocals)
    return vocals


def find_offset(vocals, lines, spotify_ms):
    """
    How much later things happen in this audio file than in Spotify's version, in ms. Compares
    when there's singing (the vocals' loudness) with when the lyrics say there should be.
    """
    import numpy as np

    hop = SAMPLE_RATE // ENVELOPE_FPS
    frames = len(vocals) // hop
    rms = np.sqrt(np.mean(vocals[: frames * hop].reshape(frames, hop) ** 2, axis=1) + 1e-9)
    loud = np.log(rms)
    loud = (loud - loud.mean()) / (loud.std() + 1e-9)

    mask_len = max(frames, int(spotify_ms / 1000 * ENVELOPE_FPS) + 1)
    mask = np.zeros(mask_len, dtype=np.float32)
    for line in lines:
        a = int(line["startMs"] / 1000 * ENVELOPE_FPS)
        b = int(min(line["endMs"], line["startMs"] + 8000) / 1000 * ENVELOPE_FPS)
        mask[max(0, a) : max(0, b)] = 1
    mask = (mask - mask.mean()) / (mask.std() + 1e-9)

    file_ms = len(vocals) / SAMPLE_RATE * 1000
    max_lag = int((min(60000, abs(file_ms - spotify_ms) + 8000)) / 1000 * ENVELOPE_FPS)
    best, best_lag = -np.inf, 0
    for lag in range(-max_lag, max_lag + 1):
        # Audio frame t lines up with lyric frame t - lag.
        a0 = max(0, lag)
        a1 = min(frames, mask_len + lag)
        if a1 - a0 < ENVELOPE_FPS * 20:
            continue
        score = float(np.dot(loud[a0:a1], mask[a0 - lag : a1 - lag]) / (a1 - a0))
        if score > best:
            best, best_lag = score, lag
    return round(best_lag / ENVELOPE_FPS * 1000)


ALIGNABLE = re.compile(r"[^a-z']")


def normalise(word):
    """Letters the aligner knows: lowercase a-z and apostrophes, accents removed."""
    plain = unicodedata.normalize("NFKD", word).encode("ascii", "ignore").decode().lower()
    return ALIGNABLE.sub("", plain.replace("’", "'"))


def fill_gaps(words, start_ms, end_ms):
    """Words that couldn't be placed (numbers, symbols) get times between their neighbours."""
    n = len(words)
    i = 0
    while i < n:
        if words[i] is not None:
            i += 1
            continue
        j = i
        while j < n and words[j] is None:
            j += 1
        left = words[i - 1]["endMs"] if i > 0 else start_ms
        right = words[j]["startMs"] if j < n else end_ms
        step = max(0, right - left) / (j - i)
        for k in range(i, j):
            words[k] = {"startMs": round(left + step * (k - i)), "endMs": round(left + step * (k - i + 1))}
        i = j
    return words


def align(args):
    import numpy as np
    import torch
    import torchaudio

    request = json.load(sys.stdin)
    lines = request["lines"]
    vocals = separate_vocals(request["audio"], request.get("vocalsCache"))

    progress("offset", "Lining the audio up with Spotify's version")
    offset = find_offset(vocals, lines, request["spotifyDurationMs"])

    progress("align", "Loading the word aligner")
    bundle = torchaudio.pipelines.MMS_FA
    model = bundle.get_model(with_star=False)
    model.eval()
    tokenizer = bundle.get_tokenizer()
    aligner = bundle.get_aligner()

    results = {}
    residuals = []
    for n, line in enumerate(lines):
        if n % 5 == 0:
            progress("align", f"Placing the words: line {n + 1} of {len(lines)}", pct=round(n / len(lines) * 100))
        words = line["words"]
        clean = [normalise(w) for w in words]
        known = [i for i, w in enumerate(clean) if w]
        if not known:
            continue
        start = line["startMs"] + offset - LEAD_MS
        end = min(line["endMs"] + offset + TAIL_MS, line["startMs"] + offset + MAX_WINDOW_MS)
        a = max(0, int(start / 1000 * SAMPLE_RATE))
        b = min(len(vocals), int(end / 1000 * SAMPLE_RATE))
        if b - a < SAMPLE_RATE // 4:
            continue
        window = torch.from_numpy(np.ascontiguousarray(vocals[a:b]))[None]
        with torch.inference_mode():
            emission, _ = model(window)
        frame_ms = (b - a) / SAMPLE_RATE * 1000 / emission.size(1)
        try:
            spans = aligner(emission[0], tokenizer([clean[i] for i in known]))
        except Exception:  # noqa: BLE001 - more letters than audio frames, or similar
            continue
        placed = [None] * len(words)
        scores = []
        for i, word_spans in zip(known, spans):
            # Back to Spotify's timeline.
            s = a / SAMPLE_RATE * 1000 + word_spans[0].start * frame_ms - offset
            e = a / SAMPLE_RATE * 1000 + word_spans[-1].end * frame_ms - offset
            placed[i] = {"startMs": round(s), "endMs": round(e)}
            scores.extend(span.score for span in word_spans)
        placed = fill_gaps(placed, line["startMs"], line["endMs"])
        results[str(line["index"])] = {"words": placed, "score": round(float(np.mean(scores)), 3)}
        residuals.append(placed[0]["startMs"] - line["startMs"])

    emit(
        "done",
        result={
            "offsetMs": offset,
            "lines": results,
            # How far the first word sits from LRCLIB's line time, typically. Large values mean the
            # audio and the lyrics don't match well.
            "medianLineShiftMs": round(float(np.median(residuals))) if residuals else None,
        },
    )
    return 0


def exit_with_parent():
    """Stop if the dev server that started this goes away, rather than carrying on unread."""
    parent = os.getppid()

    def watch():
        while True:
            time.sleep(2)
            if os.getppid() != parent:
                os._exit(1)

    threading.Thread(target=watch, daemon=True).start()


def main():
    exit_with_parent()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    f = sub.add_parser("fetch", help="find and download the song's audio from YouTube")
    f.add_argument("--artist", required=True)
    f.add_argument("--title", required=True)
    f.add_argument("--duration-ms", type=int, required=True)
    f.add_argument("--tolerance", type=float, default=4, help="seconds of length difference allowed")
    f.add_argument("--out", required=True, help="output path without extension")

    u = sub.add_parser("fetch-url", help="download audio from a given YouTube link")
    u.add_argument("--url", required=True)
    u.add_argument("--out", required=True, help="output path without extension")

    sub.add_parser("align", help="read an alignment request as JSON on stdin")

    args = parser.parse_args()
    try:
        return {"fetch": fetch, "fetch-url": fetch_url, "align": align}[args.command](args)
    except Exception as e:  # noqa: BLE001 - reported to the app rather than crashing silently
        traceback.print_exc()
        emit("error", kind="failed", message=f"{type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
