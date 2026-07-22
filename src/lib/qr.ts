// INSTALL-PWA-40: генератор QR-кодов БЕЗ внешних зависимостей (0 npm-deps).
// Реализация стандарта QR Code (ISO/IEC 18004): байтовый режим (UTF-8), полная
// коррекция ошибок Рида — Соломона, автоподбор версии 1–40, выбор лучшей маски по
// штрафным очкам. Возвращает булеву матрицу модулей (true = чёрный), которую UI
// рисует SVG-квадратами. Используется на публичной странице /install и в разделе
// «Команда» для ссылки-приглашения. Портировано под наш стек по эталонному
// алгоритму QR (Project Nayuki, MIT) — без сторонних пакетов.

export type QrEcc = 'L' | 'M' | 'Q' | 'H'
export type QrMatrix = boolean[][]

// Формальные коды уровней коррекции (в порядке возрастания избыточности для маски формата).
const ECC_FORMAT_BITS: Record<QrEcc, number> = { M: 0, L: 1, H: 2, Q: 3 }
const ECC_ORDINAL: Record<QrEcc, number> = { L: 0, M: 1, Q: 2, H: 3 }

// Число кодовых слов коррекции на один блок [ecc-ordinal][version] (индекс версии = version, 0 не используется).
const ECC_CODEWORDS_PER_BLOCK: number[][] = [
  // Version: 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // L
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // M
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Q
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // H
]

// Число блоков коррекции [ecc-ordinal][version].
const NUM_ERROR_CORRECTION_BLOCKS: number[][] = [
  // Version: 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // L
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // M
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Q
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81], // H
]

// Число кодовых слов данных = всего кодовых слов − коррекция. Всего модулей данных считаем сами.
function getNumRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (ver >= 7) result -= 36
  }
  return result
}

function getNumDataCodewords(ver: number, ecc: QrEcc): number {
  const e = ECC_ORDINAL[ecc]
  return (
    Math.floor(getNumRawDataModules(ver) / 8) -
    ECC_CODEWORDS_PER_BLOCK[e][ver] * NUM_ERROR_CORRECTION_BLOCKS[e][ver]
  )
}

// --- Арифметика поля Галуа GF(256) для Рида — Соломона (примитивный полином 0x11D) ---
function gfMul(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

// Строит делитель-полином генератора для degree кодовых слов коррекции.
function reedSolomonComputeDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root)
      if (j + 1 < result.length) result[j] ^= result[j + 1]
    }
    root = gfMul(root, 0x02)
  }
  return result
}

// Остаток от деления data на divisor в GF(256) = кодовые слова коррекции.
function reedSolomonComputeRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0)
  for (const b of data) {
    const factor = b ^ result.shift()!
    result.push(0)
    for (let i = 0; i < result.length; i++) result[i] ^= gfMul(divisor[i], factor)
  }
  return result
}

// Число служебных бит счётчика длины для байтового режима на данной версии.
function charCountBits(ver: number): number {
  return ver <= 9 ? 8 : 16
}

// UTF-8 байты строки.
function utf8Bytes(text: string): number[] {
  const out: number[] = []
  for (const ch of text) {
    let cp = ch.codePointAt(0)!
    if (cp < 0x80) out.push(cp)
    else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f))
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      )
    }
  }
  return out
}

// Позиции центров выравнивающих узоров для версии (>=2). Version 1 — пусто.
function alignmentPatternPositions(ver: number): number[] {
  if (ver === 1) return []
  const numAlign = Math.floor(ver / 7) + 2
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2
  const result: number[] = [6]
  for (let pos = ver * 4 + 10; result.length < numAlign; pos -= step) result.splice(1, 0, pos)
  return result
}

// --- Построение матрицы модулей ---
type Grid = { size: number; modules: boolean[][]; isFunction: boolean[][] }

function setFunctionModule(grid: Grid, x: number, y: number, isDark: boolean) {
  grid.modules[y][x] = isDark
  grid.isFunction[y][x] = true
}

function drawFinderPattern(grid: Grid, x: number, y: number) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy))
      const xx = x + dx
      const yy = y + dy
      if (xx >= 0 && xx < grid.size && yy >= 0 && yy < grid.size) {
        setFunctionModule(grid, xx, yy, dist !== 2 && dist !== 4)
      }
    }
  }
}

function drawAlignmentPattern(grid: Grid, x: number, y: number) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      setFunctionModule(grid, x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  }
}

