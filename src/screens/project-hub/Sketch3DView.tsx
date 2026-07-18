import { useEffect, useRef, useState } from 'react'

const CELL_FT = 1
const DEFAULT_WALL_HEIGHT_FT = 8
const WALL_THICKNESS_FT = 0.5
const DOOR_W_FT = 3
const DOOR_H_FT = 6.8
const WIN_W_FT = 3
const WIN_H_FT = 4
const WIN_SILL_FT = 3

type Pt = { x: number; y: number }
type Contour = { points: Pt[]; closed: boolean }
type Opening = {
  kind: 'door' | 'window'
  c: number
  s: number
  t: number
  w?: number
  h?: number
  sill?: number
}

type Sketch3DModel = {
  version: 1
  cellFt?: number
  height?: number
  contours: Contour[]
  openings: Opening[]
}

interface Sketch3DViewProps {
  model: Sketch3DModel
  heightFt: number
  label: string
  loadingLabel: string
  errorLabel: string
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function openingWidthFt(o: Opening): number {
  return o.w ?? (o.kind === 'door' ? DOOR_W_FT : WIN_W_FT)
}

function modelCellFt(model: Sketch3DModel): number {
  return Number.isFinite(model.cellFt) && (model.cellFt ?? 0) > 0 ? model.cellFt ?? CELL_FT : CELL_FT
}

function openingEnds(model: Sketch3DModel, o: Opening): { a: Pt; b: Pt } | null {
  const c = model.contours[o.c]
  if (!c) return null
  const a = c.points[o.s]
  const b = o.s + 1 < c.points.length ? c.points[o.s + 1] : (c.closed ? c.points[0] : null)
  if (!a || !b) return null
  return { a, b }
}

function eachSegment(model: Sketch3DModel): { a: Pt; b: Pt }[] {
  const out: { a: Pt; b: Pt }[] = []
  model.contours.forEach((cont) => {
    for (let s = 0; s < cont.points.length - 1; s++) out.push({ a: cont.points[s], b: cont.points[s + 1] })
    if (cont.closed && cont.points.length >= 3) out.push({ a: cont.points[cont.points.length - 1], b: cont.points[0] })
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

function disposeObjectWithMaterial(object: { geometry?: unknown; material?: unknown }) {
  const geometry = object.geometry
  if (geometry && typeof geometry === 'object' && 'dispose' in geometry) {
    ;(geometry as { dispose: () => void }).dispose()
  }
  const disposeMaterial = (material: unknown) => {
    if (Array.isArray(material)) {
      material.forEach(disposeMaterial)
      return
    }
    if (material && typeof material === 'object' && 'dispose' in material) {
      ;(material as { dispose: () => void }).dispose()
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

export default function Sketch3DView({ model, heightFt, label, loadingLabel, errorLabel }: Sketch3DViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')

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
        const camera = new THREE.PerspectiveCamera(45, 1, 0.1, Math.max(300, span * 24))
        camera.position.set(centerX + span * 0.85, Math.max(height * 1.35, span * 0.65), centerZ + span * 1.05)
        camera.lookAt(centerX, height / 2, centerZ)

        const controls = new OrbitControls(camera, renderer.domElement)
        controls.enableDamping = true
        controls.dampingFactor = 0.08
        controls.target.set(centerX, height / 2, centerZ)
        controls.minDistance = 3
        controls.maxDistance = Math.max(48, span * 4)
        controls.update()

        scene.add(new THREE.HemisphereLight(0xffffff, 0xcbd5e1, 1.4))
        const keyLight = new THREE.DirectionalLight(0xffffff, 1.25)
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

        const wallMaterial = new THREE.MeshStandardMaterial({ color: 0xe7ebf0, roughness: 0.72 })
        const floorMaterial = new THREE.MeshStandardMaterial({ color: 0xb9bfc8, roughness: 0.82, side: THREE.DoubleSide })
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
          geometry.rotateX(Math.PI / 2)
          const floor = new THREE.Mesh(geometry, floorMaterial)
          floor.position.y = 0.015
          floor.receiveShadow = true
          scene.add(floor)
        })

        eachSegment(model).forEach((seg) => {
          const a = { x: seg.a.x * cellFt, z: seg.a.y * cellFt }
          const b = { x: seg.b.x * cellFt, z: seg.b.y * cellFt }
          const dx = b.x - a.x
          const dz = b.z - a.z
          const len = Math.hypot(dx, dz)
          if (len <= 0.01) return
          const wall = new THREE.Mesh(new THREE.BoxGeometry(len, height, WALL_THICKNESS_FT), wallMaterial)
          wall.position.set((a.x + b.x) / 2, height / 2, (a.z + b.z) / 2)
          wall.rotation.y = -Math.atan2(dz, dx)
          wall.castShadow = true
          wall.receiveShadow = true
          scene.add(wall)
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

        const resize = () => {
          const rect = currentHost.getBoundingClientRect()
          const width = Math.max(1, Math.floor(rect.width))
          const heightPx = Math.max(1, Math.floor(rect.height))
          renderer.setSize(width, heightPx, false)
          camera.aspect = width / heightPx
          camera.updateProjectionMatrix()
        }
        const observer = new ResizeObserver(resize)
        observer.observe(currentHost)
        resize()

        let frame = 0
        const animate = () => {
          if (disposed) return
          controls.update()
          renderer.render(scene, camera)
          frame = window.requestAnimationFrame(animate)
        }
        animate()
        setState('ready')

        cleanup = () => {
          window.cancelAnimationFrame(frame)
          observer.disconnect()
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
  }, [model, heightFt])

  return (
    <div className="hub-sketch-3d-shell" role="img" aria-label={label}>
      <div ref={hostRef} className="hub-sketch-3d-canvas" />
      {state === 'loading' && <div className="hub-sketch-3d-overlay muted">{loadingLabel}</div>}
      {state === 'error' && <div className="hub-sketch-3d-overlay error-msg">{errorLabel}</div>}
    </div>
  )
}
