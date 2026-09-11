import * as crypto from 'crypto'
import * as http from 'http'
import { IncomingMessage } from 'node:http'
import path from 'node:path'
import { clearTimeout } from 'node:timers'

import LRUCache from 'lru-cache'
import TreeMap from 'ts-treemap'
import * as vscode from 'vscode'
import { WebviewPanel, WebviewView } from 'vscode'

import { LyricsEntry } from './LyricsEntry'
import { SpotifyAuthState } from './SpotifyAuthState'
import { SpotifyCurrentPlayingState } from './SpotifyCurrentPlayingState'
import { SpotifyPreAuthState } from './SpotifyPreAuthState'
import { SpotifyAuthError, SpotifyRateLimitError, SpotifyWebApi } from './api/SpotifyWebApi'
import { LRCLibLyricsProvider } from './provider/LRCLibLyricsProvider'
import { LyricsProvider } from './provider/LyricsProvider'

let panel: WebviewPanel | undefined
let sidebarView: WebviewView | undefined

let preAuthState: SpotifyPreAuthState | null
let authState: SpotifyAuthState | null
let currentPlayingState: SpotifyCurrentPlayingState | undefined
let tracksCache: LRUCache<string, SpotifyCurrentPlayingState>

let server: http.Server | null
let pollingTimeout: NodeJS.Timeout | null
let pollingActive = false
let consecutivePollErrors = 0
let hasVisibleSyncIssue = false

const provider: LyricsProvider = new LRCLibLyricsProvider()

const BASE_POLL_INTERVAL_MS = 300
const MAX_POLL_INTERVAL_MS = 10_000

function nextPollDelay(): number {
  if (consecutivePollErrors === 0) {
    return BASE_POLL_INTERVAL_MS
  }
  return Math.min(BASE_POLL_INTERVAL_MS * 2 ** consecutivePollErrors, MAX_POLL_INTERVAL_MS)
}

class LyricsViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveWebviewView(webviewView: vscode.WebviewView) {
    sidebarView = webviewView
    webviewView.title = 'Gunko'
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    }
    webviewView.webview.onDidReceiveMessage((message) =>
      handleWebviewMessage(this.context, message)
    )
    webviewView.onDidChangeVisibility(async () => {
      if (webviewView.visible) {
        await printFrame(this.context)
        await sendCurrentLyrics()
        if (authState) {
          startPollingLoop(this.context)
        }
      } else {
        updateSidebarTitle()
        if (!isAnySurfaceVisible()) {
          pausePollingLoop()
        }
      }
    })
    webviewView.onDidDispose(() => {
      sidebarView = undefined
    })

    if (!authState) {
      await authorize(this.context)
      if (!authState) {
        await createServer(this.context)
      }
    }
    await printFrame(this.context)
  }
}

function createTracksCache(maxSize?: number): LRUCache<string, SpotifyCurrentPlayingState> {
  const size =
    maxSize ?? (Number(vscode.workspace.getConfiguration('shuri').get('tracksCacheMaxSize')) || 10)
  return new LRUCache({ maxSize: size, sizeCalculation: () => 1 })
}