// Резервирует служебные модули (маску формата рисуем позже как all-dark placeholder).
function drawFunctionPatterns(grid: Grid, ver: number) {
  const size = grid.size
  // Тайминг-линии.
  for (let i = 0; i < size; i++) {
    setFunctionModule(grid, 6, i, i % 2 === 0)
    setFunctionModule(grid, i, 6, i % 2 === 0)
  }
  // Три поисковых узора + разделители.
  drawFinderPattern(grid, 3, 3)
  drawFinderPattern(grid, size - 4, 3)
  drawFinderPattern(grid, 3, size - 4)
  // Выравнивающие узоры.
  const align = alignmentPatternPositions(ver)
  const n = align.length
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const skipCorner = (i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)
      if (!skipCorner) drawAlignmentPattern(grid, align[i], align[j])
    }
  }
  // Резерв под формат (рисуется в applyFormatInfo).
  drawFormatBits(grid, 'M', 0, true)
  drawVersionInfo(grid, ver)
}

function drawFormatBits(grid: Grid, ecc: QrEcc, mask: number, reserveOnly = false) {
  const size = grid.size
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  const bits = ((data << 10) | rem) ^ 0x5412
  const get = (i: number) => (reserveOnly ? true : ((bits >>> i) & 1) !== 0)
  // Верх-лево вокруг угла.
  for (let i = 0; i <= 5; i++) setFunctionModule(grid, 8, i, get(i))
  setFunctionModule(grid, 8, 7, get(6))
  setFunctionModule(grid, 8, 8, get(7))
  setFunctionModule(grid, 7, 8, get(8))
  for (let i = 9; i < 15; i++) setFunctionModule(grid, 14 - i, 8, get(i))
  // Дублирование по краям.
  for (let i = 0; i < 8; i++) setFunctionModule(grid, size - 1 - i, 8, get(i))
  for (let i = 8; i < 15; i++) setFunctionModule(grid, 8, size - 15 + i, get(i))
  setFunctionModule(grid, 8, size - 8, true) // всегда тёмный модуль
}

function drawVersionInfo(grid: Grid, ver: number) {
  if (ver < 7) return
  const size = grid.size
  let rem = ver
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
  const bits = (ver << 12) | rem
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >>> i) & 1) !== 0
    const a = size - 11 + (i % 3)
    const b = Math.floor(i / 3)
    setFunctionModule(grid, a, b, bit)
    setFunctionModule(grid, b, a, bit)
  }
}

// Раскладывает codewords зигзагом по свободным (не-служебным) модулям.
function drawCodewords(grid: Grid, data: number[]) {
  const size = grid.size
  let i = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (!grid.isFunction[y][x] && i < data.length * 8) {
          grid.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0
          i++
        }
      }
    }
  }
}

function applyMask(grid: Grid, mask: number) {
  for (let y = 0; y < grid.size; y++) {
    for (let x = 0; x < grid.size; x++) {
      if (grid.isFunction[y][x]) continue
      let invert = false
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break
        case 1: invert = y % 2 === 0; break
        case 2: invert = x % 3 === 0; break
        case 3: invert = (x + y) % 3 === 0; break
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break
        case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break
        case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break
        case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break
      }
      if (invert) grid.modules[y][x] = !grid.modules[y][x]
    }
  }
}

// Штраф маски (четыре правила спецификации). Меньше — лучше.
function penaltyScore(grid: Grid): number {
  const size = grid.size
  const mods = grid.modules
  let penalty = 0
  // Правило 1: серии одного цвета в строках/столбцах.
  for (let y = 0; y < size; y++) {
    let runColor = false
    let runLen = 0
    for (let x = 0; x < size; x++) {
      if (mods[y][x] === runColor) {
        runLen++
        if (runLen === 5) penalty += 3
        else if (runLen > 5) penalty++
      } else {
        runColor = mods[y][x]
        runLen = 1
      }
    }
  }
  for (let x = 0; x < size; x++) {
    let runColor = false
    let runLen = 0
    for (let y = 0; y < size; y++) {
      if (mods[y][x] === runColor) {
        runLen++
        if (runLen === 5) penalty += 3
        else if (runLen > 5) penalty++
      } else {
        runColor = mods[y][x]
        runLen = 1
      }
    }
  }
  // Правило 2: блоки 2×2 одного цвета.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = mods[y][x]
      if (c === mods[y][x + 1] && c === mods[y + 1][x] && c === mods[y + 1][x + 1]) penalty += 3
    }
  }
  // Правило 3: узор-финдер-подобные последовательности.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (x <= size - 7 && finderLike(mods[y], x)) penalty += 40
      if (y <= size - 7 && finderLike(mods.map((r) => r[x]), y)) penalty += 40
    }
  }
  // Правило 4: отклонение доли тёмных модулей от 50%.
  let dark = 0
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (mods[y][x]) dark++
  const total = size * size
  const k = Math.floor((Math.abs(dark * 20 - total * 10) + total - 1) / total) - 1
  penalty += k * 10
  return penalty
}

function finderLike(line: boolean[], x: number): boolean {
  // Шаблон 1:1:3:1:1 тёмный-светлый (с обрамляющим светлым) — упрощённая проверка 7 модулей.
  return (
    line[x] && !line[x + 1] && line[x + 2] && line[x + 3] && line[x + 4] && !line[x + 5] && line[x + 6]
  )
}

