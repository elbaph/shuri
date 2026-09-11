import TreeMap from 'ts-treemap'

import { LyricsEntry } from './LyricsEntry'

export class SpotifyCurrentPlayingState {
  name: string
  authors: string
  // Spotify track id, when known. Used to detect an actual track change
  // instead of comparing name/authors text, which can spuriously differ
  // between polls if Spotify reorders a multi-artist track's artist list.
  trackId?: string
  plainLyricsStrs?: string[]
  synchronizedLyricsStrs?: object[]
  synchronizedLyricsMap?: TreeMap<number, LyricsEntry>

  constructor(
    name: string,
    authors: string,
    plainLyricsStrs?: string[],
    synchronizedLyricsStrs?: object[],
    synchronizedLyricsMap?: TreeMap<number, LyricsEntry>
  ) {
    this.name = name
    this.authors = authors
    this.plainLyricsStrs = plainLyricsStrs
    this.synchronizedLyricsStrs = synchronizedLyricsStrs
    this.synchronizedLyricsMap = synchronizedLyricsMap
  }
}
