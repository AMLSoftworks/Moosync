type ContextMenuArgs = {
  type: 'SONGS'
  args: {
    exclude: string | undefined
    refreshCallback: () => void
    songs: Song[]
  }
} | {
  type: 'YOUTUBE'
  args: {
    ytItems: YoutubeItem[]
  }
} | {
  type: 'PLAYLIST'
  args: {
    playlist: Playlist
    refreshCallback: () => void
  }
} |
{
  type: 'GENERAL_PLAYLIST'
} | {
  type: 'PLAYLIST_CONTENT',
  args: {
    isRemote: boolean,
    refreshCallback: () => void
    songs: Song[]
  }
} | {
  type: 'QUEUE_ITEM',
  args: {
    isRemote: boolean
    refreshCallback: () => void
    song: Song
  }
}