export async function activate(context: vscode.ExtensionContext) {
  // Must exist before any surface (panel or sidebar) can poll for lyrics —
  // previously this was only created inside the shuri.lyrics command
  // handler, so sidebar-only usage hit tracksCache.get() on undefined.
  tracksCache = createTracksCache()

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('shuri.lyricsView', new LyricsViewProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
    })
  )
  context.subscriptions.push(
    vscode.commands.registerCommand('shuri.lyrics', async () => {
      if (panel) {
        panel.reveal(vscode.ViewColumn.Two)
        return
      } else {
        panel = vscode.window.createWebviewPanel(
          'lyrics',
          'Spotify Lyrics',
          vscode.ViewColumn.Two,
          {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
          }
        )
        panel.iconPath = vscode.Uri.file(path.join(context.extensionPath, 'assets/icon.png'))
      }
      await authorize(context)
      if (!authState) {
        await createServer(context)
      }
      await printFrame(context)

      panel.webview.onDidReceiveMessage((message) => handleWebviewMessage(context, message))
      panel.onDidChangeViewState(async (e) => {
        if (e.webviewPanel.visible) {
          if (authState) {
            await printFrame(context)
            await sendCurrentLyrics()
            startPollingLoop(context)
          }
        } else if (!isAnySurfaceVisible()) {
          pausePollingLoop()
        }
      })
      panel.onDidDispose(() => {
        panel = undefined
        if (!isAnySurfaceVisible()) {
          pausePollingLoop()
        }
      })
    })
  )
  context.subscriptions.push(
    vscode.commands.registerCommand('shuri.logout', async () => {
      await resetAuth(context)
    })
  )
  context.subscriptions.push(
    vscode.commands.registerCommand('shuri.tracksCacheMaxSize', async () => {
      const MIN = 1,
        MAX = Number.MAX_SAFE_INTEGER,
        DEFAULT = 10
      const input = await vscode.window.showInputBox({
        prompt: `Maximum tracks cache size. Enter an integer ${MIN}–${MAX}`,
        value: String(DEFAULT),
        validateInput: (v) => {
          if (!/^\d+$/.test(v)) {
            return 'Please enter an integer'
          }
          const n = Number(v)
          if (n < MIN) {
            return `Minimum is ${MIN}`
          }
          if (n > MAX) {
            return `Maximum is ${MAX}`
          }
          return null
        },
        ignoreFocusOut: true,
      })
      if (!input) {
        return
      }
      const value = Math.max(MIN, Math.min(MAX, parseInt(input, 10)))
      await vscode.workspace
        .getConfiguration('shuri')
        .update('tracksCacheMaxSize', value, vscode.ConfigurationTarget.Global)
      vscode.window.showInformationMessage(`Maximum tracks cache size set to ${value}`)
      tracksCache = createTracksCache(value)
    })
  )
  context.subscriptions.push(
    vscode.commands.registerCommand('shuri.port', async () => {
      const MIN = 1024,
        MAX = 65535,
        DEFAULT = 5566
      const config = vscode.workspace.getConfiguration('shuri')
      const input = await vscode.window.showInputBox({
        prompt: `Port used for the Spotify OAuth callback. Enter an integer ${MIN}–${MAX}`,
        value: String(config.get<number>('port') ?? DEFAULT),
        validateInput: (v) => {
          if (!/^\d+$/.test(v)) {
            return 'Please enter an integer'
          }
          const n = Number(v)
          if (n < MIN) {
            return `Minimum is ${MIN}`
          }
          if (n > MAX) {
            return `Maximum is ${MAX}`
          }
          return null
        },
        ignoreFocusOut: true,
      })
      if (!input) {
        return
      }
      const value = Math.max(MIN, Math.min(MAX, parseInt(input, 10)))
      await config.update('port', value, vscode.ConfigurationTarget.Global)
      vscode.window.showInformationMessage(`Spotify OAuth callback port set to ${value}`)
      if (!authState) {
        await authorize(context)
      }
      if (authState) {
        await printFrame(context)
        return
      }
      if (!hasActiveWebview()) {
        return
      }
      if (!server && !preAuthState) {
        return
      }
      if (server) {
        server.close()
        server = null
      }
      await createServer(context)
      await printFrame(context)
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('shuri.songTitle', async () => {
      const config = vscode.workspace.getConfiguration('shuri')
      const value = !config.get('songTitle')
      await config.update('songTitle', value, vscode.ConfigurationTarget.Global)
      vscode.window.showInformationMessage(`Song title has been ${value ? 'hidden' : 'shown'}`)
    })
  )
  context.subscriptions.push(
    vscode.commands.registerCommand('shuri.songIcon', async () => {
      const config = vscode.workspace.getConfiguration('shuri')
      const value = !config.get('songIcon')
      await config.update('songIcon', value, vscode.ConfigurationTarget.Global)
      vscode.window.showInformationMessage(`Song icon has been ${value ? 'hidden' : 'shown'}`)
    })
  )
  context.subscriptions.push(
    vscode.commands.registerCommand('shuri.songArtists', async () => {
      const config = vscode.workspace.getConfiguration('shuri')
      const value = !config.get('songArtists')
      await config.update('songArtists', value, vscode.ConfigurationTarget.Global)
      vscode.window.showInformationMessage(`Song artists has been ${value ? 'hidden' : 'shown'}`)
    })
  )
}

export async function deactivate() {
  pollingActive = false
  if (pollingTimeout) {
    clearTimeout(pollingTimeout)
    pollingTimeout = null
  }
  if (server) {
    server.close()
    server = null
  }
  authState = null
  preAuthState = null
  currentPlayingState = undefined
  consecutivePollErrors = 0
  hasVisibleSyncIssue = false
  broadcast({ command: 'syncError', message: null })
}

async function resetAuth(context: vscode.ExtensionContext) {
  context.secrets.delete('clientId')
  context.secrets.delete('accessToken')
  context.secrets.delete('refreshToken')
  context.secrets.delete('expiresIn')
  await deactivate()
  if (hasActiveWebview()) {
    await createServer(context)
    await printFrame(context)
    if (panel) {
      panel.title = 'Spotify Lyrics'
      panel.iconPath = vscode.Uri.file(path.join(context.extensionPath, 'assets/icon.png'))
    }
  }
}

type SurfaceKind = 'panel' | 'sidebar'

function activeSurfaces(): { webview: vscode.Webview; kind: SurfaceKind }[] {
  const surfaces: { webview: vscode.Webview; kind: SurfaceKind }[] = []
  if (panel) {
    surfaces.push({ webview: panel.webview, kind: 'panel' })
  }
  if (sidebarView) {
    surfaces.push({ webview: sidebarView.webview, kind: 'sidebar' })
  }
  return surfaces
}

function activeWebviews(): vscode.Webview[] {
  return activeSurfaces().map((surface) => surface.webview)
}

function isAnySurfaceVisible(): boolean {
  return Boolean(panel?.visible) || Boolean(sidebarView?.visible)
}

function hasActiveWebview(): boolean {
  return Boolean(panel || sidebarView)
}

async function handleWebviewMessage(context: vscode.ExtensionContext, message: any) {
  if (message.command === 'seekToPosition') {
    const timeMs = message.timeMs
    if (authState) {
      await SpotifyWebApi.seekToPosition(authState.accessToken, timeMs)
    }
  } else if (message.command === 'signInClicked') {
    const clientId = message.message

    const codeVerifier = generateCodeVerifier()
    const sha256 = crypto.createHash('sha256').update(codeVerifier).digest()
    const codeChallenge = sha256
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    preAuthState = new SpotifyPreAuthState(
      clientId,
      codeVerifier,
      codeChallenge,
      'authorization_code',
      `http://127.0.0.1:${vscode.workspace.getConfiguration('shuri').get('port')}/callback`
    )

    vscode.env.openExternal(
      vscode.Uri.parse(
        await SpotifyWebApi.getAuthUrl(
          vscode.workspace.getConfiguration('shuri').get('port')!,
          clientId,
          codeChallenge
        )
      )
    )
  } else if (message.command === 'ready') {
    // The webview's script only just attached its message listener, so any
    // postMessage broadcast sent before this point may have been dropped.
    // Resend whatever we already know so it doesn't wait for the next poll.
    await sendCurrentLyrics()
  }
}

async function renderWebview(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  kind: SurfaceKind
) {
  let htmlName
  let cssName
  let scriptName
  if (!authState) {
    htmlName = 'signInTemplate.html'
    cssName = './styles/signInStyle.css'
    scriptName = './scripts/signInScript.js'
  } else if (kind === 'sidebar') {
    htmlName = 'lyricsViewTemplate.html'
    cssName = './styles/lyricsViewStyle.css'
    scriptName = './scripts/lyricsViewScript.js'
  } else {
    htmlName = 'lyricsTemplate.html'
    cssName = './styles/lyricsStyle.css'
    scriptName = './scripts/lyricsScript.js'
  }
  const html = (
    await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, 'media', htmlName))
  ).toString()
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', cssName))
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'media', scriptName)
  )
  const port = vscode.workspace.getConfiguration('shuri').get<number>('port') ?? 8000
  webview.html = html
    .replace('{{PORT}}', String(port))
    .replace('styles.css', cssUri.toString())
    .replace('script.js', scriptUri.toString())
}

