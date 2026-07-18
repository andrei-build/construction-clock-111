import { useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../../lib/i18n'
import {
  DEFAULT_FLOOR_PAINT,
  DEFAULT_GROUT_COLOR,
  DEFAULT_GROUT_IN,
  DEFAULT_TILE_COLOR,
  DEFAULT_WALL_PAINT,
  TILE_SIZE_OPTIONS,
  WALL_PAINT_SWATCHES,
  calculateTileCuts,
  cleanColor,
  createTilePatternCanvas,
  formatInches,
  normalizeFinishes,
  normalizeTileSurface,
  type Pt,
  type Sketch3DModel,
  type SketchLight,
  type SketchLightKind,
  type SketchSurfaceFinish,
  type SketchSwitch,
  type SketchTileFinish,
} from './sketchFinishes'

const CELL_FT = 1
const DEFAULT_WALL_HEIGHT_FT = 8
const WALL_THICKNESS_FT = 0.5
const DOOR_W_FT = 3
const DOOR_H_FT = 6.8
const WIN_W_FT = 3
const WIN_H_FT = 4
const WIN_SILL_FT = 3
const DEFAULT_SWITCH_HEIGHT_FT = 4
const DEFAULT_SCONCE_HEIGHT_FT = 5.6

type SurfaceTarget = 'walls' | 'floor'
type PlacementKind = SketchLightKind | 'switch' | null
type Segment = { c: number; s: number; a: Pt; b: Pt }
type CameraPreset = 'fit' | 'top' | 'angle'

interface Sketch3DViewProps {
  model: Sketch3DModel
  heightFt: number
  canEdit?: boolean
  onModelChange?: (model: Sketch3DModel) => void
  label: string
  loadingLabel: string
  errorLabel: string
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function openingWidthFt(o: Sketch3DModel['openings'][number]): number {
  return o.w ?? (o.kind === 'door' ? DOOR_W_FT : WIN_W_FT)
}

function modelCellFt(model: Sketch3DModel): number {
  return Number.isFinite(model.cellFt) && model.cellFt > 0 ? model.cellFt : CELL_FT
}

function openingEnds(model: Sketch3DModel, o: Sketch3DModel['openings'][number]): { a: Pt; b: Pt } | null {
  const c = model.contours[o.c]
  if (!c) return null
  const a = c.points[o.s]
  const b = o.s + 1 < c.points.length ? c.points[o.s + 1] : (c.closed ? c.points[0] : null)
  if (!a || !b) return null
  return { a, b }
}

function eachSegment(model: Sketch3DModel): Segment[] {
  const out: Segment[] = []
  model.contours.forEach((cont, c) => {
    for (let s = 0; s < cont.points.length - 1; s++) out.push({ c, s, a: cont.points[s], b: cont.points[s + 1] })
    if (cont.closed && cont.points.length >= 3) out.push({ c, s: cont.points.length - 1, a: cont.points[cont.points.length - 1], b: cont.points[0] })
  })
  return out
}

function modelBounds(model: Sketch3DModel): { minX: number; maxX: number; minZ: number; maxZ: number; width: number; depth: number } {
  const cellFt = modelCellFt(model)
  const points = model.contours.flatMap((c) => c.points)
  if (points.length === 0) return { minX: -6, maxX: 6, minZ: -5, maxZ: 5, width: 12, depth: 10 }
  const xs = points.map((p) => p.x * cellFt)
  const zs = points.map((p) => p.y * cellFt)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minZ = Math.min(...zs)
  const maxZ = Math.max(...zs)
  return {
    minX,
    maxX,
    minZ,
    maxZ,
    width: Math.max(maxX - minX, 1),
    depth: Math.max(maxZ - minZ, 1),
  }
}

function segmentWorld(model: Sketch3DModel, c: number, s: number): Segment | null {
  const contour = model.contours[c]
  if (!contour) return null
  const a = contour.points[s]
  const b = s + 1 < contour.points.length ? contour.points[s + 1] : (contour.closed ? contour.points[0] : null)
  if (!a || !b) return null
  return { c, s, a, b }
}

function wallAnchor(model: Sketch3DModel, c: number, s: number, t: number, yFt: number) {
  const seg = segmentWorld(model, c, s)
  if (!seg) return null
  const cellFt = modelCellFt(model)
  const ax = seg.a.x * cellFt
  const az = seg.a.y * cellFt
  const bx = seg.b.x * cellFt
  const bz = seg.b.y * cellFt
  const dx = bx - ax
  const dz = bz - az
  const len = Math.hypot(dx, dz)
  if (len <= 0.01) return null
  const clampedT = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0.5))
  const ux = dx / len
  const uz = dz / len
  return {
    x: ax + dx * clampedT,
    y: yFt,
    z: az + dz * clampedT,
    ux,
    uz,
    nx: -uz,
    nz: ux,
    rotationY: -Math.atan2(uz, ux),
  }
}

function projectWallT(model: Sketch3DModel, c: number, s: number, point: { x: number; z: number }): number {
  const seg = segmentWorld(model, c, s)
  if (!seg) return 0.5
  const cellFt = modelCellFt(model)
  const ax = seg.a.x * cellFt
  const az = seg.a.y * cellFt
  const bx = seg.b.x * cellFt
  const bz = seg.b.y * cellFt
  const dx = bx - ax
  const dz = bz - az
  const len2 = dx * dx + dz * dz
  if (len2 <= 0.001) return 0.5
  return Math.max(0, Math.min(1, ((point.x - ax) * dx + (point.z - az) * dz) / len2))
}

function longestWallIn(model: Sketch3DModel): number {
  const cellFt = modelCellFt(model)
  return Math.max(12, ...eachSegment(model).map((seg) => dist(seg.a, seg.b) * cellFt * 12))
}

function disposeObjectWithMaterial(object: { geometry?: unknown; material?: unknown }) {
  const geometry = object.geometry
  if (geometry && typeof geometry === 'object' && 'dispose' in geometry) {
    ;(geometry as { dispose: () => void }).dispose()
  }
  const disposeTexture = (texture: unknown) => {
    if (texture && typeof texture === 'object' && 'dispose' in texture) {
      ;(texture as { dispose: () => void }).dispose()
    }
  }
  const disposeMaterial = (material: unknown) => {
    if (Array.isArray(material)) {
      material.forEach(disposeMaterial)
      return
    }
    if (material && typeof material === 'object') {
      disposeTexture((material as { map?: unknown }).map)
      disposeTexture((material as { emissiveMap?: unknown }).emissiveMap)
      if ('dispose' in material) (material as { dispose: () => void }).dispose()
    }
  }
  disposeMaterial(object.material)
}

