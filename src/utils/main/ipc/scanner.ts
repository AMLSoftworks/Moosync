/* 
 *  scanner.ts is a part of Moosync.
 *  
 *  Copyright 2021 by Sahil Gupte <sahilsachingupte@gmail.com>. All rights reserved.
 *  Licensed under the GNU General Public License. 
 *  
 *  See LICENSE in the project root for license information.
 */

import { IpcEvents, ScannerEvents } from './constants'
import { Pool, Thread, TransferDescriptor, Worker, spawn } from 'threads'

import { IpcMainEvent } from 'electron'
import { SongDB } from '@/utils/main/db/index'
import fs from 'fs'
import { loadPreferences } from '@/utils/main/db/preferences'
import { notifyRenderer } from '.'

enum scanning {
  UNDEFINED,
  SCANNING,
  QUEUED,
}

export class ScannerChannel implements IpcChannelInterface {
  name = IpcEvents.SCANNER
  private scanStatus: scanning = scanning.UNDEFINED

  private coverPool = Pool(() => spawn(new Worker('@/utils/main/workers/covers.ts', { type: 'module' })))
  private scannerWorker: any
  private scraperWorker: any

  handle(event: IpcMainEvent, request: IpcRequest) {
    switch (request.type) {
      case ScannerEvents.SCAN_MUSIC:
        this.ScanSongs(event, request)
        break
    }
  }

  private async checkAlbumCovers(song: Song | undefined) {
    return (await this.checkCoverExists(song?.album?.album_coverPath_low) && (await this.checkCoverExists(song?.album?.album_coverPath_high)))
  }

  private async checkSongCovers(song: Song | undefined) {
    return (await this.checkCoverExists(song?.song_coverPath_high) && await this.checkCoverExists(song?.song_coverPath_low))
  }

  private async checkDuplicate(song: Song, cover: TransferDescriptor<Buffer> | undefined) {
    notifyRenderer({ id: 'scan-status', message: `Scanned ${song.title}`, type: 'info' })

    const existing = SongDB.getByHash(song.hash!)
    if (!existing) {
      const res = cover && await this.storeCover(song._id!, cover)
      if (res) {
        if (!(await this.checkAlbumCovers(song))) {
          song.album = {
            ...song.album,
            album_coverPath_high: res.high,
            album_coverPath_low: res.low
          }
        }
        song.song_coverPath_high = res.high
        song.song_coverPath_low = res.low
      }

      await SongDB.store(song)
    } else {
      const albumCoverExists = await this.checkAlbumCovers(song)
      const songCoverExists = await this.checkSongCovers(song)

      console.log(albumCoverExists, songCoverExists)
      if (!albumCoverExists || !songCoverExists) {
        const res = cover && await this.storeCover(song._id!, cover)
        if (res) {
          if (!songCoverExists)
            SongDB.updateSongCover(existing._id, res.high, res.low)

          if (!albumCoverExists)
            SongDB.updateAlbumCovers(existing._id, res.high, res.low)
        }
      }
    }
  }

  private async storeCover(id: string, cover: TransferDescriptor<Buffer> | undefined) {
    if (cover) {
      const thumbPath = (await loadPreferences()).thumbnailPath
      if (this.coverPool) {
        return new Promise<{ high: string, low: string }>((resolve, reject) => {
          this.coverPool.queue(coverTask => coverTask.writeCover(cover, thumbPath, id, true).then((val) => resolve(val)).catch((e) => reject(e)))
        })
      }
    }
  }

  private async storeCoverSIngle(id: string, cover: TransferDescriptor<Buffer> | undefined) {
    if (cover) {
      const thumbPath = loadPreferences().thumbnailPath
      if (this.coverPool) {
        return new Promise<{ high: string }>((resolve, reject) => {
          this.coverPool.queue(coverTask => coverTask.writeCover(cover, thumbPath, id, false).then((val) => resolve(val)).catch((e) => reject(e)))
        })
      }
    }
  }

  private scanSongs(preferences: Preferences): Promise<void> {
    return new Promise((resolve, reject) => {
      this.scannerWorker.start(preferences.musicPaths).subscribe(
        (result: { song: Song, cover: TransferDescriptor<Buffer> }) => this.checkDuplicate(result.song, result.cover),
        (err: Error) => reject(err),
        () =>
          resolve()
      )
    })
  }

  private fetchMBID(allArtists: artists[]) {
    return new Promise((resolve, reject) => {
      this.scraperWorker.fetchMBID(allArtists).subscribe(
        (result: artists) => (result ? SongDB.updateArtists(result) : null),
        (err: Error) => reject(err),
        () => resolve(undefined)
      )
    })
  }