async function printFrame(context: vscode.ExtensionContext) {
  for (const { webview, kind } of activeSurfaces()) {
    await renderWebview(context, webview, kind)
  }
}

function generateCodeVerifier(length = 49) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  let verifier = ''
  for (let i = 0; i < length; i++) {
    verifier += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return verifier
}

async function createServer(context: vscode.ExtensionContext) {
  server = http.createServer(async (req: IncomingMessage, res: InstanceType<any>) => {
    const rawUrl = req.url ?? '/'
    const parsedUrl = new URL(rawUrl, 'http://localhost')

    if (parsedUrl.pathname === '/callback') {
      const code = parsedUrl.searchParams.get('code')

      if (code && preAuthState) {
        try {
          const response = await SpotifyWebApi.getToken(
            preAuthState.clientId,
            preAuthState.codeVerifier,
            preAuthState.redirectUri,
            code,
            preAuthState.grantType
          )

          const expiresIn = Date.now() + response.expires_in * 1000

          context.secrets.store('clientId', preAuthState.clientId)
          context.secrets.store('accessToken', response.access_token)
          context.secrets.store('refreshToken', response.refresh_token)
          context.secrets.store('expiresIn', String(expiresIn))

          authState = new SpotifyAuthState(
            preAuthState.clientId,
            response.access_token,
            response.refresh_token,
            expiresIn
          )
          preAuthState = null

          await printFrame(context)

          startPollingLoop(context)

          vscode.window.showInformationMessage(`You have successfully signed in`)

          res.statusCode = 200
          res.setHeader('Content-Type', 'text/plain')
          res.end('Authorization code received! You can close this page.')

          if (server) {
            server.close()
            server = null
          }
        } catch (err) {
          console.error(`Sign-in failed: ${err}`)
          vscode.window.showErrorMessage(`Sign-in failed: ${err}`)
          res.statusCode = 502
          res.setHeader('Content-Type', 'text/plain')
          res.end('Sign-in failed. You can close this page and try again.')
        }
      } else {
        res.statusCode = 400
        res.setHeader('Content-Type', 'text/plain')
        res.end('Missing code query parameter')
      }
    } else {
      res.statusCode = 404
      res.setHeader('Content-Type', 'text/plain')
      res.end('Not Found')
    }
  })
  server.listen(vscode.workspace.getConfiguration('shuri').get('port'))
}