// Подбирает минимальную версию, вмещающую данные при уровне ecc.
function chooseVersion(numBytes: number, ecc: QrEcc): number {
  for (let ver = 1; ver <= 40; ver++) {
    const capacityBits = getNumDataCodewords(ver, ecc) * 8
    const usedBits = 4 + charCountBits(ver) + numBytes * 8
    if (usedBits <= capacityBits) return ver
  }
  return -1
}

// Формирует финальную последовательность кодовых слов (данные + коррекция, чередование блоков).
function addEccAndInterleave(dataCodewords: number[], ver: number, ecc: QrEcc): number[] {
  const e = ECC_ORDINAL[ecc]
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[e][ver]
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[e][ver]
  const rawCodewords = Math.floor(getNumRawDataModules(ver) / 8)
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
  const shortBlockLen = Math.floor(rawCodewords / numBlocks)

  const blocks: number[][] = []
  const divisor = reedSolomonComputeDivisor(blockEccLen)
  let k = 0
  for (let i = 0; i < numBlocks; i++) {
    const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1)
    const dat = dataCodewords.slice(k, k + datLen)
    k += datLen
    const ecCw = reedSolomonComputeRemainder(dat, divisor)
    if (i < numShortBlocks) dat.push(0) // выравниватель для чередования
    blocks.push(dat.concat(ecCw))
  }

  const result: number[] = []
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      // Пропускаем добавленный выравниватель короткого блока в зоне данных.
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(blocks[j][i])
    }
  }
  return result
}

/**
 * Кодирует произвольную строку в матрицу QR-модулей. Возвращает квадратный массив
 * boolean[][] (true = тёмный модуль). Пустая строка кодируется как валидный QR
 * минимального размера (UI не падает). ecc по умолчанию 'M'.
 */
export function encodeQr(text: string, ecc: QrEcc = 'M'): QrMatrix {
  const bytes = utf8Bytes(text ?? '')
  const ver = chooseVersion(bytes.length, ecc)
  if (ver < 0) throw new Error('qr: данные не помещаются даже в версию 40')

  // Битовый поток: режим (0100) + счётчик длины + байты.
  const bits: number[] = []
  const appendBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1)
  }
  appendBits(0x4, 4) // байтовый режим
  appendBits(bytes.length, charCountBits(ver))
  for (const b of bytes) appendBits(b, 8)

  const capacityBits = getNumDataCodewords(ver, ecc) * 8
  // Терминатор + выравнивание до байта.
  appendBits(0, Math.min(4, capacityBits - bits.length))
  while (bits.length % 8 !== 0) bits.push(0)
  // Паддинг-байты 0xEC/0x11 до вместимости.
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) appendBits(pad, 8)

  const dataCodewords: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]
    dataCodewords.push(byte)
  }

  const allCodewords = addEccAndInterleave(dataCodewords, ver, ecc)

  const size = ver * 4 + 17
  const grid: Grid = {
    size,
    modules: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    isFunction: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  }
  drawFunctionPatterns(grid, ver)
  drawCodewords(grid, allCodewords)

  // Перебор 8 масок — берём с минимальным штрафом.
  let bestMask = 0
  let minPenalty = Infinity
  for (let mask = 0; mask < 8; mask++) {
    applyMask(grid, mask)
    drawFormatBits(grid, ecc, mask)
    const p = penaltyScore(grid)
    if (p < minPenalty) {
      minPenalty = p
      bestMask = mask
    }
    applyMask(grid, mask) // откат (маска XOR-симметрична)
  }
  applyMask(grid, bestMask)
  drawFormatBits(grid, ecc, bestMask)

  return grid.modules
}

/**
 * Рендерит матрицу QR в самодостаточную SVG-строку. quietZone — светлая рамка
 * (модулей, по умолчанию 4 по стандарту). Цвета настраиваемы под тёмную тему.
 * Пустая/битая матрица → пустой (но валидный) SVG, UI не падает.
 */
export function qrToSvg(
  matrix: QrMatrix,
  opts: { size?: number; quietZone?: number; dark?: string; light?: string } = {},
): string {
  const { size = 240, quietZone = 4, dark = '#0f1420', light = '#ffffff' } = opts
  const n = Array.isArray(matrix) && matrix.length > 0 ? matrix.length : 0
  const dim = n + quietZone * 2
  if (n === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1 1"><rect width="1" height="1" fill="${light}"/></svg>`
  }
  let path = ''
  for (let y = 0; y < n; y++) {
    const row = matrix[y]
    if (!Array.isArray(row)) continue
    for (let x = 0; x < n; x++) {
      if (row[x]) path += `M${x + quietZone} ${y + quietZone}h1v1h-1z`
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/></svg>`
  )
}
