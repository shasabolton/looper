# Looper

A one-button browser audio looper built with vanilla JavaScript. It is a static client-side app, so it can run directly from GitHub Pages.

## Controls

- First tap when empty: start recording.
- Next tap while recording: stop recording and start loop playback.
- Tap while playing: start an overdub.
- Tap while overdubbing: keep the overdub and return to playback.
- Hold: undo the latest layer. Holding while recording cancels that take.
- Double tap while playing: stop playback.
- Tap while stopped with a saved loop: start playback.

The full screen is the button and status light:

- Red: recording or overdubbing.
- Green: playing.
- Black: stopped.

Use headphones for clean overdubs. Browser microphone access requires HTTPS, which GitHub Pages provides, or `localhost` during development.

## Run locally

From this folder:

```sh
python3 -m http.server 43123 --bind 127.0.0.1
```

Then open `http://127.0.0.1:43123`.

## Deploy on GitHub Pages

The included workflow deploys the static site whenever `main` is pushed. In a new GitHub repository, open **Settings -> Pages** and choose **GitHub Actions** as the source if GitHub does not select it automatically.
