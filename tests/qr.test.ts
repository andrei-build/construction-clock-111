import { describe, it, expect } from 'vitest'
import { encodeQr, qrToSvg } from '../src/lib/qr'

// INSTALL-PWA-40: юнит-тесты dep-free QR-энкодера. Проверяем размер/структуру
// (поисковые узоры, тайминг-линии), детерминизм и устойчивость к пустому вводу.

function isSquareBool(m: unknown[][]): boolean {
  return (
    Array.isArray(m) &&
    m.length > 0 &&
    m.every((row) => Array.isArray(row) && row.length === m.length && row.every((c) => typeof c === 'boolean'))
  )
}

// Проверяет 7×7 поисковый узор (рамка тёмная, зазор светлый, ядро 3×3 тёмное) в углу (ox,oy).
function hasFinder(m: boolean[][], ox: number, oy: number): boolean {
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      const dist = Math.max(Math.abs(x - 3), Math.abs(y - 3))
      const expectDark = dist !== 2 && dist !== 4
      if (m[oy + y][ox + x] !== expectDark) return false
    }
  }
  return true
}

describe('encodeQr', () => {
  it('возвращает квадратную булеву матрицу нужного размера (версия 1 = 21×21 для короткой строки)', () => {
    const m = encodeQr('MARVEL')
    expect(isSquareBool(m)).toBe(true)
    // Короткая строка помещается в версию 1: размер = 1*4+17 = 21.
    expect(m.length).toBe(21)
  })

  it('размещает три поисковых узора по углам', () => {
    const m = encodeQr('https://example.com/install')
    const n = m.length
    expect(hasFinder(m, 0, 0)).toBe(true) // верх-лево
    expect(hasFinder(m, n - 7, 0)).toBe(true) // верх-право
    expect(hasFinder(m, 0, n - 7)).toBe(true) // низ-лево
  })

  it('рисует тайминг-линии (чередование) на строке/столбце 6', () => {
    const m = encodeQr('marvel-construction')
    const n = m.length
    // Между поисковыми узорами (индексы 8..n-9) тайминг чередуется тёмный/светлый.
    for (let i = 8; i < n - 8; i++) {
      expect(m[6][i]).toBe(i % 2 === 0)
      expect(m[i][6]).toBe(i % 2 === 0)
    }
  })

  it('детерминирован: одинаковый ввод даёт одинаковую матрицу (стабильная версия/маска)', () => {
    const a = encodeQr('https://marvel.example/install')
    const b = encodeQr('https://marvel.example/install')
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('растёт в версии при длинном вводе (матрица больше 21×21)', () => {
    const long = 'x'.repeat(200)
    const m = encodeQr(long)
    expect(m.length).toBeGreaterThan(21)
    // Размер всегда вида 4*ver+17 → (size-17) кратно 4.
    expect((m.length - 17) % 4).toBe(0)
  })

  it('кодирует пустую строку в валидную непустую матрицу (UI не падает)', () => {
    const m = encodeQr('')
    expect(isSquareBool(m)).toBe(true)
    expect(m.length).toBe(21)
  })

  it('поддерживает разные уровни коррекции без падения', () => {
    for (const ecc of ['L', 'M', 'Q', 'H'] as const) {
      const m = encodeQr('install', ecc)
      expect(isSquareBool(m)).toBe(true)
    }
  })
})

describe('qrToSvg', () => {
  it('рендерит непустой SVG с квадратами для непустой матрицы', () => {
    const svg = qrToSvg(encodeQr('marvel'))
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('<path')
    expect(svg).toContain('h1v1h-1z') // хотя бы один тёмный модуль
  })

  it('не роняет UI на пустой/битой матрице — отдаёт валидный SVG', () => {
    expect(qrToSvg([]).startsWith('<svg')).toBe(true)
    // @ts-expect-error намеренно битый ввод
    expect(qrToSvg(null).startsWith('<svg')).toBe(true)
  })

  it('уважает кастомные цвета темы', () => {
    const svg = qrToSvg(encodeQr('x'), { dark: '#1b7f5a', light: '#101010' })
    expect(svg).toContain('#1b7f5a')
    expect(svg).toContain('#101010')
  })
})