  private async updateArtwork(artist: artists, cover: TransferDescriptor<Buffer> | undefined) {
    const ret: artists = artist
    notifyRenderer({ id: 'artwork-status', message: `Found artwork for ${artist.artist_name}`, type: 'info' })
    if (cover) {
      ret.artist_coverPath = (await this.storeCover(artist.artist_id, cover))?.high
    } else {
      ret.artist_coverPath = await SongDB.getDefaultCoverByArtist(artist.artist_id)
    }

    await SongDB.updateArtists(ret)
  }

  private async fetchArtworks(allArtists: artists[]) {
    const artworkPath = loadPreferences().artworkPath
    return new Promise((resolve) => {
      this.scraperWorker.fetchArtworks(allArtists, artworkPath).subscribe(
        (result: { artist: artists, cover: TransferDescriptor<Buffer> }) => this.updateArtwork(result.artist, result.cover),
        console.error,
        () => resolve(undefined)
      )
    })
  }

  private async checkCoverExists(coverPath: string | undefined): Promise<boolean> {
    if (coverPath && !coverPath.startsWith('http')) {
      try {
        await fs.promises.access(coverPath)
        return true
      } catch (e) {
        console.error(`${coverPath} not accessible`)
        return false
      }
    }
    return false
  }

  private updateCounts() {
    SongDB.updateSongCountAlbum()
    SongDB.updateSongCountArtists()
    SongDB.updateSongCountGenre()
    SongDB.updateSongCountPlaylists()
  }

  private async destructiveScan(paths: togglePaths) {
    const allSongs = await SongDB.getSongByOptions()
    const regex = new RegExp(paths.join('|'))
    for (const s of allSongs) {
      if (s.type == 'LOCAL') {
        if (paths.length == 0 || !(s.path && s.path.match(regex)) || !s.path) {
          await SongDB.removeSong(s._id!)
          continue
        }

        try {
          await fs.promises.access(s.path!, fs.constants.F_OK)
        } catch (e) {
          await SongDB.removeSong(s._id!)
        }
      }
    }
  }

  // TODO: Add queueing for scraping artworks
  private async scrapeArtists() {
    console.log('scraping')
    this.scraperWorker = await spawn(new Worker('@/utils/main/workers/scraper.ts', { type: 'module' }))
    const allArtists = SongDB.getEntityByOptions<artists>({
      artist: true
    })

    await this.fetchMBID(allArtists)

    await this.fetchArtworks(allArtists)

    await this.coverPool.completed()
    await Thread.terminate(this.scraperWorker)
    this.scraperWorker = undefined
  }

  private isScanning() {
    return this.scanStatus == scanning.SCANNING || this.scanStatus == scanning.QUEUED
  }

  private isScanQueued() {
    return this.scanStatus == scanning.QUEUED
  }

  private setScanning() {
    this.scanStatus = scanning.SCANNING
  }

  private setIdle() {
    this.scanStatus = scanning.UNDEFINED
  }

  private setQueued() {
    this.scanStatus = scanning.QUEUED
  }

  private async scanAll(event?: IpcMainEvent, request?: IpcRequest) {
    if (this.isScanning()) {
      this.setQueued()
      return
    }
    this.setScanning()

    const preferences = loadPreferences()
    notifyRenderer({ id: 'started-scan', message: 'Starting scanning files', type: 'info' })

    if (this.scannerWorker) {
      await Thread.terminate(this.scannerWorker)
      this.scannerWorker = undefined
    }
    this.scannerWorker = await spawn(new Worker('@/utils/main/workers/scanner.ts', { type: 'module' }))

    await this.destructiveScan(preferences.musicPaths)
    await this.scanSongs(preferences)

    this.updateCounts()

    this.setIdle()

    Thread.terminate(this.scannerWorker)

    notifyRenderer({ id: 'completed-scan', message: 'Scanning Completed', type: 'info' })

    if (this.isScanQueued()) {
      await this.scanAll(event, request)
    }

    // Run scraping task only if all subsequent scanning tasks are completed
    // And if no other scraping task is ongoing
    if (!this.isScanning() && !this.scraperWorker) {
      await this.scrapeArtists()
    }

    if (event && request) event.reply(request.responseChannel)
  }

  public async ScanSongs(event?: IpcMainEvent, request?: IpcRequest) {
    await this.scanAll(event, request).catch((err) => {
      console.error(err)
      event?.reply(request?.responseChannel)
    })
    event?.reply(request?.responseChannel)
  }
}