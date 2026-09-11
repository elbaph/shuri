import fetch from 'node-fetch'

import { SpotifyGetCurrentlyPlayingResponse } from './response/SpotifyGetCurrentlyPlayingResponse'
import { SpotifyGetTokenResponse } from './response/SpotifyGetTokenResponse'
import { SpotifyRefreshTokenResponse } from './response/SpotifyRefreshTokenResponse'

interface SpotifyTokenErrorBody {
  error?: string
  error_description?: string
}

// api.spotify.com (as opposed to accounts.spotify.com) uses a different,
// nested error shape: { "error": { "status": 429, "message": "..." } }.
interface SpotifyApiErrorBody {
  error?: { status?: number; message?: string }
}

export class SpotifyAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpotifyAuthError'
  }
}

export class SpotifyRateLimitError extends Error {
  retryAfterMs: number

  constructor(message: string, retryAfterMs: number) {
    super(message)
    this.name = 'SpotifyRateLimitError'
    this.retryAfterMs = retryAfterMs
  }
}

const DEFAULT_RATE_LIMIT_RETRY_MS = 30_000

function retryAfterMs(response: { headers: { get(name: string): string | null } }): number {
  const seconds = Number(response.headers.get('retry-after'))
  return seconds > 0 ? seconds * 1000 : DEFAULT_RATE_LIMIT_RETRY_MS
}

export class SpotifyWebApi {
  static async getAuthUrl(port: number, clientId: string, codeChallenge: string) {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      scope: 'user-read-currently-playing user-modify-playback-state',
      redirect_uri: `http://127.0.0.1:${port}/callback`,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    })

    return `https://accounts.spotify.com/authorize?${params.toString()}`
  }

  static async getToken(
    clientId: string,
    codeVerifier: string,
    redirectUri: string,
    code: string,
    grantType: string
  ) {
    const params = new URLSearchParams()
    params.append('grant_type', grantType)
    params.append('code', code)
    params.append('redirect_uri', redirectUri)
    params.append('code_verifier', codeVerifier)
    params.append('client_id', clientId)

    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    })

    const body = (await response.json()) as SpotifyGetTokenResponse & SpotifyTokenErrorBody
    if (!response.ok) {
      const message =
        body.error_description ?? body.error ?? `Spotify token request failed (${response.status})`
      if (response.status === 429) {
        throw new SpotifyRateLimitError(message, retryAfterMs(response))
      }
      throw new SpotifyAuthError(message)
    }
    return body
  }

  static async refreshToken(refreshToken: string, clientId: string) {
    const params = new URLSearchParams()
    params.append('grant_type', 'refresh_token')
    params.append('refresh_token', refreshToken)
    params.append('client_id', clientId)

    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    })

    const body = (await response.json()) as SpotifyRefreshTokenResponse & SpotifyTokenErrorBody
    if (!response.ok) {
      const message =
        body.error_description ?? body.error ?? `Spotify token refresh failed (${response.status})`
      if (response.status === 429) {
        throw new SpotifyRateLimitError(message, retryAfterMs(response))
      }
      throw new SpotifyAuthError(message)
    }
    return body
  }

  static async getCurrentlyPlaying(accessToken: string) {
    const response = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${accessToken}`,
      },
    })

    if (response.status === 204) {
      return null
    }

    const body = (await response.json()) as SpotifyGetCurrentlyPlayingResponse & SpotifyApiErrorBody

    if (!response.ok) {
      const message =
        body.error?.message ?? `Spotify currently-playing request failed (${response.status})`
      if (response.status === 401) {
        throw new SpotifyAuthError(message)
      }
      if (response.status === 429) {
        throw new SpotifyRateLimitError(message, retryAfterMs(response))
      }
      throw new Error(message)
    }

    // Spotify can return 200 with no item — e.g. an ad is playing, or the
    // session is private. Treat that the same as "nothing is playing"
    // rather than passing through an object with no .item to read.
    if (!body.item) {
      return null
    }

    return body
  }

  static async seekToPosition(accessToken: string, position_ms: number) {
    const params = new URLSearchParams()
    params.append('position_ms', String(position_ms))
    await fetch(`https://api.spotify.com/v1/me/player/seek?${params.toString()}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })
  }
}