async function pollSpotifyStat(context: vscode.ExtensionContext) {
  try {
    if (authState) {
      if (authState.expiresIn <= Date.now()) {
        const response = await SpotifyWebApi.refreshToken(
          authState.refreshToken,
          authState.clientId
        )

        // Spotify does not always rotate the refresh token; keep the
        // old one when no new one comes back instead of clobbering it.
        const refreshToken = response.refresh_token ?? authState.refreshToken
        const expiresIn = Date.now() + response.expires_in * 1000

        context.secrets.store('accessToken', response.access_token)
        context.secrets.store('refreshToken', refreshToken)
        context.secrets.store('expiresIn', String(expiresIn))

        authState.refreshToken = refreshToken
        authState.accessToken = response.access_token
        authState.expiresIn = expiresIn
      }
      await updateLyrics(context)
    }
    if (hasVisibleSyncIssue) {
      broadcast({ command: 'syncError', message: null })
      hasVisibleSyncIssue = false
    }
    consecutivePollErrors = 0
  } catch (err) {
    console.error(`pollSpotifyStat error: ${err}`)
    if (err instanceof SpotifyAuthError) {
      consecutivePollErrors = 0
      await resetAuth(context)
      vscode.window.showWarningMessage('Your Spotify session has expired. Please sign in again.')
    } else if (err instanceof SpotifyRateLimitError) {
      consecutivePollErrors = 0
      const seconds = Math.round(err.retryAfterMs / 1000)
      const resumeAt = formatLocalDateTime(new Date(Date.now() + err.retryAfterMs))
      broadcast({
        command: 'syncError',
        message: `Spotify API rate limit reached — resuming at ${resumeAt} (in ${seconds}s).`,
      })
      hasVisibleSyncIssue = true
      dropCurrentHighlight()
      pauseAndResumeAfter(context, err.retryAfterMs)
    } else {
      consecutivePollErrors++
      broadcast({ command: 'syncError', message: String(err) })
      hasVisibleSyncIssue = true
      dropCurrentHighlight()
    }
  }
}

