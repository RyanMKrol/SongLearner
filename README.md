# SongLearner

A small web app for learning song lyrics before karaoke. It plays the song from your Spotify account
in the browser tab, scrolls the lyrics in time, and lets you drill the song a section at a time.

## What it does

- Search Spotify and play any track right in the tab, or pull in whatever is already playing on
  your account.
- Fetches timed lyrics from [LRCLIB](https://lrclib.net), a free community lyrics database. The
  current line is highlighted and the view follows along. Click any line to jump there.
- Splits the lyrics into sections automatically (from stanza breaks and instrumental gaps) and
  marks parts that repeat with the same letter, so the song's shape is easy to see. You can rename
  sections and move the splits.
- **Loop** a section or a run of sections, with a short run-up before it and an optional pause
  between repeats.
- **Build up** drills a run of sections cumulatively: A, then A+B, then A+B+C. Optionally each new
  section is practised alone before it's joined on.
- **Memorise** mode shows only the first letter of each word, or hides the words completely. Hold
  `H` to peek.
- Rate each section (learning, almost, know it) to keep track of what still needs work.
- **Performance mode** is a full-screen view for singing the whole thing through.
- If LRCLIB only has untimed lyrics, or nothing at all, you can paste lyrics in and time them
  yourself by tapping Space at the start of each line while the song plays.
- A timing slider fixes lyrics that run slightly early or late.

Everything you set up (sections, ratings, timing tweaks, lyrics) is saved in your browser's local
storage.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| Space | Play or pause |
| ← / → | Back or forward 5 seconds |
| ↑ / ↓ | Previous or next line |
| L | Loop the selected sections, or the section being sung |
| Esc | Stop looping |
| F | Performance mode |
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
- `src/lyrics/`: the LRC parser, the LRCLIB client, and section detection.
- `src/playback/`: the playback clock (smooths position between SDK updates) and the loop
  controller, which decides when to jump back during practice.
- `src/practice/`: memorise-mode masking and local storage.
- `src/components/`: the React UI.

## Limitations

- Laptop browsers only for now. Spotify's Web Playback SDK doesn't run in mobile browsers.
- Spotify doesn't offer lyrics through its API, so coverage depends on LRCLIB. Popular songs are
  usually there; obscure ones may need pasting and timing by hand.
- Spotify can't slow songs down or remove vocals, so neither is available here.
- This is a personal tool. Spotify's developer terms don't allow building a public product that
  syncs its audio with other content.
