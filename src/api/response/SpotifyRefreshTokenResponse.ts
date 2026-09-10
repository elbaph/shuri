export interface SpotifyRefreshTokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  // Spotify does not always issue a new refresh token on refresh; when
  // absent, callers must keep using the previous one (RFC 6749 §6).
  refresh_token?: string
  scope: string
}