// "YYYY-MM-DD HH:mm:ss" in the user's local time zone. Deliberately not
// using toLocaleString() — that varies by locale, and the raw retry-after
// second count alone is hard to reason about, so we want one consistent,
// unambiguous format regardless of the user's OS locale settings.
function formatLocalDateTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const year = date.getFullYear()
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())
  const hours = pad(date.getHours())
  const minutes = pad(date.getMinutes())
  const seconds = pad(date.getSeconds())
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

function truncateTitle(title: string, maxLength: number = 40): string {
  if (title.length <= maxLength) {
    return title
  }
  return title.substring(0, maxLength - 3) + '...'
}

function updatePanelMeta(
  context: vscode.ExtensionContext,
  artistsNames: string,
  trackName: string,
  imageUrl: string
) {
  if (!panel) {
    return
  }

  const songTitle = vscode.workspace.getConfiguration('shuri').get('songTitle')
  const songArtists = vscode.workspace.getConfiguration('shuri').get('songArtists')
  const songIcon = vscode.workspace.getConfiguration('shuri').get('songIcon')

  let title: string
  if (songTitle && songArtists) {
    title = 'Spotify Lyrics'
  } else if (!songTitle && songArtists) {
    title = trackName
  } else if (songTitle && !songArtists) {
    title = artistsNames
  } else {
    title = `${artistsNames} - ${trackName}`
  }

  panel.title = truncateTitle(title)

  panel.iconPath = songIcon
    ? vscode.Uri.file(path.join(context.extensionPath, 'assets/icon.png'))
    : vscode.Uri.parse(imageUrl)
}

function updateSidebarTitle(trackName?: string) {
  if (!sidebarView) {
    return
  }
  sidebarView.title = trackName ? `Shuri: ${trackName}` : 'Shuri: Asleep'
}

function broadcast(message: Record<string, unknown>) {
  for (const webview of activeWebviews()) {
    webview.postMessage(message)
  }
}

// Drops the current-line highlight without touching what's displayed —
// used whenever a poll can't confirm a match (nothing playing this tick,
// lyrics lookup failed, an unexpected error) but we don't want to blank
// out lyrics that were already showing correctly a moment ago.
function dropCurrentHighlight() {
  if (!currentPlayingState) {
    return
  }
  broadcast({ command: 'pickLyrics', pick: -1 })
}

