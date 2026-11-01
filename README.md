# SongLearner

A small web app for learning song lyrics before karaoke. It plays the song from your Spotify account
in the browser tab, scrolls the lyrics in time, and lets you drill the song a section at a time.

## What it does

- Search Spotify and play any track right in the tab, or pull in whatever is already playing on
  your account. The top bar has play/pause for the current song on every page.
- Fetches timed lyrics from [LRCLIB](https://lrclib.net), a free community lyrics database. The
  current line is highlighted and the view follows along. Click any line to jump there.
- Splits the lyrics into sections automatically (from stanza breaks and instrumental gaps) and
  marks parts that repeat with the same letter, so the song's shape is easy to see. You can rename
  sections, move the splits, and merge a run of sections into one bigger section to learn in
  larger chunks (and split it back later).
- **Loop** a section or a run of sections, with a short run-up before it and an optional pause
  between repeats.
- Each section remembers **how many times it loops**. While "Loop sections as you play" is on, a
  section set above 1× repeats that many times when the song reaches it, then the song plays on.
  Turn the setting off for a full run-through; the counts are kept for next time.
- **Build up** drills a run of sections cumulatively: A, then A+B, then A+B+C. Optionally each new
  section is practised alone before it's joined on.
- **Memorise** mode shows only the first letter of each word, or hides the words completely. Hold
  `H` to peek.
- **Fade** is a memorise setting for looping. The first time round you see every word, then each
  loop hides more of every word, from the end backwards, until it's all gone. "Fade over" sets how
  many loops that takes. In a build-up, the sections you've sung most fade first.
- Rate each section (learning, almost, know it) to keep track of what still needs work.
- **Performance mode** is a full-screen view for singing the whole thing through.
- If LRCLIB only has untimed lyrics, or nothing at all, you can paste lyrics in and time them
  yourself by tapping Space at the start of each line while the song plays.
- A timing slider fixes lyrics that run slightly early or late.
- **Karaoke fill** (optional) fills in each word of the current line as it's sung. Click "Align
  words to the music" and the app finds the song on YouTube, separates the vocals and works out
  when each word starts. If it picked the wrong version, "Change audio" takes a YouTube link or an
  audio file and aligns again. Songs that haven't been aligned highlight whole lines as before.
  New songs are aligned automatically in the background the first time you open them (you can
  turn that off). Songs are aligned one at a time; others wait in a queue and can be cancelled.
  **Alignments** in the top bar shows every song's progress: what's aligning and queued, what
  finished or failed (with a step-by-step log for each), and which songs haven't been aligned yet,
  which you can queue from there with "Align all". The queue survives restarting the dev server.
  Needs a one-off setup (see below).
- **Edit words** lets you click any line and change its text, for typos or a spelling that's easier
  to sing from (say "o" instead of "wo"). The line keeps its timing. Re-downloading the lyrics
  throws your edits away.
- Japanese lyrics get romaji, either under each line or instead of it, so you can sing songs
  without reading kanji. It works out readings with [kuromoji](https://github.com/sglkc/kuromoji.js)
  and spells them out with [wanakana](https://wanakana.com). The dictionary (about 17MB) only
  downloads the first time a Japanese song is opened. Readings are usually right but not always,
  especially for names and unusual kanji.
- Songs often give a word a special reading that only appears as small kana in the official
  lyrics (瞬間 sung as "toki" rather than "shunkan"). Words that commonly get one are underlined,
  and "Fix a reading" lets you click any romaji word and say how it's sung, for that song.
- When a Japanese song is opened for the first time, Claude checks how it's sung (it can look the
  song up on lyric sites that show readings) and applies the changes it's confident about. You
  can switch each one off. This needs an Anthropic API key (see Setup) and runs once per song.
- **Karaoke set**: an automatic playlist (inside the app, not on Spotify) of every song you've
  fully learned. A song joins once all its sections are learned and leaves if one is marked not
  learned. Songs play back to back with the words blurred; sections you sing through without
  pausing, skipping or peeking count, and each song's score is saved. Songs with slips can be sent
  back to learning in one click.
- **Playlists**: the + on a song card adds it to a playlist (or starts a new one). Each playlist
  has its own page where you can reorder songs, then play through them with the lyrics showing,
  or test yourself on them with the words hidden and a score at the end.
- **Test mode** (`T`) blurs the words. A section you sing from start to end without pausing,
  skipping or peeking is marked learned and folds away, so you can see what's left and start
  from the first section you don't know yet.

Everything you set up (the songs you're learning, lyrics and your edits to them, sections,
ratings, reading fixes, timing tweaks, settings) is saved on disk in `data/` by the dev server.
Deleting a song from the home page deletes everything saved for it.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| Space | Play or pause |
| ← / → | Back or forward 5 seconds |
| ↑ / ↓ | Previous or next line |
| L | Loop the selected sections, or the section being sung |
| Esc | Stop looping |
| F | Performance mode |
| T | Test mode |
| H (hold) | Peek at hidden words |
| [ / ] | Show lyrics later or earlier by 0.1s |

Click a section to select it and shift-click another to select a run.

## Setup

You need **Spotify Premium** (full Premium, not Lite or Mini). The in-browser player won't work
without it, and since February 2026 Spotify also requires the owner of a developer app to have it.

1. Go to the [Spotify developer dashboard](https://developer.spotify.com/dashboard) and create an
   app.
2. Under "Which API/SDKs are you planning to use?", tick **Web API** and **Web Playback SDK**.
3. Add the redirect URI `http://127.0.0.1:5173/callback`. It has to be `127.0.0.1`: Spotify no
   longer accepts `localhost`.
4. Copy the app's **Client ID** into `.env.local` (see `.env.local.example`):

   ```
   VITE_SPOTIFY_CLIENT_ID=your-client-id
   ```

   No client secret is needed. The app logs in with PKCE, entirely in the browser.
5. Install and run:

   ```
   npm install
   npm run dev
   ```

6. Open http://127.0.0.1:5173 and log in.

Optional: to have Claude check how Japanese songs are sung, add an Anthropic API key to
`.env.local` and restart the dev server:

```
ANTHROPIC_API_KEY=sk-ant-...
```

The key stays on the dev server (`server/readingReview.ts`) and is never sent to the browser.
Each check is one Claude Opus 5.5 request with a few web searches, run once per Japanese song.
If Claude declines a request, the API retries it on a fallback model automatically.

Optional: the karaoke fill needs Python 3.10 to 3.13, ffmpeg and Deno (`brew install ffmpeg deno`;
yt-dlp needs Deno to download from YouTube). Install its Python side once, then restart the dev
server:

```
npm run aligner:setup
```

This puts PyTorch, [Demucs](https://github.com/facebookresearch/demucs) (vocal separation) and
yt-dlp in `aligner/.venv`. The first alignment ever also downloads about 1.3GB of models into
`~/.cache/torch`, which are kept and reused. After that a song takes about two minutes, or under
a minute to align again. Spotify's stream is encrypted, so the audio comes from YouTube or a file
you upload. Downloading from YouTube is against its terms, so use it for personal practice only.

A development-mode Spotify app allows up to 5 users. To let a friend use it, add their Spotify
email under User Management in the dashboard.

## Development

```
npm run dev      # dev server on http://127.0.0.1:5173
npm test         # unit tests (Vitest)
npm run lint     # oxlint
npm run build    # type-check and production build
```

The code is split by concern:

- `src/spotify/`: login (PKCE), the Web API calls, and the Web Playback SDK wrapper.
- `src/lyrics/`: the LRC parser, the LRCLIB client, section detection, and romaji.
- `server/readingReview.ts`: the dev-server endpoint that asks Claude to check Japanese readings.
- `server/diskStore.ts`: the dev-server endpoint that saves your data under `data/`.
- `server/wordAlign.ts` and `aligner/align.py`: the karaoke fill. The server runs the Python
  script, which downloads the audio, separates the vocals, lines the audio up with Spotify's
  version and then places each word with the
  [MMS forced aligner](https://pytorch.org/audio/2.8/tutorials/ctc_forced_alignment_api_tutorial.html),
  searching only inside each line's time window.
- `server/logSink.ts`: the dev-server endpoint that writes diagnostic logs under `logs/`.
- `scripts/copy-kuromoji-dict.mjs`: copies the Japanese dictionary into `public/` before
  `dev` and `build` (it isn't committed).
- `src/playback/`: the playback clock (smooths position between SDK updates) and the loop
  controller, which decides when to jump back during practice.
- `src/practice/`: memorise-mode masking and local storage.
- `src/components/`: the React UI.

## Your data

The dev server keeps everything in plain JSON files under `data/` (not committed):

- `data/library.json`: the songs on your home page
- `data/settings.json`: app settings
- `data/playlists.json`: your playlists
- `data/songs/<trackId>.json`: one file per song, with its lyrics (including lines you've added)
  and your progress, sections and reading fixes
- `data/audio/`: audio for songs you've aligned for the karaoke fill, with the separated vocals
  and the result of the last alignment. Deleted along with the song.
- `data/backups/`: before a file is overwritten or deleted, a timestamped copy is kept here (at
  most one an hour per file)

Files are written to a temporary file and then renamed, so a crash can't leave one half-written.
The browser also keeps a copy as a fallback: if the dev server isn't running, changes are saved
there and copied to disk the next time it is. The top bar shows whether everything is saved to
disk. Only the Spotify login stays in the browser.

## Logs

While the dev server is running, the app logs nearly everything it does to `logs/<date>.jsonl`
(one JSON object per line): player events and seeks (with what asked for them), Spotify and
LRCLIB requests, loops, test-mode attempts and why they were cancelled, setting changes, errors,
hot reloads, and a heartbeat every 5 seconds with the playback state. Tokens, keys and lyric text
are never logged. The folder isn't committed.

```
npm run logs                     # timeline of the latest browser session
npm run logs -- --sessions       # today's sessions
npm run logs -- --session ab12cd # one session
npm run logs -- --scope test,player --level info
```

In the browser console, `songlearnerLogs` holds the last 5000 entries.

## Limitations

- Laptop browsers only for now. Spotify's Web Playback SDK doesn't run in mobile browsers.
- Spotify doesn't offer lyrics through its API, so coverage depends on LRCLIB. Popular songs are
  usually there; obscure ones may need pasting and timing by hand.
- Spotify can't slow songs down or remove vocals, so neither is available here.
- This is a personal tool. Spotify's developer terms don't allow building a public product that
  syncs its audio with other content.
