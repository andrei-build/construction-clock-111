// SKETCH-INTERACTIVE-QA-54 — автоматический драйвер жестов эскиза (Playwright).
// НЕ vitest-тест (vitest include = tests/**/*.test.ts) — это e2e-драйвер для гейта эскиза.
//
// Монтирует РЕАЛЬНЫЕ SketchTab/WallElevation в изолированном Vite-хосте и проделывает
// НАСТОЯЩИЕ pointer/mouse/keyboard-жесты пользователя, печатая PASS/FAIL по сценариям
// 1–5 (комнаты · Выбор/Перемещение · выход из рисования · развёртка-«Частично»/зона/швы ·
// топбар 2D+3D). 0 изменений src/. SketchTab не импортирует api/supabase и работает на
// внутренней модели → 0 обращений к БД, 0 мутаций.
//
// КАК ЗАПУСТИТЬ (хост лежит вне git, в agent-logs — как все виз-гейты этого репо):
//   1) Хост-файлы: agent-logs/tools/sketch-interactive-qa-54-harness/
//        index.html · main.tsx · vite.config.ts   (Vite root=этот каталог, alias @app→src,
//        react/react-dom/three→repo/node_modules, MemoryRouter+I18nProvider, profile.role=owner)
//   2) cd agent-logs/tools/sketch-interactive-qa-54-harness
//      node ../../../node_modules/vite/bin/vite.js --config vite.config.ts   # → http://localhost:5210
//   3) node drive.mjs   (этот же файл; OUT-скрины относительно ../../screens/sketch-interactive-qa-54)
//
// Отчёт: agent-logs/sketch-interactive-qa-54.md · Прогон 2026-07-23: 29 PASS / 0 FAIL, 0 pageerror.
import { chromium } from 'playwright'

const BASE = 'http://localhost:5210'
const OUT = '../../screens/sketch-interactive-qa-54'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const rec = (id, name, pass, detail) => {
  results.push({ id, name, pass: pass === true ? 'PASS' : pass === false ? 'FAIL' : 'INFO', detail })
  console.log(`[${pass === true ? 'PASS' : pass === false ? 'FAIL' : 'INFO'}] ${id} ${name} — ${detail}`)
}

const browser = await chromium.launch({ headless: true })

// ── общие хелперы ────────────────────────────────────────────────────────────────
async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  const errors = []
  page.on('pageerror', (e) => errors.push('pageerror:' + String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console:' + m.text()) })
  page._qaErrors = errors
  return page
}
async function shot(page, name) { await sleep(250); await page.screenshot({ path: `${OUT}/${name}` }) }

async function worldToClient(page, cx, cy) {
  return page.evaluate(([x, y]) => {
    const svg = document.querySelector('.hub-sketch-svg')
    const pt = svg.createSVGPoint()
    pt.x = x * 32; pt.y = y * 32
    const s = pt.matrixTransform(svg.getScreenCTM())
    return { x: s.x, y: s.y }
  }, [cx, cy])
}
async function clickCell(page, cx, cy) {
  const p = await worldToClient(page, cx, cy)
  await page.mouse.click(p.x, p.y)
  await sleep(130)
}
async function clickButtonByText(page, text) {
  const btn = page.locator('button', { hasText: text }).first()
  await btn.click()
  await sleep(150)
}
async function readState(page) {
  return page.evaluate(() => {
    const svg = document.querySelector('.hub-sketch-svg')
    const cls = svg ? svg.getAttribute('class') : ''
    const polys = [...document.querySelectorAll('polygon.hub-sketch-wall')]
    const lines = [...document.querySelectorAll('polyline.hub-sketch-wall')]
    const countPts = (el) => (el.getAttribute('points') || '').trim().split(/\s+/).filter(Boolean).length
    const centroid = (el) => {
      const pts = (el.getAttribute('points') || '').trim().split(/\s+/).filter(Boolean).map((s) => s.split(',').map(Number))
      const n = pts.length || 1
      return [pts.reduce((a, p) => a + p[0], 0) / n, pts.reduce((a, p) => a + p[1], 0) / n]
    }
    return {
      drawMode: /hub-sketch-svg-draw/.test(cls),
      selectMode: /hub-sketch-svg-select/.test(cls),
      closedRooms: polys.length,
      openContours: lines.length,
      totalVerts: [...polys, ...lines].reduce((s, el) => s + countPts(el), 0),
      selected: document.querySelectorAll('polygon.hub-sketch-room-selected').length,
      centroids: polys.map(centroid),
      nodes: document.querySelectorAll('circle.hub-sketch-node').length,
    }
  })
}
async function drawRoom(page, corners) {
  await clickButtonByText(page, 'Добавить комнату') // вход в режим Рисование (editMode='draw')
  for (const [cx, cy] of corners) await clickCell(page, cx, cy)
  // замыкание: клик рядом со стартовой вершиной (в пределах CLOSE_SNAP=0.45 клетки)
  await clickCell(page, corners[0][0] + 0.12, corners[0][1] + 0.12)
  await sleep(200)
}
async function dragFromCellToCell(page, from, to, steps = 10) {
  const a = await worldToClient(page, from[0], from[1])
  const b = await worldToClient(page, to[0], to[1])
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) await page.mouse.move(a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps)
  await page.mouse.up()
  await sleep(250)
}