async function updateLyrics(context: vscode.ExtensionContext) {
  if (authState) {
    const currentlyPlayingResponse = await SpotifyWebApi.getCurrentlyPlaying(authState.accessToken)
    if (!currentlyPlayingResponse) {
      if (!currentPlayingState) {
        broadcast({ command: 'clearLyrics' })
        updateSidebarTitle()
      } else {
        // Could just be a brief pause, ad break, or device handoff rather
        // than actual playback stopping — don't wipe what's on screen.
        dropCurrentHighlight()
      }
      return
    }
    const trackId: string = currentlyPlayingResponse.item.id
    const trackName: string = currentlyPlayingResponse.item.name
    const albumName: string = currentlyPlayingResponse.item.album.name
    const artistsNames: string[] = currentlyPlayingResponse.item.artists.map(
      (artist) => artist.name
    )
    const albumImages = currentlyPlayingResponse.item.album.images
    const durationInMs: number = currentlyPlayingResponse.item.duration_ms
    const durationInS: number = Math.floor(durationInMs / 1000)
    const artists: string = artistsNames.join(', ')

    updatePanelMeta(context, artists, trackName, albumImages[albumImages.length - 1].url)
    updateSidebarTitle(trackName)

    // Prefer comparing Spotify's stable track id over name/artists text —
    // Spotify can reorder a multi-artist track's artist list between polls,
    // which would otherwise look like a track change and trigger a needless
    // (and possibly failing) lyrics re-fetch mid-song.
    const matchesCurrentTrack = (state: SpotifyCurrentPlayingState | undefined) =>
      Boolean(
        state &&
        (trackId && state.trackId
          ? state.trackId === trackId
          : state.authors === artists && state.name === trackName)
      )

    if (!matchesCurrentTrack(currentPlayingState)) {
      const trackCache: SpotifyCurrentPlayingState | undefined = tracksCache.get(
        makeTrackKey(trackName, artists)
      )
      if (trackCache) {
        currentPlayingState = trackCache
        postLyrics(trackCache)
      }
    }
    if (!matchesCurrentTrack(currentPlayingState)) {
      const lyricsResult = await provider.getLyrics(trackName, artists, albumName, durationInS)
      if (lyricsResult && !lyricsResult.instrumental) {
        const currentlyPlayingPoll = new SpotifyCurrentPlayingState(trackName, artists)
        currentlyPlayingPoll.trackId = trackId
        if (lyricsResult.plainLyrics) {
          const plainLyricsStrs: string[] = lyricsResult.plainLyrics
            .split(/\n/)
            .map((s) => s.trim())
            .filter((s) => s !== '')
            .map((line) => line + '\n')

          currentlyPlayingPoll.plainLyricsStrs = plainLyricsStrs
        }
        // load synchronized lyrics in treemap
        if (lyricsResult.syncedLyrics) {
          const synchronizedLyricsMap = new TreeMap<number, LyricsEntry>()
          const synchronizedLyricsStrs: string[] = lyricsResult.syncedLyrics
            .split(/(?=\[\d{2}:\d{2}\.\d{2}\])/)
            .filter((s) => s.trim() !== '')
          let id: number = 0
          for (const lyricsStr of synchronizedLyricsStrs) {
            const match = lyricsStr.match(/\[(\d{2}):(\d{2})\.(\d{2})\]\s*(.*)/)
            if (match) {
              const minutes = parseInt(match[1], 10)
              const seconds = parseInt(match[2], 10)
              const hundredths = parseInt(match[3], 10)
              const text = match[4]

              const timeMs = minutes * 60 * 1000 + seconds * 1000 + hundredths * 10

              synchronizedLyricsMap.set(timeMs, {
                id: id,
                text: text,
                timeMs: timeMs,
              })
              id++
            }
          }
          currentlyPlayingPoll.synchronizedLyricsMap = synchronizedLyricsMap
        }
        currentPlayingState = currentlyPlayingPoll
        tracksCache.set(
          makeTrackKey(currentPlayingState.name, currentPlayingState.authors),
          currentPlayingState
        )
        currentPlayingState.synchronizedLyricsStrs =
          buildSynchronizedLyricsStrs(currentPlayingState)
        postLyrics(currentPlayingState)
      } else if (!currentPlayingState) {
        // Nothing has ever matched yet this session — only now is it
        // correct to show the "no lyrics" placeholder.
        broadcast({ command: 'clearLyrics' })
      } else {
        // We already have lyrics on screen for a previous match. This one
        // poll failing to match (LRCLib miss, transient error, etc.)
        // shouldn't blank the view — just drop the current-line highlight
        // and keep showing what's there until a future poll matches again.
        // currentPlayingState is intentionally left untouched so the next
        // successful match can take over normally.
        dropCurrentHighlight()
      }
    } else if (currentPlayingState) {
      if (currentPlayingState.synchronizedLyricsMap) {
        const value = currentPlayingState.synchronizedLyricsMap.floorEntry(
          currentlyPlayingResponse.progress_ms
        )
        broadcast({ command: 'pickLyrics', pick: value ? value[1].id : -1 })
      }
    }
  }
}

