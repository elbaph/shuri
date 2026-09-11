<div align="center">
  <br/>
  <img src="assets/shuri-banner.jpeg" width="400" alt="Shuri logo"/>
  <p><i>See synchronized Spotify lyrics inside VS Code while coding.</i></p>
<p>
  <a href="https://marketplace.visualstudio.com/items?itemName=o-p.shuri"><img src="https://img.shields.io/badge/VSCode-Extension-blue?style=flat&logo=visualstudiocode" /></a>
  <a href="https://open-vsx.org/extension/o-p/shuri">
  <img src="https://img.shields.io/badge/OpenVSX-Extension-7E3ACB?style=flat&logo=eclipseide&logoColor=white&label=openvsx"/></a>
  <a href="https://developer.spotify.com/documentation/web-api"><img src="https://img.shields.io/badge/Spotify-API-1DB954?style=flat&logo=spotify" /></a>
  <a href="https://lrclib.net"><img src="https://img.shields.io/badge/LRClib-Lyrics-000042?style=flat&logo=musicbrainz&logoColor=white"/></a>
  <a href="https://unlicense.org/"><img src="https://img.shields.io/badge/License-Unlicensed-red?style=flat" /></a>
</p>
</div>

> [!WARNING]
> Due to [Spotify API changes in February 2026](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide), **Spotify Premium is now required** to use this extension. Starting from February 11, 2026, Spotify requires Premium for app owners using Development Mode. Sorry for the inconvenience.

## ✨ Features

- 📌 **Live lyrics sync** with your Spotify playback.
- 🎨 Lyrics follow your VS Code color theme.
- 🖥️ Smooth **side panel view** – code on the left, lyrics on the right.
- 🖱️ **Click-to-seek** – click on any lyric line to jump to that moment in the track (like Spotify app).
- 🔑 Simple **one-time login** using your own Spotify Client ID.
- 🚪 Quick logout command to reset session.
- ⚡ Set a **maximum tracks cache size** for lyrics syncing.

## ⚡ Installation

1. Open **VS Code** → Extensions → search `Shuri` or [install from VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=o-p.shuri) or from [Open VSX Registry](https://open-vsx.org/extension/o-p/shuri).

2. Run the command:

```
Show Spotify Lyrics via Shuri
```

## 🔑 Authentication (one-time setup)

1. Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Create an app → copy **Client ID**.
3. **Important:** set the **Redirect URI** for your app to: `http://127.0.0.1:<port>/callback` (default: `5566`).
   You can change the port in settings (`shuri.port`) or via the command `Set Spotify OAuth Callback Port`.
4. Run the `Show Spotify Lyrics via Shuri` command.
5. Paste your **Client ID** in the panel and log in.
6. Enjoy synced lyrics while coding! 🎶

> ℹ️ Why? – To respect Spotify API rate limits, you need your own ID.

## ⌨️ Commands

- `Show Spotify Lyrics via Shuri` (`shuri.lyrics`) – open synced lyrics panel.
- `Logout from Shuri` (`shuri.logout`) – clear session and re-auth when needed.
- `Set Tracks Cache Max Size` (`shuri.tracksCacheMaxSize`) – configure the maximum number of tracks cached for lyrics.
- `Set Spotify OAuth Callback Port` (`shuri.port`) – set the local callback port used for Spotify OAuth.
- `Toggle Song Title` (`shuri.songTitle`) – toggle the song title in the lyrics panel.
- `Toggle Song Icon` (`shuri.songIcon`) – toggle the song icon in the lyrics panel.
- `Toggle Song Artists` (`shuri.songArtists`) – toggle the song artists in the lyrics panel.

## ⚙️ Tech stack

- [Spotify Web API](https://developer.spotify.com/documentation/web-api/)
- [LRClib](https://lrclib.net/) for lyrics with timing
- TypeScript + VS Code WebView

## 🛠️ Contributing

See the `Makefile` (`make help`) for the development workflow.

## 📜 License

This project is licensed as **Unlicensed**.
Feel free to use, hack, and remix it.

Forked from [therepanic/spotilyrics](https://github.com/therepanic/spotilyrics).