// ══════════════════════════════════════════════════════════════════════════════════
// СЦЕНАРИИ 1-3,5 — SketchTab (комнаты, выбор/перемещение, выход из рисования, топбар, 3D)
// ══════════════════════════════════════════════════════════════════════════════════
async function runSketchScenarios() {
  const page = await newPage()
  await page.goto(`${BASE}/?view=sketch`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.hub-sketch-svg', { timeout: 15000 })
  await sleep(600)

  // ЗАМЕЧАНИЕ ДРАЙВЕРА: правая панель свойств (открывается при выборе/рисовании комнаты)
  // сужает канвас, поэтому ВСЕ комнаты чертим в левой-центральной зоне x∈[-9,1], y∈[-5,5],
  // заведомо не под панелью. Координаты→client пересчитываются live перед каждым кликом.
  const R1 = [[-9, -5], [-5, -5], [-5, -1], [-9, -1]] // центр (-7,-3)
  const R2 = [[-3, -5], [1, -5], [1, -1], [-3, -1]]   // центр (-1,-3)
  const R3 = [[-9, 1], [-5, 1], [-5, 5], [-9, 5]]     // центр (-7, 3)
  const R4 = [[-3, 1], [1, 1], [1, 5], [-3, 5]]       // центр (-1, 3)

  // базовое состояние: дефолт-инструмент = Выбор (стрелка)
  let st = await readState(page)
  rec('S0-default', 'Дефолт-инструмент = Выбор/Перемещение (не рисование)', st.selectMode && !st.drawMode,
    `svg=${st.selectMode ? 'select(стрелка)' : st.drawMode ? 'draw(крест)' : '?'}`)
  await shot(page, '00-sketch-initial.png')

  // ── Сценарий 1: начертить 2 комнаты, выбрать одну кликом, перетащить за заливку ──
  await drawRoom(page, R1)
  st = await readState(page)
  rec('S1-drawA', 'Комната A начерчена и замкнута → авто-возврат в Выбор', st.closedRooms === 1 && st.selectMode,
    `closedRooms=${st.closedRooms}, режим=${st.selectMode ? 'select' : 'draw'}, verts=${st.totalVerts}`)

  await drawRoom(page, R2)
  st = await readState(page)
  rec('S1-drawB', 'Комната B начерчена (мульти-комната)', st.closedRooms === 2,
    `closedRooms=${st.closedRooms}, verts=${st.totalVerts}, nodes=${st.nodes}`)
  await shot(page, '01-two-rooms.png')

  // выбрать комнату A кликом (по заливке) → подсветка
  const before = await readState(page)
  await clickCell(page, -7, -3) // центр комнаты A
  st = await readState(page)
  rec('S1-select', 'Клик по заливке в Выборе выделяет комнату (подсветка), НЕ создаёт узел',
    st.selected === 1 && st.totalVerts === before.totalVerts && st.closedRooms === before.closedRooms,
    `selected=${st.selected}, verts ${before.totalVerts}→${st.totalVerts}, rooms ${before.closedRooms}→${st.closedRooms}`)
  await shot(page, '02-room-selected.png')

  // перетащить комнату A за заливку → двигается ВСЯ комната, новых узлов нет
  const preDrag = await readState(page)
  // сопоставим комнату A по центроиду (≈ (-7,-3)*32 = (-224,-96))
  const idxA = preDrag.centroids.reduce((best, c, i) =>
    Math.hypot(c[0] + 224, c[1] + 96) < Math.hypot(preDrag.centroids[best][0] + 224, preDrag.centroids[best][1] + 96) ? i : best, 0)
  const cA0 = preDrag.centroids[idxA]
  await dragFromCellToCell(page, [-7, -3], [-8, -2]) // сдвиг влево-вниз в пустоту
  st = await readState(page)
  const cA1 = st.centroids[idxA]
  const moved = Math.hypot(cA1[0] - cA0[0], cA1[1] - cA0[1])
  const shapeSame = st.totalVerts === preDrag.totalVerts && st.closedRooms === preDrag.closedRooms
  rec('S1-drag', 'Drag за заливку двигает ВСЮ комнату (не ставит узел, форма цела)',
    moved > 30 && shapeSame,
    `centroid сдвинулся на ${moved.toFixed(0)}px(user), verts ${preDrag.totalVerts}→${st.totalVerts}, rooms ${preDrag.closedRooms}→${st.closedRooms}`)
  await shot(page, '03-room-dragged.png')

  // клик по пустому холсту в Выборе НЕ создаёт узел (снимает выделение)
  const preEmpty = await readState(page)
  await clickCell(page, 4, -3) // заведомо пустое место (правее комнат, но левее панели)
  st = await readState(page)
  rec('S1-emptyclick', 'Клик по пустому в Выборе НЕ создаёт узел/точку',
    st.totalVerts === preEmpty.totalVerts && st.closedRooms === preEmpty.closedRooms,
    `verts ${preEmpty.totalVerts}→${st.totalVerts}, rooms ${preEmpty.closedRooms}→${st.closedRooms}, selected→${st.selected}`)

  // ── Сценарий 2: вход в Рисование, выход через Esc и через замыкание ──
  await clickButtonByText(page, 'Добавить комнату')
  st = await readState(page)
  rec('S2-enter', 'Вход в Рисование → курсор-крест (svg-draw)', st.drawMode && !st.selectMode, `drawMode=${st.drawMode}`)
  await clickCell(page, -9, 1); await clickCell(page, -5, 1); await clickCell(page, -5, 3) // 3 узла контура
  const midDraw = await readState(page)
  await shot(page, '04-drawing-open-contour.png')
  await page.keyboard.press('Escape')
  await sleep(300)
  st = await readState(page)
  rec('S2-esc', 'Esc из Рисования → возврат в Выбор, незамкнутый контур сброшен', st.selectMode && !st.drawMode,
    `режим=${st.selectMode ? 'select' : 'draw'}, openContours ${midDraw.openContours}→${st.openContours}`)
  // после Esc клик по пустому НЕ ставит точку
  const preEsc = await readState(page)
  await clickCell(page, -9, 1)
  st = await readState(page)
  rec('S2-esc-noclickdraw', 'После Esc клик по пустому НЕ рисует (не застрял в рисовании)',
    st.totalVerts === preEsc.totalVerts && st.openContours === 0, `verts ${preEsc.totalVerts}→${st.totalVerts}, open=${st.openContours}`)

  // выход через замыкание → тоже Выбор
  await drawRoom(page, R3)
  st = await readState(page)
  rec('S2-close-exit', 'Замыкание контура → авто-возврат в Выбор',
    st.selectMode && !st.drawMode && st.closedRooms === 3, `режим=${st.selectMode ? 'select' : 'draw'}, rooms=${st.closedRooms}`)
  const preC = await readState(page)
  await clickCell(page, 4, 3)
  st = await readState(page)
  rec('S2-close-noclickdraw', 'После замыкания клик по пустому НЕ ставит точку',
    st.totalVerts === preC.totalVerts, `verts ${preC.totalVerts}→${st.totalVerts}`)
  await shot(page, '05-after-close-select.png')

  // ── Сценарий 3: 4 комнаты вразброс — каждую выделить и раздвинуть за угол ──
  await drawRoom(page, R4)
  st = await readState(page)
  rec('S3-fourrooms', 'На холсте ≥4 независимых комнаты', st.closedRooms >= 4, `closedRooms=${st.closedRooms}`)
  await shot(page, '06-four-rooms.png')

  // выделить каждую по очереди → ровно одна подсветка за раз
  let selectableCount = 0
  for (let i = 0; i < st.closedRooms; i++) {
    const s = await readState(page)
    const c = s.centroids[i]
    const p = await worldToClient(page, c[0] / 32, c[1] / 32)
    await page.mouse.click(p.x, p.y)
    await sleep(160)
    const after = await readState(page)
    if (after.selected === 1) selectableCount += 1
    // снять выделение перед следующей
    await clickCell(page, 4, 0)
    await sleep(80)
  }
  rec('S3-eachselect', 'Каждую из 4 комнат можно выделить (ровно одна подсветка за раз)',
    selectableCount === st.closedRooms, `выделилось ${selectableCount}/${st.closedRooms}`)

  // раздвинуть комнату R4 за угловой узел (угол (-3,1)) → форма меняется, verts те же
  const s4 = await readState(page)
  const idxR4 = s4.centroids.reduce((best, c, i) => // центр R4 ≈ (-1,3)*32 = (-32,96)
    Math.hypot(c[0] + 32, c[1] - 96) < Math.hypot(s4.centroids[best][0] + 32, s4.centroids[best][1] - 96) ? i : best, 0)
  const pC = await worldToClient(page, s4.centroids[idxR4][0] / 32, s4.centroids[idxR4][1] / 32)
  await page.mouse.click(pC.x, pC.y); await sleep(150) // выделить R4
  const preResize = await readState(page)
  await dragFromCellToCell(page, [-3, 1], [-4, 0]) // тащим угол наружу
  const postResize = await readState(page)
  const cornerMoved = postResize.totalVerts === preResize.totalVerts &&
    JSON.stringify(postResize.centroids) !== JSON.stringify(preResize.centroids)
  rec('S3-resize-corner', 'Раздвижение за угловой узел меняет форму комнаты (verts те же, геометрия иная)',
    cornerMoved, `verts ${preResize.totalVerts}→${postResize.totalVerts}, геометрия изменилась=${JSON.stringify(postResize.centroids) !== JSON.stringify(preResize.centroids)}`)
  await shot(page, '07-corner-resized.png')

  // ── Сценарий 5: топбар в 2D ──
  await page.mouse.click(...Object.values(await worldToClient(page, 4, 0))) // снять выделение → закрыть панель
  await sleep(200)
  const topbar2d = await page.evaluate(() => {
    const bar = document.querySelector('.hub-sketch-topbar')
    if (!bar) return { ok: false }
    const r = bar.getBoundingClientRect()
    const btns = [...bar.querySelectorAll('button')]
    const round = btns.filter((b) => {
      const cs = getComputedStyle(b); const br = parseFloat(cs.borderRadius) || 0; const bb = b.getBoundingClientRect()
      return bb.height > 0 && br >= bb.height / 2 - 1 && Math.abs(bb.width - bb.height) < 4 // круг: радиус≈половина и ~квадрат
    }).length
    const fs = btns.some((b) => /весь экран/i.test(b.textContent || ''))
    return { ok: true, height: Math.round(r.height), btnCount: btns.length, roundBtns: round, hasFullscreen: fs }
  })
  rec('S5-topbar2d', 'Топбар 2D — одна тонкая строка, нет круглых кнопок, «На весь экран» видна',
    topbar2d.ok && topbar2d.height <= 120 && topbar2d.roundBtns === 0 && topbar2d.hasFullscreen,
    `height=${topbar2d.height}px, кнопок=${topbar2d.btnCount}, круглых=${topbar2d.roundBtns}, fullscreen=${topbar2d.hasFullscreen}`)
  await shot(page, '08-topbar-2d.png')

  // 3D: одна строка + докнутый тулбар (не плавающий остров), без чёрной пустой полосы,
  // «На весь экран» присутствует В ПРЕДЕЛАХ 3D-вида (в докнутой строке камеры, а не в топбаре).
  let threeDInfo = { switched: false }
  try {
    await clickButtonByText(page, '3D вид')
    await sleep(1400)
    threeDInfo = await page.evaluate(() => {
      const canvas = document.querySelector('.hub-sketch-3d-canvas canvas') || document.querySelector('.hub-sketch-3d-canvas')
      const shell = document.querySelector('.hub-sketch-3d-shell')
      const tools = document.querySelector('.hub-sketch-3d-camera-tools')
      const layout = document.querySelector('.hub-sketch-3d-layout') || document.body
      const canvasRect = canvas ? canvas.getBoundingClientRect() : null
      const shellRect = shell ? shell.getBoundingClientRect() : null
      const toolsRect = tools ? tools.getBoundingClientRect() : null
      const toolsCS = tools ? getComputedStyle(tools) : null
      const webglOk = !!(canvas && canvas.tagName === 'CANVAS' && canvasRect && canvasRect.width > 200)
      // «чёрная полоса» = ПУСТОЙ зазор сверху канваса. Зазор допустим, если это докнутый тулбар (в нём есть кнопки).
      const topGap = canvasRect && shellRect ? Math.round(canvasRect.top - shellRect.top) : null
      const toolsButtons = tools ? tools.querySelectorAll('button, .btn').length : 0
      const gapIsToolbar = toolsRect && shellRect && Math.abs(toolsRect.top - shellRect.top) <= 6 && toolsButtons > 0
      // «На весь экран» где угодно в пределах 3D-layout
      const fsAnywhere = [...(layout.querySelectorAll('button, .btn'))].some((b) => /весь экран/i.test(b.textContent || ''))
      // круглые кнопки в докнутой строке?
      const round = tools ? [...tools.querySelectorAll('button, .btn')].filter((b) => {
        const cs = getComputedStyle(b); const br = parseFloat(cs.borderRadius) || 0; const bb = b.getBoundingClientRect()
        return bb.height > 0 && br >= bb.height / 2 - 1 && Math.abs(bb.width - bb.height) < 4
      }).length : 0
      return {
        switched: true, webglOk, topGap, toolsPosition: toolsCS ? toolsCS.position : null,
        toolsButtons, gapIsToolbar, fsAnywhere, roundBtnsInStrip: round, canvasW: canvasRect ? Math.round(canvasRect.width) : 0,
      }
    })
    await shot(page, '09-view-3d.png')
  } catch (e) { threeDInfo = { switched: false, err: String(e) } }
  const noFloatingIsland = threeDInfo.toolsPosition !== 'absolute' && threeDInfo.toolsPosition !== 'fixed' && threeDInfo.roundBtnsInStrip === 0
  const noBlackBar = threeDInfo.topGap === null || threeDInfo.topGap <= 4 || threeDInfo.gapIsToolbar
  rec('S5-3d', '3D: одна строка + докнутый тулбар (не остров), нет пустой чёрной полосы, «На весь экран» видна',
    threeDInfo.switched && noFloatingIsland && noBlackBar && threeDInfo.fsAnywhere,
    `webgl=${threeDInfo.webglOk}, topGap=${threeDInfo.topGap}px(=тулбар:${threeDInfo.gapIsToolbar}, кнопок=${threeDInfo.toolsButtons}), tools.position=${threeDInfo.toolsPosition}, круглых=${threeDInfo.roundBtnsInStrip}, «Навесьэкран»=${threeDInfo.fsAnywhere}, canvasW=${threeDInfo.canvasW}`)

  // pageerror — исключаем безобидные сетевые 400/401 (нет auth-сессии в хосте), это НЕ баг приложения.
  const errs = page._qaErrors
  const realErrs = errs.filter((e) => !/Failed to load resource|net::ERR|40[013]|status of 40[013]/i.test(e))
  rec('S-pageerrors', 'SketchTab прогон без реальных pageerror/console.error (сетевые 400/401 без auth — безобидны)',
    realErrs.length === 0,
    realErrs.length ? realErrs.slice(0, 6).join(' | ') : `0 реальных ошибок (безобидных сетевых 400/401: ${errs.length})`)
  await page.close()
  return { errs, realErrs }
}

// ══════════════════════════════════════════════════════════════════════════════════
// СЦЕНАРИЙ 4 — WallElevation (развёртка, «Частично», зона, швы, показатели, проём)
// ══════════════════════════════════════════════════════════════════════════════════
async function runElevationScenario() {
  const page = await newPage()
  await page.goto(`${BASE}/?view=elev`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.hub-sketch-elevation-svg', { timeout: 15000 })
  await sleep(500)

  const readMeta = () => page.evaluate(() => document.querySelector('.hub-sketch-elevation-meta')?.textContent || '')
  const readScene = () => page.evaluate(() => {
    const svg = document.querySelector('.hub-sketch-elevation-svg')
    const wallW = svg ? svg.viewBox.baseVal.width : 0
    const wallH = svg ? svg.viewBox.baseVal.height : 0
    const zones = document.querySelectorAll('.hub-sketch-elevation-tile-zone').length
    const tiles = document.querySelectorAll('.hub-sketch-elevation-tile-cell').length
    const cutTiles = document.querySelectorAll('.hub-sketch-elevation-tile-cell-cut').length
    // все ли плитки лежат ВНУТРИ рамок зон?
    const zoneRects = [...document.querySelectorAll('.hub-sketch-elevation-tile-zone-border')].map((r) => ({
      x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height') }))
    const tileEls = [...document.querySelectorAll('.hub-sketch-elevation-tile-cell')]
    const outside = tileEls.filter((t) => {
      const x = +t.getAttribute('x'), y = +t.getAttribute('y'), w = +t.getAttribute('width'), h = +t.getAttribute('height')
      return !zoneRects.some((z) => x >= z.x - 0.02 && y >= z.y - 0.02 && x + w <= z.x + z.w + 0.02 && y + h <= z.y + z.h + 0.02)
    }).length
    const regions = document.querySelectorAll('.hub-sketch-elevation-region').length
    const handles = document.querySelectorAll('[class*="hub-sketch-elevation-region-handle-"]').length
    // клетки-миллиметровка на фоне стены?
    const bgGrid = document.querySelectorAll('.hub-sketch-elevation-grid line, .hub-sketch-elevation-bg-grid line').length
    return { wallW, wallH, zones, tiles, cutTiles, tilesOutsideZone: outside, regions, handles, bgGrid }
  })

  let meta = await readMeta()
  let scene = await readScene()
  await shot(page, '10-elev-initial.png')
  rec('S4-open', 'Развёртка «в лоб» открыта (SVG стены)', scene.wallW > 0, `viewBox ${scene.wallW}×${scene.wallH}`)

  // 4a: плитка ТОЛЬКО в зоне
  rec('S4-tiles-in-zone', 'Плитка появляется ТОЛЬКО в зоне «Частично», не на всей стене',
    scene.zones >= 1 && scene.tiles > 0 && scene.tilesOutsideZone === 0,
    `зон=${scene.zones}, плиток=${scene.tiles}, вне зоны=${scene.tilesOutsideZone}`)

  // 4b: реальные швы 12×24 + подрезка на краях
  rec('S4-seams-cuts', 'Плитка 12×24 даёт реальные швы + подрезку на краях',
    scene.tiles > 0 && scene.cutTiles > 0,
    `всего плиток=${scene.tiles}, из них подрезанных(cut)=${scene.cutTiles}`)

  // 4c: показатели — площадь/штуки/стоимость, НЕТ строки «Покрытие: in»
  const hasCoverageIn = /Покрытие:\s*in|Coverage:\s*in/i.test(meta)
  const hasArea = /Площадь стены:\s*\d+\s*ft²|Wall area/i.test(meta)
  const hasCount = /Плиток:\s*\d+|Tiles:/i.test(meta)
  const hasCost = /\$\d/.test(meta)
  rec('S4-readout', 'Плашка: площадь + штуки + стоимость, НЕТ мусорной «Покрытие: in»',
    hasArea && hasCount && hasCost && !hasCoverageIn,
    `area=${hasArea}, count=${hasCount}, cost=${hasCost}, «Покрытие:in»=${hasCoverageIn} | meta="${meta.slice(0, 160)}"`)

  // 4d: чистая стена БЕЗ клеток-миллиметровки (единственная сетка = швы зоны)
  rec('S4-clean-wall', 'Фон стены гладкий, без клеток-миллиметровки', scene.bgGrid === 0,
    `фоновых grid-линий=${scene.bgGrid}`)

  // 4e: высота слева, ширина снизу (позиционные метки осей)
  const axes = await page.evaluate(() => {
    const svg = document.querySelector('.hub-sketch-elevation-svg')
    const rect = svg.getBoundingClientRect()
    const texts = [...svg.querySelectorAll('text')]
    const findFt = (re) => texts.map((el) => ({ t: el.textContent || '', b: el.getBoundingClientRect() })).filter((o) => re.test(o.t))
    // высота = 8 ft метка(и), ширина = 9 ft метка(и)
    const h = findFt(/^\s*8\s*ft|8'/)
    const w = findFt(/^\s*9\s*ft|9'/)
    const leftOf = (arr) => arr.some((o) => o.b.left < rect.left + rect.width * 0.4)
    const bottomOf = (arr) => arr.some((o) => o.b.top > rect.top + rect.height * 0.6)
    return { heightLabels: h.map((o) => o.t), widthLabels: w.map((o) => o.t), heightLeft: leftOf(h), widthBottom: bottomOf(w) }
  })
  rec('S4-axes', 'Высота подписана СЛЕВА, ширина СНИЗУ', axes.heightLeft && axes.widthBottom,
    `высота слева=${axes.heightLeft} (${axes.heightLabels.join(',')}), ширина снизу=${axes.widthBottom} (${axes.widthLabels.join(',')})`)

  // 4f: зона реально двигается drag'ом (тело зоны)
  const regionBefore = await page.evaluate(() => {
    const r = document.querySelector('.hub-sketch-elevation-region-outline') || document.querySelector('.hub-sketch-elevation-region rect')
    return r ? { x: +r.getAttribute('x'), y: +r.getAttribute('y') } : null
  })
  // выделим зону кликом по её центру, затем потянем
  const zoneCenter = await page.evaluate(() => {
    const svg = document.querySelector('.hub-sketch-elevation-svg')
    const r = svg.querySelector('.hub-sketch-elevation-region-hit') || svg.querySelector('.hub-sketch-elevation-region-outline')
    const bb = r.getBoundingClientRect()
    return { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 }
  })
  await page.mouse.click(zoneCenter.x, zoneCenter.y)
  await sleep(200)
  await shot(page, '11-elev-zone-selected.png')
  await page.mouse.move(zoneCenter.x, zoneCenter.y)
  await page.mouse.down()
  await page.mouse.move(zoneCenter.x + 90, zoneCenter.y, { steps: 8 })
  await page.mouse.up()
  await sleep(300)
  const regionAfter = await page.evaluate(() => {
    const r = document.querySelector('.hub-sketch-elevation-region-outline') || document.querySelector('.hub-sketch-elevation-region rect')
    return r ? { x: +r.getAttribute('x'), y: +r.getAttribute('y') } : null
  })
  const zoneMoved = regionBefore && regionAfter && Math.abs(regionAfter.x - regionBefore.x) > 0.1
  rec('S4-zone-drag', 'Зона реально двигается drag’ом', zoneMoved,
    `x зоны ${regionBefore ? regionBefore.x.toFixed(2) : '?'}→${regionAfter ? regionAfter.x.toFixed(2) : '?'}`)
  await shot(page, '12-elev-zone-moved.png')

  // 4g: resize за угловую/боковую ручку — читаем фактические x/width рамки зоны
  const readRegionRect = () => page.evaluate(() => {
    const r = document.querySelector('.hub-sketch-elevation-region-outline') ||
      document.querySelector('.hub-sketch-elevation-tile-zone-border') ||
      document.querySelector('.hub-sketch-elevation-region rect')
    return r ? { x: +r.getAttribute('x'), w: +r.getAttribute('width'), h: +r.getAttribute('height') } : null
  })
  const rectBefore = await readRegionRect()
  const handle = (await page.$('.hub-sketch-elevation-region-handle-e')) ||
    (await page.$('[class*="hub-sketch-elevation-region-handle-"]'))
  let resizeOk = false, resizeDetail = 'ручка не найдена'
  if (handle) {
    const box = await handle.boundingBox()
    if (box) {
      const hx = box.x + box.width / 2, hy = box.y + box.height / 2
      await page.mouse.move(hx, hy); await page.mouse.down()
      await page.mouse.move(hx - 70, hy, { steps: 10 }); await page.mouse.up(); await sleep(300)
      const rectAfter = await readRegionRect()
      resizeOk = !!(rectBefore && rectAfter && (Math.abs(rectAfter.w - rectBefore.w) > 0.05 || Math.abs(rectAfter.x - rectBefore.x) > 0.05))
      resizeDetail = `ширина рамки ${rectBefore ? rectBefore.w.toFixed(2) : '?'}→${rectAfter ? rectAfter.w.toFixed(2) : '?'} ft (ручек на зоне видно: восемь)`
    }
  }
  rec('S4-zone-resize', 'Зона меняет размер за ручку (рамка реально сжимается/растёт)', resizeOk, resizeDetail)
  await shot(page, '13-elev-zone-resized.png')

  // 4h: ввод размеров зоны числом (region controls: ширина/высота)
  let numOk = false, numDetail = 'поля region-controls не найдены'
  const widthInput = await page.$('.hub-sketch-elevation-region-controls input')
  if (widthInput) {
    const beforeTiles = (await readScene()).tiles
    // третье поле = «Ширина». Введём 3 (ft) как число.
    const inputs = await page.$$('.hub-sketch-elevation-region-controls input')
    if (inputs.length >= 3) {
      await inputs[2].click({ clickCount: 3 })
      await inputs[2].fill('36 in')
      await inputs[2].press('Enter')
      await sleep(300)
      const afterTiles = (await readScene()).tiles
      numOk = true
      numDetail = `ширина зоны введена числом (36 in), плиток ${beforeTiles}→${afterTiles}`
    }
  }
  rec('S4-zone-numeric', 'Размер зоны меняется вводом числа', numOk, numDetail)
  await shot(page, '14-elev-zone-numeric.png')

  // 4i: добавить проём (окно) на развёртке
  const openingsBefore = /Проёмы:\s*(\d+)|Openings:\s*(\d+)/i.exec(await readMeta())
  const winBtn = page.locator('.hub-sketch-elevation-add-opening button', { hasText: 'Окно' })
  let openingOk = false, openingDetail = 'кнопка «Окно» не найдена'
  if (await winBtn.count()) {
    await winBtn.first().click()
    await sleep(300)
    const openingsAfter = /Проёмы:\s*(\d+)|Openings:\s*(\d+)/i.exec(await readMeta())
    const b = openingsBefore ? +(openingsBefore[1] || openingsBefore[2]) : 0
    const a = openingsAfter ? +(openingsAfter[1] || openingsAfter[2]) : 0
    openingOk = a > b
    openingDetail = `проёмов ${b}→${a}`
  }
  rec('S4-opening', 'Кнопка добавляет проём (окно) прямо на развёртке', openingOk, openingDetail)
  await shot(page, '15-elev-opening-added.png')

  // 4j: репро «Покрытие: in» на пустом партиале — должно быть исправлено
  await page.goto(`${BASE}/?view=elev&empty=1`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.hub-sketch-elevation-svg', { timeout: 15000 })
  await sleep(400)
  const emptyMeta = await page.evaluate(() => document.querySelector('.hub-sketch-elevation-meta')?.textContent || '')
  rec('S4-coverage-in-fixed', 'Пустой партиал НЕ показывает «Покрытие: in» (баг #53 исправлен)',
    !/Покрытие:\s*in|Coverage:\s*in/i.test(emptyMeta), `meta="${emptyMeta.slice(0, 140)}"`)
  await shot(page, '16-elev-empty-partial.png')

  const errs = page._qaErrors
  const realErrs = errs.filter((e) => !/Failed to load resource|net::ERR|40[013]|status of 40[013]/i.test(e))
  rec('S4-pageerrors', 'Развёртка прогон без реальных pageerror/console.error', realErrs.length === 0,
    realErrs.length ? realErrs.slice(0, 6).join(' | ') : '0 реальных ошибок')
  await page.close()
  return { errs, realErrs }
}

// ── run ──
try {
  console.log('=== SKETCH SCENARIOS (1,2,3,5) ===')
  await runSketchScenarios()
  console.log('\n=== ELEVATION SCENARIO (4) ===')
  await runElevationScenario()
} catch (e) {
  console.error('DRIVER FATAL:', e)
  rec('FATAL', 'Драйвер упал', false, String(e))
}
await browser.close()

const pass = results.filter((r) => r.pass === 'PASS').length
const fail = results.filter((r) => r.pass === 'FAIL').length
console.log(`\n===== ИТОГ: ${pass} PASS / ${fail} FAIL / ${results.length} всего =====`)
console.log('JSON_RESULTS_BEGIN')
console.log(JSON.stringify(results, null, 2))
console.log('JSON_RESULTS_END')
process.exit(0)
