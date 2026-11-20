# Kira Mobile App

A phone app for Kira. Kira herself still runs in Termux; the app is a chat window
into her (chat with streaming replies, a **mind** tab with her thoughts and mood,
and **settings** for model / API key).

```
 ┌────────────── your phone ──────────────┐
 │  Kira app  ──HTTP──▶  kira serve (Termux) ──▶ your LLM API
 └────────────────────────────────────────┘
```

## 1. Start the server in Termux

```bash
cd ~/droidclaw && git pull && kira serve
```

It prints something like:

```
open:  http://127.0.0.1:7071/#token=AbC123...
token: AbC123...
```

Keep Termux running (tip: `termux-wake-lock` so Android doesn't kill it).

## 2. Open the app — pick one

**A. Install the APK** — download `kira-debug-apk` from the repo's
*Actions → Build Kira Android APK* run (or build it yourself, below), install it,
then in **settings** enter server URL `http://127.0.0.1:7071` and the token.

**B. No install (PWA)** — open the `open:` link in Chrome, then
menu ⋮ → *Add to Home screen*. The token is filled in automatically.

## Using it from another device

`kira serve --lan` listens on your Wi-Fi too and prints the LAN address.
Only do this on a network you trust — anyone with the token can talk to Kira,
and Kira can control your phone.

## Build the APK yourself

Needs Node 18+, JDK 17 and the Android SDK (`ANDROID_HOME` or `android/local.properties`).

```bash
cd mobile
npm install
npm run android:build
# → android/app/build/outputs/apk/debug/app-debug.apk
```

The UI lives in `www/` (plain HTML/CSS/JS, no build step). After editing it,
run `npx cap sync android` before rebuilding.

## API (served by `src/server.js`)

All routes except `/api/health` need `Authorization: Bearer <token>`.

| Route | |
|---|---|
| `GET /api/health` | liveness |
| `GET /api/status` | model, user, mind stats |
| `GET /api/thoughts` | mood, daemon thoughts, observations |
| `GET /api/history` | recent conversation |
| `POST /api/chat` `{message}` | streams NDJSON: `thinking`, `token`, `tool_start`, `tool`, `done`, `error` |
| `POST /api/abort` | stop the current reply |
| `POST /api/clear` | clear short-term history |
| `POST /api/config` `{name, baseUrl, model, apiKey}` | update settings |
