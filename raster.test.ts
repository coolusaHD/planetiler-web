import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { gunzipSync } from 'node:zlib'
import { writeRasterPmtiles, zxyToTileId } from './raster'

interface Entry {
  tileId: number
  offset: number
  length: number
  runLength: number
}

function readVarint(buf: Buffer, pos: { i: number }): number {
  let result = 0
  let factor = 1
  for (;;) {
    const byte = buf[pos.i++]
    result += (byte & 0x7f) * factor
    if (byte < 0x80) return result
    factor *= 0x80
  }
}

function readDirectory(compressed: Buffer): Entry[] {
  const buf = gunzipSync(compressed)
  const pos = { i: 0 }
  const entries: Entry[] = []
  let tileId = 0
  for (let n = readVarint(buf, pos); n > 0; n--) {
    tileId += readVarint(buf, pos)
    entries.push({ tileId, offset: 0, length: 0, runLength: 0 })
  }
  for (const e of entries) e.runLength = readVarint(buf, pos)
  for (const e of entries) e.length = readVarint(buf, pos)
  entries.forEach((e, i) => {
    const value = readVarint(buf, pos)
    const previous = entries[i - 1]
    e.offset = value === 0 && previous ? previous.offset + previous.length : value - 1
  })
  return entries
}

function readTile(archive: Buffer, tileId: number): Buffer | undefined {
  const u64 = (offset: number) => Number(archive.readBigUInt64LE(offset))
  let directory = readDirectory(archive.subarray(u64(8), u64(8) + u64(16)))
  for (;;) {
    const entry = directory.filter((e) => e.tileId <= tileId).pop()
    if (!entry) return undefined
    if (entry.runLength === 0) {
      const start = u64(40) + entry.offset
      directory = readDirectory(archive.subarray(start, start + entry.length))
      continue
    }
    if (tileId >= entry.tileId + entry.runLength) return undefined
    const start = u64(56) + entry.offset
    return archive.subarray(start, start + entry.length)
  }
}

function writeAndRead(tiles: Map<number, Buffer>): Buffer {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'raster-')), 'test.pmtiles')
  const bbox = { minX: 8.87, minY: 48.07, maxX: 8.92, maxY: 48.09 }
  writeRasterPmtiles(file, tiles, { format: 'webp', minZoom: 13, maxZoom: 18, bbox })
  return fs.readFileSync(file)
}

test('tile ids follow the PMTiles spec', () => {
  assert.equal(zxyToTileId(0, 0, 0), 0)
  assert.equal(zxyToTileId(1, 0, 0), 1)
  assert.equal(zxyToTileId(1, 0, 1), 2)
  assert.equal(zxyToTileId(1, 1, 1), 3)
  assert.equal(zxyToTileId(1, 1, 0), 4)
  assert.equal(zxyToTileId(2, 0, 0), 5)
})

test('archive is a clustered raster archive the reader can resolve', () => {
  const blank = Buffer.from('blank')
  const tiles = new Map([
    [10, Buffer.from('ten')],
    [11, blank],
    [12, blank],
    [40, Buffer.from('forty')]
  ])
  const archive = writeAndRead(tiles)

  assert.equal(archive.subarray(0, 7).toString(), 'PMTiles')
  assert.equal(archive[96], 1, 'clustered')
  assert.equal(archive[99], 4, 'webp')
  for (const [tileId, data] of tiles) {
    assert.deepEqual(readTile(archive, tileId), data)
  }
  assert.equal(readTile(archive, 13), undefined)
  assert.equal(Number(archive.readBigUInt64LE(88)), 3, 'identical tiles are stored once')
})

test('large archives move entries into leaf directories', () => {
  let seed = 42
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
  const tiles = new Map<number, Buffer>()
  let tileId = 0
  for (let i = 0; i < 12000; i++) {
    tileId += 1 + Math.floor(random() * 5000)
    tiles.set(tileId, Buffer.alloc(1 + Math.floor(random() * 3000), i % 251))
  }
  const archive = writeAndRead(tiles)

  assert.ok(127 + Number(archive.readBigUInt64LE(16)) <= 16384, 'root fits the first 16 KiB')
  assert.ok(Number(archive.readBigUInt64LE(48)) > 0, 'leaf directories written')
  for (const [id, data] of [...tiles].filter((_, i) => i % 997 === 0)) {
    assert.deepEqual(readTile(archive, id), data)
  }
})