function buildSynchronizedLyricsStrs(state: SpotifyCurrentPlayingState): object[] {
  const synchronizedLyricsStrs: object[] = []
  if (state.synchronizedLyricsMap) {
    for (const entry of state.synchronizedLyricsMap) {
      synchronizedLyricsStrs.push({
        id: entry[1].id,
        text: entry[1].text,
        timeMs: entry[0],
        pick: -1,
      })
    }
  }
  return synchronizedLyricsStrs
}

function postLyrics(state: SpotifyCurrentPlayingState) {
  broadcast({
    command: 'addLyrics',
    lyrics: state.synchronizedLyricsMap ? state.synchronizedLyricsStrs : state.plainLyricsStrs,
  })
}

async function sendCurrentLyrics() {
  if (!hasActiveWebview() || !currentPlayingState || !authState) {
    return
  }

  postLyrics(currentPlayingState)

  if (currentPlayingState.synchronizedLyricsMap) {
    const currentlyPlayingResponse = await SpotifyWebApi.getCurrentlyPlaying(authState.accessToken)
    if (currentlyPlayingResponse) {
      const value = currentPlayingState.synchronizedLyricsMap.floorEntry(
        currentlyPlayingResponse.progress_ms
      )
      broadcast({ command: 'pickLyrics', pick: value ? value[1].id : -1 })
    }
  }
}

function makeTrackKey(name: string, artists: string): string {
  return `${name}__${artists}`
}

async function authorize(context: vscode.ExtensionContext) {
  const clientId = await context.secrets.get('clientId')
  const accessToken = await context.secrets.get('accessToken')
  const refreshToken = await context.secrets.get('refreshToken')
  const expiresInStr = await context.secrets.get('expiresIn')

  if (clientId && accessToken && refreshToken && expiresInStr) {
    authState = new SpotifyAuthState(clientId, accessToken, refreshToken, Number(expiresInStr))

    startPollingLoop(context)
  }
}

function startPollingLoop(context: vscode.ExtensionContext) {
  if (pollingActive) {
    return
  }
  pollingActive = true
  const loop = async () => {
    try {
      await pollSpotifyStat(context)
    } finally {
      if (pollingActive) {
        pollingTimeout = setTimeout(loop, nextPollDelay())
      }
    }
  }
  loop()
}

// Stops scheduling further polls without touching auth/session state, so it
// can resume seamlessly via startPollingLoop() once something is visible
// again. Unlike deactivate(), this is meant to be temporary.
function pausePollingLoop() {
  pollingActive = false
  if (pollingTimeout) {
    clearTimeout(pollingTimeout)
    pollingTimeout = null
  }
}

// Used for Spotify rate limiting: stop polling entirely for the duration
// the API told us to back off, then resume on our own rather than waiting
// for a visibility change.
function pauseAndResumeAfter(context: vscode.ExtensionContext, delayMs: number) {
  pausePollingLoop()
  pollingTimeout = setTimeout(() => {
    if (authState) {
      startPollingLoop(context)
    }
  }, delayMs)
}