function loadThreeRuntime(): Promise<[any, { OrbitControls: any }]> {
  return Promise.all([
    // @ts-expect-error three is intentionally pinned without adding @types/three.
    import('three'),
    // @ts-expect-error OrbitControls is loaded only with the 3D view.
    import('three/examples/jsm/controls/OrbitControls.js'),
  ])
}

function makeId(prefix: string): string {
  const maybeCrypto = typeof crypto !== 'undefined' ? crypto : undefined
  const uuid = maybeCrypto && 'randomUUID' in maybeCrypto ? maybeCrypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${uuid}`
}

function tilePitch(surface: SketchSurfaceFinish | undefined): { x: number; y: number; tile: SketchTileFinish } {
  const tile = normalizeTileSurface(surface)
  return {
    x: Math.max(0.01, (tile.tileWIn ?? 12) + (tile.groutIn ?? DEFAULT_GROUT_IN)),
    y: Math.max(0.01, (tile.tileHIn ?? 24) + (tile.groutIn ?? DEFAULT_GROUT_IN)),
    tile,
  }
}

function createTileTexture(THREE: any, surface: SketchSurfaceFinish | undefined) {
  const texture = new THREE.CanvasTexture(createTilePatternCanvas(surface))
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

function createWallMaterial(THREE: any, surface: SketchSurfaceFinish, widthFt: number, heightFt: number) {
  if (surface.kind !== 'tile') {
    return new THREE.MeshStandardMaterial({ color: cleanColor(surface.color, DEFAULT_WALL_PAINT), roughness: 0.72 })
  }
  const texture = createTileTexture(THREE, surface)
  const { x, y, tile } = tilePitch(surface)
  texture.repeat.set((widthFt * 12) / x, (heightFt * 12) / y)
  texture.offset.set((tile.offsetXIn ?? 0) / x, (tile.offsetYIn ?? 0) / y)
  return new THREE.MeshStandardMaterial({ color: 0xffffff, map: texture, roughness: 0.78 })
}

function createFloorMaterial(THREE: any, surface: SketchSurfaceFinish) {
  if (surface.kind !== 'tile') {
    return new THREE.MeshStandardMaterial({ color: cleanColor(surface.color, DEFAULT_FLOOR_PAINT), roughness: 0.82, side: THREE.DoubleSide })
  }
  const texture = createTileTexture(THREE, surface)
  return new THREE.MeshStandardMaterial({ color: 0xffffff, map: texture, roughness: 0.82, side: THREE.DoubleSide })
}

function applyFloorTileUv(geometry: any, surface: SketchSurfaceFinish) {
  if (surface.kind !== 'tile' || !geometry.attributes?.position || !geometry.attributes?.uv) return
  const { x, y, tile } = tilePitch(surface)
  const pos = geometry.attributes.position
  const uv = geometry.attributes.uv
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, ((pos.getX(i) * 12) + (tile.offsetXIn ?? 0)) / x, ((pos.getY(i) * 12) + (tile.offsetYIn ?? 0)) / y)
  }
  uv.needsUpdate = true
}

function tagInteractive(object: any, type: 'light' | 'switch', id: string) {
  object.traverse?.((child: any) => {
    child.userData.itemType = type
    child.userData.itemId = id
  })
  object.userData.itemType = type
  object.userData.itemId = id
}

function taggedObject(object: any): { type: 'light' | 'switch'; id: string } | null {
  let cur = object
  while (cur) {
    if ((cur.userData?.itemType === 'light' || cur.userData?.itemType === 'switch') && typeof cur.userData?.itemId === 'string') {
      return { type: cur.userData.itemType, id: cur.userData.itemId }
    }
    cur = cur.parent
  }
  return null
}

function taggedWall(object: any): { c: number; s: number } | null {
  let cur = object
  while (cur) {
    if (Number.isInteger(cur.userData?.wallC) && Number.isInteger(cur.userData?.wallS)) {
      return { c: cur.userData.wallC, s: cur.userData.wallS }
    }
    cur = cur.parent
  }
  return null
}

function lightKindLabel(t: (k: string) => string, kind: SketchLightKind): string {
  return t(`hub_sketch_3d_light_${kind}`)
}

function lightName(light: SketchLight, index: number, t: (k: string) => string): string {
  return light.name?.trim() || `${lightKindLabel(t, light.kind)} ${index + 1}`
}

function switchName(sw: SketchSwitch, index: number, t: (k: string) => string): string {
  return sw.label?.trim() || `${t('hub_sketch_3d_switch')} ${index + 1}`
}

function createLabelSprite(THREE: any, text: string) {
  const lines = text.split('\n')
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  canvas.width = 512
  canvas.height = Math.max(128, 54 + lines.length * 34)
  if (ctx) {
    ctx.font = '700 26px sans-serif'
    const widest = Math.max(...lines.map((line) => ctx.measureText(line).width), 180)
    canvas.width = Math.min(768, Math.max(320, Math.ceil(widest + 56)))
    ctx.fillStyle = 'rgba(15, 23, 42, .88)'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.strokeStyle = 'rgba(255, 255, 255, .28)'
    ctx.lineWidth = 3
    ctx.strokeRect(1.5, 1.5, canvas.width - 3, canvas.height - 3)
    ctx.fillStyle = '#ffffff'
    ctx.font = '700 26px sans-serif'
    lines.forEach((line, i) => ctx.fillText(line, 28, 42 + i * 34))
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false })
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(canvas.width / 120, canvas.height / 120, 1)
  sprite.renderOrder = 20
  return sprite
}

export default function Sketch3DView({ model, heightFt, canEdit = false, onModelChange, label, loadingLabel, errorLabel }: Sketch3DViewProps) {
  const { t } = useI18n()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const cameraApiRef = useRef<Record<CameraPreset, () => void> | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [surfaceTarget, setSurfaceTarget] = useState<SurfaceTarget>('walls')
  const [placement, setPlacement] = useState<PlacementKind>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const finishes = useMemo(() => normalizeFinishes(model.finishes), [model.finishes])
  const lights = useMemo(() => model.lights ?? [], [model.lights])
  const switches = useMemo(() => model.switches ?? [], [model.switches])
  const selectedLight = lights.find((light) => light.id === selectedId) ?? null
  const selectedSwitch = switches.find((sw) => sw.id === selectedId) ?? null
  const activeSurface = finishes[surfaceTarget]
  const boundsForCuts = modelBounds(model)
  const surfaceHeightIn = surfaceTarget === 'walls' ? Math.max(1, heightFt * 12) : Math.max(12, boundsForCuts.depth * 12)
  const surfaceWidthIn = surfaceTarget === 'walls' ? longestWallIn(model) : Math.max(12, boundsForCuts.width * 12)
  const cutSummary = activeSurface.kind === 'tile' ? calculateTileCuts(activeSurface, surfaceHeightIn, surfaceWidthIn) : null

  const applyModel = (next: Sketch3DModel) => {
    if (!canEdit) return
    onModelChange?.(next)
  }

  const updateSurface = (surface: SketchSurfaceFinish) => {
    const nextFinishes = normalizeFinishes(model.finishes)
    const next = { ...nextFinishes, [surfaceTarget]: surface }
    if (surfaceTarget === 'walls' && surface.kind === 'paint') next.wallPaint = cleanColor(surface.color, DEFAULT_WALL_PAINT)
    applyModel({ ...model, finishes: next })
  }

  const updateWallPaint = (color: string) => {
    const clean = cleanColor(color, DEFAULT_WALL_PAINT)
    const nextFinishes = normalizeFinishes(model.finishes)
    const nextWalls = nextFinishes.walls.kind === 'paint' ? { kind: 'paint' as const, color: clean } : nextFinishes.walls
    applyModel({ ...model, finishes: { ...nextFinishes, wallPaint: clean, walls: nextWalls } })
  }

  const updateTile = (patch: Partial<SketchTileFinish>) => {
    const tile = normalizeTileSurface(activeSurface)
    updateSurface({ ...tile, ...patch, kind: 'tile' })
  }

  const addLightAt = (kind: SketchLightKind, xFt: number, zFt: number): SketchLight => ({
    id: makeId('light'),
    kind,
    name: `${lightKindLabel(t, kind)} ${lights.length + 1}`,
    xFt,
    zFt,
  })

  const removeSelected = () => {
    if (!selectedId) return
    applyModel({
      ...model,
      lights: lights.filter((light) => light.id !== selectedId),
      switches: switches
        .filter((sw) => sw.id !== selectedId)
        .map((sw) => ({ ...sw, controls: (sw.controls ?? []).filter((id) => id !== selectedId) })),
    })
    setSelectedId(null)
  }

  const updateSwitchControls = (switchId: string, lightId: string, checked: boolean) => {
    applyModel({
      ...model,
      switches: switches.map((sw) => {
        if (sw.id !== switchId) return sw
        const current = new Set(sw.controls ?? [])
        if (checked) current.add(lightId)
        else current.delete(lightId)
        return { ...sw, controls: Array.from(current) }
      }),
    })
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let disposed = false
    let cleanup: (() => void) | null = null
    setState('loading')

    loadThreeRuntime()
      .then(([THREE, { OrbitControls }]) => {
        if (disposed || !hostRef.current) return

        const currentHost = hostRef.current
        currentHost.replaceChildren()

        const renderer = new THREE.WebGLRenderer({ antialias: true })
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
        renderer.setClearColor(0xf7f8fb, 1)
        renderer.shadowMap.enabled = true
        renderer.shadowMap.type = THREE.PCFSoftShadowMap
        currentHost.appendChild(renderer.domElement)

        const scene = new THREE.Scene()
        scene.background = new THREE.Color(0xf7f8fb)

        const bounds = modelBounds(model)
        const height = Number.isFinite(heightFt) && heightFt > 0 ? heightFt : DEFAULT_WALL_HEIGHT_FT
        const span = Math.max(bounds.width, bounds.depth, height, 12)
        const centerX = bounds.minX + bounds.width / 2
        const centerZ = bounds.minZ + bounds.depth / 2
        const fitPad = Math.max(1.25, Math.min(8, span * 0.08))
        const sceneMinX = bounds.minX - WALL_THICKNESS_FT / 2 - fitPad
        const sceneMaxX = bounds.maxX + WALL_THICKNESS_FT / 2 + fitPad
        const sceneMinZ = bounds.minZ - WALL_THICKNESS_FT / 2 - fitPad
        const sceneMaxZ = bounds.maxZ + WALL_THICKNESS_FT / 2 + fitPad
        const sceneCenter = new THREE.Vector3(centerX, height / 2, centerZ)
        const sceneCorners = [
          new THREE.Vector3(sceneMinX, 0, sceneMinZ),
          new THREE.Vector3(sceneMinX, 0, sceneMaxZ),
          new THREE.Vector3(sceneMaxX, 0, sceneMinZ),
          new THREE.Vector3(sceneMaxX, 0, sceneMaxZ),
          new THREE.Vector3(sceneMinX, height, sceneMinZ),
          new THREE.Vector3(sceneMinX, height, sceneMaxZ),
          new THREE.Vector3(sceneMaxX, height, sceneMinZ),
          new THREE.Vector3(sceneMaxX, height, sceneMaxZ),
        ]
        const paddedWidth = sceneMaxX - sceneMinX
        const paddedDepth = sceneMaxZ - sceneMinZ
        const floorRadius = Math.hypot(paddedWidth, paddedDepth) / 2
        const sceneRadius = Math.hypot(paddedWidth, paddedDepth, height) / 2
        const minCameraDistance = Math.max(6, height * 1.05, floorRadius * 1.12)
        const maxCameraDistance = Math.max(minCameraDistance + span * 2, sceneRadius * 8, 60)
        const camera = new THREE.PerspectiveCamera(45, 1, 0.1, Math.max(300, maxCameraDistance * 4))

        const controls = new OrbitControls(camera, renderer.domElement)
        controls.enableDamping = true
        controls.dampingFactor = 0.08
        controls.enablePan = true
        controls.enableZoom = true
        controls.panSpeed = 0.8
        controls.zoomSpeed = 0.85
        controls.screenSpacePanning = true
        controls.target.copy(sceneCenter)
        controls.minDistance = minCameraDistance
        controls.maxDistance = maxCameraDistance
        controls.mouseButtons = {
          LEFT: THREE.MOUSE.ROTATE,
          MIDDLE: THREE.MOUSE.DOLLY,
          RIGHT: THREE.MOUSE.PAN,
        }
        controls.touches = {
          ONE: THREE.TOUCH.ROTATE,
          TWO: THREE.TOUCH.DOLLY_PAN,
        }

        const setCameraUp = (top: boolean) => {
          camera.up.set(0, top ? 0 : 1, top ? -1 : 0)
        }

        const distanceForDirection = (direction: any): number => {
          const viewDir = direction.clone().normalize()
          camera.position.copy(sceneCenter).addScaledVector(viewDir, 1)
          setCameraUp(Math.abs(viewDir.y) > 0.96)
          camera.lookAt(sceneCenter)
          camera.updateMatrixWorld()
          const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
          const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion)
          let halfW = 0
          let halfH = 0
          let depthHalf = 0
          sceneCorners.forEach((corner: any) => {
            const rel = corner.clone().sub(sceneCenter)
            halfW = Math.max(halfW, Math.abs(rel.dot(right)))
            halfH = Math.max(halfH, Math.abs(rel.dot(up)))
            depthHalf = Math.max(depthHalf, Math.abs(rel.dot(viewDir)))
          })
          const vFov = THREE.MathUtils.degToRad(camera.fov)
          const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(0.1, camera.aspect))
          const fitDistance = (Math.max(halfH / Math.tan(vFov / 2), halfW / Math.tan(hFov / 2)) + depthHalf) * 1.12
          return Math.max(minCameraDistance, Math.min(maxCameraDistance * 0.9, fitDistance))
        }

        const fitCamera = (preset: CameraPreset = 'fit') => {
          const direction =
            preset === 'top'
              ? new THREE.Vector3(0.001, 1, 0.001).normalize()
              : new THREE.Vector3(0.78, 0.52, 0.86).normalize()
          const distance = distanceForDirection(direction)
          setCameraUp(preset === 'top')
          controls.target.copy(sceneCenter)
          camera.position.copy(sceneCenter).addScaledVector(direction, distance)
          camera.lookAt(sceneCenter)
          camera.near = Math.max(0.05, minCameraDistance / 80)
          camera.far = Math.max(300, maxCameraDistance * 4)
          camera.updateProjectionMatrix()
          controls.update()
        }

        cameraApiRef.current = {
          fit: () => fitCamera('fit'),
          top: () => fitCamera('top'),
          angle: () => fitCamera('angle'),
        }
        controls.update()

        scene.add(new THREE.HemisphereLight(0xffffff, 0xcbd5e1, 1.2))
        const keyLight = new THREE.DirectionalLight(0xffffff, 1)
        keyLight.position.set(centerX - span * 0.45, height + span * 0.9, centerZ + span * 0.55)
        keyLight.castShadow = true
        keyLight.shadow.mapSize.set(1024, 1024)
        scene.add(keyLight)

        const gridSize = Math.max(24, Math.ceil(span + 8))
        const ground = new THREE.Mesh(
          new THREE.PlaneGeometry(gridSize, gridSize),
          new THREE.MeshStandardMaterial({ color: 0xeef1f4, roughness: 0.9 }),
        )
        ground.rotation.x = -Math.PI / 2
        ground.position.set(centerX, -0.04, centerZ)
        ground.receiveShadow = true
        scene.add(ground)

        const grid = new THREE.GridHelper(gridSize, gridSize, 0xaeb8c4, 0xd9dee7)
        grid.position.set(centerX, -0.02, centerZ)
        scene.add(grid)

        const floorTargets: any[] = [ground]
        const wallTargets: any[] = []
        const itemTargets: any[] = []
        const wallSurface = finishes.walls.kind === 'tile' ? finishes.walls : { kind: 'paint' as const, color: cleanColor(finishes.wallPaint, DEFAULT_WALL_PAINT) }
        const floorMaterial = createFloorMaterial(THREE, finishes.floor)
        const doorMaterial = new THREE.MeshStandardMaterial({ color: 0xb86b24, roughness: 0.62 })
        const windowMaterial = new THREE.MeshStandardMaterial({
          color: 0x2f80d1,
          emissive: 0x0b355d,
          emissiveIntensity: 0.08,
          roughness: 0.36,
          metalness: 0.08,
        })
        const cellFt = modelCellFt(model)

        model.contours.forEach((contour) => {
          if (!contour.closed || contour.points.length < 3) return
          const shape = new THREE.Shape()
          contour.points.forEach((p, index) => {
            const x = p.x * cellFt
            const y = p.y * cellFt
            if (index === 0) shape.moveTo(x, y)
            else shape.lineTo(x, y)
          })
          shape.closePath()
          const geometry = new THREE.ShapeGeometry(shape)
          applyFloorTileUv(geometry, finishes.floor)
          geometry.rotateX(Math.PI / 2)
          const floor = new THREE.Mesh(geometry, floorMaterial)
          floor.position.y = 0.015
          floor.receiveShadow = true
          scene.add(floor)
          floorTargets.push(floor)
        })

        eachSegment(model).forEach((seg) => {
          const a = { x: seg.a.x * cellFt, z: seg.a.y * cellFt }
          const b = { x: seg.b.x * cellFt, z: seg.b.y * cellFt }
          const dx = b.x - a.x
          const dz = b.z - a.z
          const len = Math.hypot(dx, dz)
          if (len <= 0.01) return
          const wall = new THREE.Mesh(new THREE.BoxGeometry(len, height, WALL_THICKNESS_FT), createWallMaterial(THREE, wallSurface, len, height))
          wall.position.set((a.x + b.x) / 2, height / 2, (a.z + b.z) / 2)
          wall.rotation.y = -Math.atan2(dz, dx)
          wall.castShadow = true
          wall.receiveShadow = true
          wall.userData.wallC = seg.c
          wall.userData.wallS = seg.s
          scene.add(wall)
          wallTargets.push(wall)
        })

        model.openings.forEach((opening) => {
          const ends = openingEnds(model, opening)
          if (!ends) return
          const segLenCells = dist(ends.a, ends.b)
          const segLenFt = segLenCells * cellFt
          if (segLenFt <= 0.01) return
          const ux = ((ends.b.x - ends.a.x) * cellFt) / segLenFt
          const uz = ((ends.b.y - ends.a.y) * cellFt) / segLenFt
          const x = (ends.a.x + (ends.b.x - ends.a.x) * opening.t) * cellFt
          const z = (ends.a.y + (ends.b.y - ends.a.y) * opening.t) * cellFt
          const width = Math.max(0.2, Math.min(openingWidthFt(opening), segLenFt))
          const insertHeight =
            opening.kind === 'door'
              ? Math.max(0.2, Math.min(DOOR_H_FT, height - 0.12))
              : Math.max(0.2, Math.min(opening.h ?? WIN_H_FT, height - 0.12))
          const sill =
            opening.kind === 'door'
              ? 0
              : Math.max(0, Math.min(opening.sill ?? WIN_SILL_FT, Math.max(0, height - insertHeight)))
          const nx = -uz
          const nz = ux
          const insert = new THREE.Mesh(
            new THREE.BoxGeometry(width, insertHeight, 0.08),
            opening.kind === 'door' ? doorMaterial : windowMaterial,
          )
          insert.position.set(
            x + nx * (WALL_THICKNESS_FT / 2 + 0.055),
            sill + insertHeight / 2,
            z + nz * (WALL_THICKNESS_FT / 2 + 0.055),
          )
          insert.rotation.y = -Math.atan2(uz, ux)
          insert.castShadow = true
          scene.add(insert)
        })

        const addLightGroup = (light: SketchLight, index: number) => {
          const group = new THREE.Group()
          const isWall = light.kind === 'sconce'
          const anchor = isWall && Number.isInteger(light.c) && Number.isInteger(light.s)
            ? wallAnchor(model, light.c ?? 0, light.s ?? 0, light.t ?? 0.5, Math.min(height - 0.8, light.heightFt ?? DEFAULT_SCONCE_HEIGHT_FT))
            : null

          if (isWall && anchor) {
            const plate = new THREE.Mesh(
              new THREE.BoxGeometry(0.42, 0.58, 0.12),
              new THREE.MeshStandardMaterial({ color: 0xd8c5a9, roughness: 0.48, metalness: 0.08 }),
            )
            const shade = new THREE.Mesh(
              new THREE.SphereGeometry(0.22, 18, 12),
              new THREE.MeshStandardMaterial({ color: 0xfff2c8, emissive: 0xffd57a, emissiveIntensity: 0.26, roughness: 0.42 }),
            )
            group.add(plate, shade)
            plate.position.set(0, 0, 0)
            shade.position.set(0, 0, 0.12)
            group.position.set(anchor.x + anchor.nx * (WALL_THICKNESS_FT / 2 + 0.08), anchor.y, anchor.z + anchor.nz * (WALL_THICKNESS_FT / 2 + 0.08))
            group.rotation.y = anchor.rotationY
            const glow = new THREE.PointLight(0xffe4ae, 0.65, 10)
            glow.position.set(anchor.x + anchor.nx * 0.45, anchor.y + 0.05, anchor.z + anchor.nz * 0.45)
            scene.add(glow)
          } else {
            const x = Number.isFinite(light.xFt) ? light.xFt ?? centerX : centerX
            const z = Number.isFinite(light.zFt) ? light.zFt ?? centerZ : centerZ
            group.position.set(x, height - 0.08, z)
            if (light.kind === 'recessed') {
              const trim = new THREE.Mesh(
                new THREE.CylinderGeometry(0.3, 0.3, 0.08, 28),
                new THREE.MeshStandardMaterial({ color: 0xf8fafc, emissive: 0xfff1c2, emissiveIntensity: 0.18, roughness: 0.35 }),
              )
              group.add(trim)
            } else if (light.kind === 'chandelier') {
              const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.9, 12), new THREE.MeshStandardMaterial({ color: 0x3f352b, roughness: 0.5 }))
              const shade = new THREE.Mesh(
                new THREE.SphereGeometry(0.34, 24, 16),
                new THREE.MeshStandardMaterial({ color: 0xfff0c7, emissive: 0xffdc86, emissiveIntensity: 0.2, roughness: 0.32 }),
              )
              cord.position.y = -0.42
              shade.position.y = -0.9
              group.add(cord, shade)
            } else if (light.kind === 'fan') {
              const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.2, 18), new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.45 }))
              group.add(hub)
              for (let i = 0; i < 4; i++) {
                const blade = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.045, 0.2), new THREE.MeshStandardMaterial({ color: 0xa28261, roughness: 0.55 }))
                blade.position.x = 0.62
                blade.rotation.y = (Math.PI / 2) * i
                group.add(blade)
              }
            }
            const glow = new THREE.PointLight(0xffe8b5, light.kind === 'fan' ? 0.28 : 0.7, 14)
            glow.position.set(x, height - 0.7, z)
            scene.add(glow)
          }

          tagInteractive(group, 'light', light.id)
          scene.add(group)
          itemTargets.push(group)
          if (selectedId === light.id) {
            const sprite = createLabelSprite(THREE, lightName(light, index, t))
            sprite.position.copy(group.position)
            sprite.position.y += light.kind === 'chandelier' ? 0.45 : 0.62
            scene.add(sprite)
          }
        }

        lights.forEach(addLightGroup)

        switches.forEach((sw, index) => {
          const anchor = wallAnchor(model, sw.c, sw.s, sw.t, Math.min(height - 0.5, sw.heightFt ?? DEFAULT_SWITCH_HEIGHT_FT))
          if (!anchor) return
          const group = new THREE.Group()
          const plate = new THREE.Mesh(
            new THREE.BoxGeometry(0.34, 0.5, 0.075),
            new THREE.MeshStandardMaterial({ color: 0xf6f1e8, roughness: 0.36 }),
          )
          const toggle = new THREE.Mesh(
            new THREE.BoxGeometry(0.07, 0.22, 0.025),
            new THREE.MeshStandardMaterial({ color: 0x9ca3af, roughness: 0.3 }),
          )
          toggle.position.z = 0.055
          group.add(plate, toggle)
          group.position.set(anchor.x + anchor.nx * (WALL_THICKNESS_FT / 2 + 0.075), anchor.y, anchor.z + anchor.nz * (WALL_THICKNESS_FT / 2 + 0.075))
          group.rotation.y = anchor.rotationY
          tagInteractive(group, 'switch', sw.id)
          scene.add(group)
          itemTargets.push(group)
          if (selectedId === sw.id) {
            const names = (sw.controls ?? [])
              .map((id) => lights.findIndex((light) => light.id === id))
              .filter((i) => i >= 0)
              .map((i) => lightName(lights[i], i, t))
            const text = `${switchName(sw, index, t)}\n${t('hub_sketch_3d_controls')}: ${names.join(', ') || t('hub_sketch_3d_none')}`
            const sprite = createLabelSprite(THREE, text)
            sprite.position.copy(group.position)
            sprite.position.y += 0.72
            scene.add(sprite)
          }
        })

        const raycaster = new THREE.Raycaster()
        const pointer = new THREE.Vector2()
        const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
        const planePoint = new THREE.Vector3()
        let pointerDown: { x: number; y: number } | null = null
        let drag:
          | {
              type: 'light' | 'switch'
              id: string
              moved: boolean
              latestLight?: SketchLight
              latestSwitch?: SketchSwitch
              object: any
            }
          | null = null

        const updatePointer = (event: PointerEvent) => {
          const rect = renderer.domElement.getBoundingClientRect()
          pointer.x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1
          pointer.y = -(((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1)
          raycaster.setFromCamera(pointer, camera)
        }

        const floorHitPoint = () => {
          const hits = raycaster.intersectObjects(floorTargets, true)
          if (hits[0]) return hits[0].point
          return raycaster.ray.intersectPlane(groundPlane, planePoint)
        }

        const wallHitAnchor = () => {
          const hits = raycaster.intersectObjects(wallTargets, true)
          const hit = hits[0]
          if (!hit) return null
          const wall = taggedWall(hit.object)
          if (!wall) return null
          return { ...wall, t: projectWallT(model, wall.c, wall.s, hit.point) }
        }

        const placeAtPointer = (event: PointerEvent) => {
          if (!placement || !canEdit) return
          updatePointer(event)
          if (placement === 'switch') {
            const anchor = wallHitAnchor()
            if (!anchor) return
            const nextSwitch: SketchSwitch = {
              id: makeId('switch'),
              c: anchor.c,
              s: anchor.s,
              t: anchor.t,
              heightFt: DEFAULT_SWITCH_HEIGHT_FT,
              controls: lights[0] ? [lights[0].id] : [],
            }
            onModelChange?.({ ...model, switches: [...switches, nextSwitch] })
            setSelectedId(nextSwitch.id)
            return
          }
          if (placement === 'sconce') {
            const anchor = wallHitAnchor()
            if (!anchor) return
            const nextLight: SketchLight = {
              id: makeId('light'),
              kind: 'sconce',
              name: `${lightKindLabel(t, 'sconce')} ${lights.length + 1}`,
              c: anchor.c,
              s: anchor.s,
              t: anchor.t,
              heightFt: DEFAULT_SCONCE_HEIGHT_FT,
            }
            onModelChange?.({ ...model, lights: [...lights, nextLight] })
            setSelectedId(nextLight.id)
            return
          }
          const point = floorHitPoint()
          if (!point) return
          const nextLight = addLightAt(placement, point.x, point.z)
          onModelChange?.({ ...model, lights: [...lights, nextLight] })
          setSelectedId(nextLight.id)
        }

        const onPointerDown = (event: PointerEvent) => {
          pointerDown = { x: event.clientX, y: event.clientY }
          if (event.button !== 0) return
          if (!canEdit) return
          updatePointer(event)
          const hit = raycaster.intersectObjects(itemTargets, true)[0]
          const tagged = hit ? taggedObject(hit.object) : null
          if (!tagged) return
          const object = hit.object.parent ?? hit.object
          drag = { ...tagged, moved: false, object }
          setSelectedId(tagged.id)
          controls.enabled = false
          renderer.domElement.setPointerCapture?.(event.pointerId)
          event.preventDefault()
        }

        const onPointerMove = (event: PointerEvent) => {
          if (!drag) return
          updatePointer(event)
          drag.moved = true
          if (drag.type === 'switch') {
            const anchor = wallHitAnchor()
            const current = switches.find((sw) => sw.id === drag?.id)
            if (!anchor || !current) return
            const nextSwitch = { ...current, c: anchor.c, s: anchor.s, t: anchor.t }
            drag.latestSwitch = nextSwitch
            const pose = wallAnchor(model, nextSwitch.c, nextSwitch.s, nextSwitch.t, nextSwitch.heightFt ?? DEFAULT_SWITCH_HEIGHT_FT)
            if (pose) {
              drag.object.position.set(pose.x + pose.nx * (WALL_THICKNESS_FT / 2 + 0.075), pose.y, pose.z + pose.nz * (WALL_THICKNESS_FT / 2 + 0.075))
              drag.object.rotation.y = pose.rotationY
            }
          } else {
            const current = lights.find((light) => light.id === drag?.id)
            if (!current) return
            if (current.kind === 'sconce') {
              const anchor = wallHitAnchor()
              if (!anchor) return
              const nextLight = { ...current, c: anchor.c, s: anchor.s, t: anchor.t }
              drag.latestLight = nextLight
              const pose = wallAnchor(model, nextLight.c ?? 0, nextLight.s ?? 0, nextLight.t ?? 0.5, nextLight.heightFt ?? DEFAULT_SCONCE_HEIGHT_FT)
              if (pose) {
                drag.object.position.set(pose.x + pose.nx * (WALL_THICKNESS_FT / 2 + 0.08), pose.y, pose.z + pose.nz * (WALL_THICKNESS_FT / 2 + 0.08))
                drag.object.rotation.y = pose.rotationY
              }
            } else {
              const point = floorHitPoint()
              if (!point) return
              const nextLight = { ...current, xFt: point.x, zFt: point.z }
              drag.latestLight = nextLight
              drag.object.position.x = point.x
              drag.object.position.z = point.z
            }
          }
          event.preventDefault()
        }

        const onPointerUp = (event: PointerEvent) => {
          const delta = pointerDown ? Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) : 0
          pointerDown = null
          if (event.button !== 0) return
          if (drag) {
            const completed = drag
            drag = null
            controls.enabled = true
            if (completed.moved && completed.latestLight) {
              onModelChange?.({ ...model, lights: lights.map((light) => (light.id === completed.latestLight?.id ? completed.latestLight : light)) })
            }
            if (completed.moved && completed.latestSwitch) {
              onModelChange?.({ ...model, switches: switches.map((sw) => (sw.id === completed.latestSwitch?.id ? completed.latestSwitch : sw)) })
            }
            renderer.domElement.releasePointerCapture?.(event.pointerId)
            event.preventDefault()
            return
          }
          if (delta <= 4) placeAtPointer(event)
        }

        const onContextMenu = (event: MouseEvent) => event.preventDefault()

        renderer.domElement.addEventListener('pointerdown', onPointerDown)
        renderer.domElement.addEventListener('pointermove', onPointerMove)
        renderer.domElement.addEventListener('pointerup', onPointerUp)
        renderer.domElement.addEventListener('contextmenu', onContextMenu)

        const clampCameraTarget = () => {
          const panPad = Math.max(4, span * 0.35)
          const nextTarget = controls.target.clone()
          nextTarget.x = Math.max(sceneMinX - panPad, Math.min(sceneMaxX + panPad, nextTarget.x))
          nextTarget.y = Math.max(0, Math.min(height, nextTarget.y))
          nextTarget.z = Math.max(sceneMinZ - panPad, Math.min(sceneMaxZ + panPad, nextTarget.z))
          const delta = nextTarget.sub(controls.target)
          if (delta.lengthSq() <= 0.000001) return
          controls.target.add(delta)
          camera.position.add(delta)
        }

        let didInitialFit = false
        const resize = () => {
          const rect = currentHost.getBoundingClientRect()
          const width = Math.max(1, Math.floor(rect.width))
          const heightPx = Math.max(1, Math.floor(rect.height))
          renderer.setSize(width, heightPx, false)
          camera.aspect = width / heightPx
          camera.updateProjectionMatrix()
          if (!didInitialFit) {
            fitCamera('fit')
            didInitialFit = true
          }
        }
        const observer = new ResizeObserver(resize)
        observer.observe(currentHost)
        resize()

        let frame = 0
        const animate = () => {
          if (disposed) return
          controls.update()
          clampCameraTarget()
          renderer.render(scene, camera)
          frame = window.requestAnimationFrame(animate)
        }
        animate()
        setState('ready')

        cleanup = () => {
          window.cancelAnimationFrame(frame)
          renderer.domElement.removeEventListener('pointerdown', onPointerDown)
          renderer.domElement.removeEventListener('pointermove', onPointerMove)
          renderer.domElement.removeEventListener('pointerup', onPointerUp)
          renderer.domElement.removeEventListener('contextmenu', onContextMenu)
          observer.disconnect()
          cameraApiRef.current = null
          controls.dispose()
          scene.traverse((object: { geometry?: unknown; material?: unknown }) => disposeObjectWithMaterial(object))
          renderer.dispose()
          renderer.domElement.remove()
        }
      })
      .catch(() => {
        if (!disposed) setState('error')
      })

    return () => {
      disposed = true
      cleanup?.()
      host.replaceChildren()
    }
  }, [model, heightFt, finishes, canEdit, onModelChange, placement, selectedId, t, lights, switches])

  const activeTile = normalizeTileSurface(activeSurface)
  const tileSizeValue = `${activeTile.tileWIn ?? 12}x${activeTile.tileHIn ?? 24}`

  return (
    <div className="hub-sketch-3d-layout">
      <div className="hub-sketch-3d-shell" role="img" aria-label={label}>
        <div ref={hostRef} className="hub-sketch-3d-canvas" />
        <div className="hub-sketch-3d-camera-tools" role="toolbar" aria-label={t('hub_sketch_3d_camera')}>
          <button type="button" className="btn ghost small" onClick={() => cameraApiRef.current?.fit()}>
            {t('hub_sketch_camera_fit')}
          </button>
          <button type="button" className="btn ghost small" onClick={() => cameraApiRef.current?.top()}>
            {t('hub_sketch_camera_top')}
          </button>
          <button type="button" className="btn ghost small" onClick={() => cameraApiRef.current?.angle()}>
            {t('hub_sketch_camera_angle')}
          </button>
        </div>
        {state === 'loading' && <div className="hub-sketch-3d-overlay muted">{loadingLabel}</div>}
        {state === 'error' && <div className="hub-sketch-3d-overlay error-msg">{errorLabel}</div>}
      </div>

      {canEdit && (
        <aside className="hub-sketch-3d-panel" aria-label={t('hub_sketch_3d_panel')}>
          <section className="hub-sketch-3d-section">
            <h3>{t('hub_sketch_3d_finishes')}</h3>
            <div className="hub-sketch-segmented" role="group" aria-label={t('hub_sketch_3d_surface')}>
              {(['walls', 'floor'] as SurfaceTarget[]).map((target) => (
                <button
                  key={target}
                  type="button"
                  className={surfaceTarget === target ? 'btn small' : 'btn ghost small'}
                  onClick={() => setSurfaceTarget(target)}
                >
                  {t(target === 'walls' ? 'hub_sketch_3d_walls' : 'hub_sketch_3d_floor')}
                </button>
              ))}
            </div>

            <div className="hub-sketch-segmented" role="group" aria-label={t('hub_sketch_3d_finish_mode')}>
              {(['paint', 'tile'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={activeSurface.kind === kind ? 'btn small' : 'btn ghost small'}
                  onClick={() => updateSurface(kind === 'tile' ? normalizeTileSurface(activeSurface) : { kind: 'paint', color: surfaceTarget === 'walls' ? finishes.wallPaint : DEFAULT_FLOOR_PAINT })}
                >
                  {t(kind === 'paint' ? 'hub_sketch_3d_paint' : 'hub_sketch_3d_tile')}
                </button>
              ))}
            </div>

            {surfaceTarget === 'walls' && (
              <div className="hub-sketch-color-row" aria-label={t('hub_sketch_3d_wall_color')}>
                {WALL_PAINT_SWATCHES.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className="hub-sketch-swatch"
                    style={{ backgroundColor: color }}
                    aria-label={color}
                    onClick={() => updateWallPaint(color)}
                  />
                ))}
                <input
                  className="hub-sketch-color-input"
                  type="color"
                  value={cleanColor(finishes.wallPaint, DEFAULT_WALL_PAINT)}
                  onChange={(e) => updateWallPaint(e.target.value)}
                  aria-label={t('hub_sketch_3d_wall_color')}
                />
              </div>
            )}

            {activeSurface.kind === 'tile' && (
              <div className="hub-sketch-tile-controls">
                <label className="hub-sketch-field">
                  <span className="muted">{t('hub_sketch_3d_tile_size')}</span>
                  <select
                    value={tileSizeValue}
                    onChange={(e) => {
                      const option = TILE_SIZE_OPTIONS.find((item) => `${item.w}x${item.h}` === e.target.value) ?? TILE_SIZE_OPTIONS[0]
                      updateTile({ tileWIn: option.w, tileHIn: option.h })
                    }}
                  >
                    {TILE_SIZE_OPTIONS.map((option) => (
                      <option key={option.key} value={`${option.w}x${option.h}`}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="hub-sketch-field">
                  <span className="muted">{t('hub_sketch_3d_grout_width')}</span>
                  <input type="number" min="0" max="2" step="0.0625" value={activeTile.groutIn ?? DEFAULT_GROUT_IN} onChange={(e) => updateTile({ groutIn: Number(e.target.value) || 0 })} />
                </label>
                <label className="hub-sketch-field">
                  <span className="muted">{t('hub_sketch_3d_tile_color')}</span>
                  <input type="color" value={cleanColor(activeTile.tileColor, DEFAULT_TILE_COLOR)} onChange={(e) => updateTile({ tileColor: e.target.value })} />
                </label>
                <label className="hub-sketch-field">
                  <span className="muted">{t('hub_sketch_3d_grout_color')}</span>
                  <input type="color" value={cleanColor(activeTile.groutColor, DEFAULT_GROUT_COLOR)} onChange={(e) => updateTile({ groutColor: e.target.value })} />
                </label>
                <label className="hub-sketch-field">
                  <span className="muted">{t('hub_sketch_3d_row_offset')}</span>
                  <input type="number" min="-96" max="96" step="0.25" value={activeTile.offsetYIn ?? 0} onChange={(e) => updateTile({ offsetYIn: Number(e.target.value) || 0 })} />
                </label>
                <label className="hub-sketch-field">
                  <span className="muted">{t('hub_sketch_3d_corner_offset')}</span>
                  <input type="number" min="-96" max="96" step="0.25" value={activeTile.offsetXIn ?? 0} onChange={(e) => updateTile({ offsetXIn: Number(e.target.value) || 0 })} />
                </label>
                {cutSummary && (
                  <div className="hub-sketch-cut-summary">
                    <span>{`${t('hub_sketch_3d_rows')}: ${cutSummary.rows}`}</span>
                    <span>{`${t('hub_sketch_3d_bottom')}: ${formatInches(cutSummary.bottomIn)}`}</span>
                    <span>{`${t('hub_sketch_3d_top')}: ${formatInches(cutSummary.topIn)}`}</span>
                    <span>{`${t('hub_sketch_3d_left')}: ${formatInches(cutSummary.leftIn)}`}</span>
                    <span>{`${t('hub_sketch_3d_right')}: ${formatInches(cutSummary.rightIn)}`}</span>
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="hub-sketch-3d-section">
            <h3>{t('hub_sketch_3d_lighting')}</h3>
            <div className="hub-sketch-place-grid" role="group" aria-label={t('hub_sketch_3d_place')}>
              {(['recessed', 'chandelier', 'fan', 'sconce'] as SketchLightKind[]).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={placement === kind ? 'btn small' : 'btn ghost small'}
                  aria-pressed={placement === kind}
                  onClick={() => setPlacement((current) => (current === kind ? null : kind))}
                >
                  {lightKindLabel(t, kind)}
                </button>
              ))}
              <button
                type="button"
                className={placement === 'switch' ? 'btn small' : 'btn ghost small'}
                aria-pressed={placement === 'switch'}
                onClick={() => setPlacement((current) => (current === 'switch' ? null : 'switch'))}
              >
                {t('hub_sketch_3d_switch')}
              </button>
            </div>
            <div className="hub-sketch-object-list">
              {lights.map((light, index) => (
                <button key={light.id} type="button" className={selectedId === light.id ? 'btn small' : 'btn ghost small'} onClick={() => setSelectedId(light.id)}>
                  {lightName(light, index, t)}
                </button>
              ))}
              {switches.map((sw, index) => (
                <button key={sw.id} type="button" className={selectedId === sw.id ? 'btn small' : 'btn ghost small'} onClick={() => setSelectedId(sw.id)}>
                  {switchName(sw, index, t)}
                </button>
              ))}
            </div>
          </section>

          {(selectedLight || selectedSwitch) && (
            <section className="hub-sketch-3d-section hub-sketch-selected-box">
              <h3>{selectedLight ? lightName(selectedLight, lights.findIndex((light) => light.id === selectedLight.id), t) : selectedSwitch ? switchName(selectedSwitch, switches.findIndex((sw) => sw.id === selectedSwitch.id), t) : ''}</h3>
              {selectedSwitch && (
                <div className="hub-sketch-switch-links">
                  <span className="muted">{t('hub_sketch_3d_controls')}</span>
                  {lights.length === 0 && <span>{t('hub_sketch_3d_none')}</span>}
                  {lights.map((light, index) => (
                    <label key={light.id} className="hub-sketch-check-row">
                      <input
                        type="checkbox"
                        checked={(selectedSwitch.controls ?? []).includes(light.id)}
                        onChange={(e) => updateSwitchControls(selectedSwitch.id, light.id, e.target.checked)}
                      />
                      <span>{lightName(light, index, t)}</span>
                    </label>
                  ))}
                </div>
              )}
              <button type="button" className="btn ghost small" onClick={removeSelected}>
                {t('hub_sketch_3d_remove')}
              </button>
            </section>
          )}
        </aside>
      )}
    </div>
  )
}
