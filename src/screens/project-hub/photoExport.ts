// MARKET-5-UI PHOTO-EXPORT: чистые (DOM-free) хелперы выгрузки подборки фото.
// Canvas-композиция водяного знака, fetch байтов и navigator.share живут в FilesTab (их не юнит-тестим).
// Здесь — только детерминированная логика: CRC32, STORE-only ZIP, геометрия водяного знака,
// уникализация имён внутри архива. Всё покрыто tests/photoExport.test.ts.

export interface ZipEntry {
  name: string
  bytes: Uint8Array
}

// CRC32 (полином 0xEDB88320, init 0xFFFFFFFF, финальный XOR) — тот же, что ждёт ZIP.
let CRC_TABLE: Uint32Array | null = null
function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  CRC_TABLE = table
  return table
}

export function crc32(bytes: Uint8Array): number {
  const table = crcTable()
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// STORE-only ZIP (method=0, без компрессии): фото уже сжаты (JPEG/PNG), так что архив просто
// упаковывает байты. Структура: [local header + name + data]* + [central dir]* + EOCD. Всё little-endian.
export function buildStoreZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name)
    const data = entry.bytes
    const crc = crc32(data)
    const size = data.length

    // Local file header: 30 байт + имя + данные.
    const local = new Uint8Array(30 + nameBytes.length + size)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true) // PK\x03\x04
    lv.setUint16(4, 20, true) // version needed
    lv.setUint16(6, 0, true) // flags
    lv.setUint16(8, 0, true) // method = store
    lv.setUint16(10, 0, true) // mod time
    lv.setUint16(12, 0x21, true) // mod date = 1980-01-01 (детерминированно)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, size, true) // compressed size
    lv.setUint32(22, size, true) // uncompressed size
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true) // extra length
    local.set(nameBytes, 30)
    local.set(data, 30 + nameBytes.length)
    locals.push(local)

    // Central directory header: 46 байт + имя.
    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true) // PK\x01\x02
    cv.setUint16(4, 20, true) // version made by
    cv.setUint16(6, 20, true) // version needed
    cv.setUint16(8, 0, true) // flags
    cv.setUint16(10, 0, true) // method = store
    cv.setUint16(12, 0, true) // mod time
    cv.setUint16(14, 0x21, true) // mod date
    cv.setUint32(16, crc, true)
    cv.setUint32(20, size, true) // compressed size
    cv.setUint32(24, size, true) // uncompressed size
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint16(30, 0, true) // extra length
    cv.setUint16(32, 0, true) // comment length
    cv.setUint16(34, 0, true) // disk number start
    cv.setUint16(36, 0, true) // internal attrs
    cv.setUint32(38, 0, true) // external attrs
    cv.setUint32(42, offset, true) // relative offset of local header
    central.set(nameBytes, 46)
    centrals.push(central)

    offset += local.length
  }

  const centralOffset = offset
  let centralSize = 0
  for (const c of centrals) centralSize += c.length

  // End of central directory (EOCD): 22 байта, без комментария.
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true) // PK\x05\x06
  ev.setUint16(4, 0, true) // disk number
  ev.setUint16(6, 0, true) // disk with central dir
  ev.setUint16(8, entries.length, true) // entries on this disk
  ev.setUint16(10, entries.length, true) // total entries
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, centralOffset, true)
  ev.setUint16(20, 0, true) // comment length

  const total = centralOffset + centralSize + eocd.length
  const out = new Uint8Array(total)
  let p = 0
  for (const l of locals) { out.set(l, p); p += l.length }
  for (const c of centrals) { out.set(c, p); p += c.length }
  out.set(eocd, p)
  return out
}

// Геометрия водяного знака: квадратный логотип в правом-нижнем углу, ~12% ширины фото,
// отступ ~3% от меньшей стороны. Зажим на маленьких фото, чтобы знак не вылезал за кадр.
export function watermarkGeometry(
  photoW: number,
  photoH: number,
): { x: number; y: number; size: number } {
  const size = Math.max(16, Math.round(photoW * 0.12))
  const margin = Math.round(Math.min(photoW, photoH) * 0.03)
  const x = Math.max(0, photoW - size - margin)
  const y = Math.max(0, photoH - size - margin)
  return { x, y, size }
}

// Уникализация имён внутри архива: одинаковые имена ломают распаковку у части архиваторов,
// поэтому повторам добавляем суффикс « (2)», « (3)» перед расширением.
export function dedupeNames(names: string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((name) => {
    const count = seen.get(name) ?? 0
    seen.set(name, count + 1)
    if (count === 0) return name
    const dot = name.lastIndexOf('.')
    if (dot <= 0) return `${name} (${count + 1})`
    return `${name.slice(0, dot)} (${count + 1})${name.slice(dot)}`
  })
}
