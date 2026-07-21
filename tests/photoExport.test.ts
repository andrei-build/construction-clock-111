import { describe, expect, it } from 'vitest'
import { crc32, buildStoreZip, watermarkGeometry, dedupeNames } from '../src/screens/project-hub/photoExport'

const enc = new TextEncoder()

// Читатель little-endian из готового zip-буфера.
function u16(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8)
}
function u32(buf: Uint8Array, off: number): number {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0
}

describe('crc32', () => {
  it('пустой ввод даёт 0', () => {
    expect(crc32(new Uint8Array(0))).toBe(0)
  })

  it('«123456789» даёт канонический вектор 0xCBF43926', () => {
    expect(crc32(enc.encode('123456789')) >>> 0).toBe(0xcbf43926)
  })

  it('«The quick brown fox jumps over the lazy dog» = 0x414FA339', () => {
    expect(crc32(enc.encode('The quick brown fox jumps over the lazy dog')) >>> 0).toBe(0x414fa339)
  })

  it('детерминирован при повторных вызовах (кэш таблицы)', () => {
    const a = crc32(enc.encode('abc'))
    const b = crc32(enc.encode('abc'))
    expect(a).toBe(b)
    expect(a >>> 0).toBe(0x352441c2)
  })
})

describe('buildStoreZip', () => {
  it('начинается с сигнатуры local file header PK\\x03\\x04', () => {
    const zip = buildStoreZip([{ name: 'a.txt', bytes: enc.encode('hello') }])
    expect(u32(zip, 0)).toBe(0x04034b50)
  })

  it('заканчивается EOCD PK\\x05\\x06 с верным числом записей', () => {
    const entries = [
      { name: 'a.jpg', bytes: enc.encode('AAA') },
      { name: 'b.jpg', bytes: enc.encode('BBBB') },
      { name: 'c.jpg', bytes: enc.encode('C') },
    ]
    const zip = buildStoreZip(entries)
    const eocdOff = zip.length - 22
    expect(u32(zip, eocdOff)).toBe(0x06054b50)
    expect(u16(zip, eocdOff + 8)).toBe(3) // entries on this disk
    expect(u16(zip, eocdOff + 10)).toBe(3) // total entries
  })

  it('central dir offset/size из EOCD указывают на валидные PK\\x01\\x02', () => {
    const zip = buildStoreZip([
      { name: 'a.txt', bytes: enc.encode('one') },
      { name: 'b.txt', bytes: enc.encode('two!!') },
    ])
    const eocdOff = zip.length - 22
    const cdSize = u32(zip, eocdOff + 12)
    const cdOffset = u32(zip, eocdOff + 16)
    expect(u32(zip, cdOffset)).toBe(0x02014b50) // первый central header
    expect(cdOffset + cdSize + 22).toBe(zip.length) // раскладка сходится
  })

  it('метод компрессии = 0 (store), а compressed size = uncompressed size', () => {
    const data = enc.encode('some payload bytes')
    const zip = buildStoreZip([{ name: 'x.bin', bytes: data }])
    expect(u16(zip, 8)).toBe(0) // method store в local header
    expect(u32(zip, 18)).toBe(data.length) // compressed
    expect(u32(zip, 22)).toBe(data.length) // uncompressed
  })

  it('пишет crc32 данных в local header', () => {
    const data = enc.encode('123456789')
    const zip = buildStoreZip([{ name: 'x.bin', bytes: data }])
    expect(u32(zip, 14)).toBe(0xcbf43926)
  })

  it('сохраняет имя файла и его байты в local record', () => {
    const name = 'photo-1.jpg'
    const data = enc.encode('JPEGDATA')
    const zip = buildStoreZip([{ name, bytes: data }])
    const nameLen = u16(zip, 26)
    expect(nameLen).toBe(name.length)
    const nameBytes = zip.slice(30, 30 + nameLen)
    expect(new TextDecoder().decode(nameBytes)).toBe(name)
    const stored = zip.slice(30 + nameLen, 30 + nameLen + data.length)
    expect(Array.from(stored)).toEqual(Array.from(data))
  })

  it('пустой список даёт валидный пустой архив (только EOCD)', () => {
    const zip = buildStoreZip([])
    expect(zip.length).toBe(22)
    expect(u32(zip, 0)).toBe(0x06054b50)
    expect(u16(zip, 8)).toBe(0)
  })
})

describe('watermarkGeometry', () => {
  it('знак ~12% ширины в правом-нижнем углу с отступом', () => {
    const g = watermarkGeometry(1000, 800)
    expect(g.size).toBe(120)
    const margin = Math.round(800 * 0.03) // 24
    expect(g.x).toBe(1000 - 120 - margin)
    expect(g.y).toBe(800 - 120 - margin)
  })

  it('никогда не вылезает за левый/верхний край на крошечном фото', () => {
    const g = watermarkGeometry(40, 30)
    expect(g.x).toBeGreaterThanOrEqual(0)
    expect(g.y).toBeGreaterThanOrEqual(0)
    expect(g.size).toBeGreaterThanOrEqual(16)
  })

  it('масштабируется с шириной фото', () => {
    expect(watermarkGeometry(2000, 1500).size).toBe(240)
  })
})

describe('dedupeNames', () => {
  it('оставляет уникальные имена как есть', () => {
    expect(dedupeNames(['a.jpg', 'b.jpg'])).toEqual(['a.jpg', 'b.jpg'])
  })

  it('добавляет суффикс перед расширением для повторов', () => {
    expect(dedupeNames(['a.jpg', 'a.jpg', 'a.jpg'])).toEqual(['a.jpg', 'a (2).jpg', 'a (3).jpg'])
  })

  it('работает с именами без расширения', () => {
    expect(dedupeNames(['photo', 'photo'])).toEqual(['photo', 'photo (2)'])
  })
})
