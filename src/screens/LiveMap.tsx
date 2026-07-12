import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useEntityDrawer } from '../components/EntityDrawer'
import { getMapProjects, getTeam, getTodayEvents, getWorkerLastLocations, type WorkerLocation } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { shiftState } from '../lib/time'
import type { Profile, Project, TimeEvent } from '../lib/types'

type MapPoint = { lat: number; lng: number }
type ProjectMarker = { project: Project; point: MapPoint }
type WorkerMarker = {
  worker: Profile
  point: MapPoint
  lastAt: string | null
  projectName: string | null
  tone: 'green' | 'gray'
}

const DEFAULT_CENTER: L.LatLngExpression = [39.8283, -98.5795]

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim().replace(',', '.'))
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function validPoint(lat: unknown, lng: unknown): MapPoint | null {
  const latNum = toNumber(lat)
  const lngNum = toNumber(lng)
  if (latNum === null || lngNum === null) return null
  if (latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) return null
  return { lat: latNum, lng: lngNum }
}

function parsePoint(value: unknown): MapPoint | null {
  if (!value) return null

  if (Array.isArray(value) && value.length >= 2) {
    return validPoint(value[1], value[0])
  }

  if (typeof value === 'string') {
    const wkt = value.match(/POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i)
    if (wkt) return validPoint(wkt[2], wkt[1])
    return null
  }

  if (typeof value === 'object') {
    const row = value as Record<string, unknown>
    const direct = validPoint(row.lat ?? row.latitude, row.lng ?? row.lon ?? row.longitude)
    if (direct) return direct
    if (Array.isArray(row.coordinates)) return parsePoint(row.coordinates)
  }

  return null
}

function projectPoint(project: Project): MapPoint | null {
  const directPairs: Array<[unknown, unknown]> = [
    [project.lat, project.lng],
    [project.latitude, project.longitude],
    [project.site_lat, project.site_lng],
    [project.gps_lat, project.gps_lng],
  ]

  for (const [lat, lng] of directPairs) {
    const point = validPoint(lat, lng)
    if (point) return point
  }

  return parsePoint(project.site_point) ?? parsePoint(project.gps_point)
}

function eventPoint(event: TimeEvent): MapPoint | null {
  const metadata = event.metadata && typeof event.metadata === 'object' ? event.metadata : {}
  const direct = validPoint(metadata.lat ?? metadata.latitude, metadata.lng ?? metadata.lon ?? metadata.longitude)
  if (direct) return direct
  return parsePoint(metadata.gps_point ?? metadata.point ?? metadata.coords ?? metadata.coordinates)
}

function latestGps(events: TimeEvent[]): { point: MapPoint | null; at: string | null } {
  const sorted = [...events].sort((a, b) => b.event_time.localeCompare(a.event_time))
  for (const event of sorted) {
    const point = eventPoint(event)
    if (point) return { point, at: event.event_time }
  }
  return { point: null, at: null }
}

function markerIcon(kind: 'project' | 'worker', tone: 'project' | 'green' | 'gray') {
  return L.divIcon({
    className: `map-marker ${kind} ${tone}`,
    html: `<span>${kind === 'project' ? 'P' : 'W'}</span>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  })
}

function groupEventsByWorker(events: TimeEvent[]) {
  const grouped = new Map<string, TimeEvent[]>()
  for (const event of events) {
    if (!grouped.has(event.profile_id)) grouped.set(event.profile_id, [])
    grouped.get(event.profile_id)!.push(event)
  }
  return grouped
}

export default function LiveMap() {
  const { t } = useI18n()
  const { openProject, openWorker } = useEntityDrawer()
  const mapEl = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)
  const fittedRef = useRef(false)
  const mountedRef = useRef(true)
  const [projects, setProjects] = useState<Project[]>([])
  const [team, setTeam] = useState<Profile[]>([])
  const [events, setEvents] = useState<TimeEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [locations, setLocations] = useState<Map<string, WorkerLocation>>(new Map())

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true)
    else setLoading(true)
    setError(false)
    try {
      const [projectRows, people, todayEvents, locs] = await Promise.all([
        getMapProjects(),
        getTeam(),
        getTodayEvents(),
        getWorkerLastLocations(),
      ])
      if (!mountedRef.current) return
      setProjects(projectRows)
      setTeam(people)
      setEvents(todayEvents)
      setLocations(locs)
      setLastUpdated(new Date())
    } catch {
      if (mountedRef.current) setError(true)
    } finally {
      if (!mountedRef.current) return
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    load()
    const timer = window.setInterval(() => load(true), 60000)
    return () => {
      mountedRef.current = false
      window.clearInterval(timer)
    }
  }, [load])

  useEffect(() => {
    if (!mapEl.current || mapRef.current) return
    const map = L.map(mapEl.current, { zoomControl: true }).setView(DEFAULT_CENTER, 4)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map)
    layerRef.current = L.layerGroup().addTo(map)
    mapRef.current = map
    window.setTimeout(() => map.invalidateSize(), 0)

    return () => {
      map.remove()
      mapRef.current = null
      layerRef.current = null
      fittedRef.current = false
    }
  }, [])

  const projectMarkers = useMemo<ProjectMarker[]>(() => (
    projects
      .map((project) => ({ project, point: projectPoint(project) }))
      .filter((row): row is ProjectMarker => row.point !== null)
  ), [projects])

  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects])
  const eventsByWorker = useMemo(() => groupEventsByWorker(events), [events])

  const workerMarkers = useMemo<WorkerMarker[]>(() => {
    const markers: WorkerMarker[] = []
    for (const worker of team) {
      const workerEvents = eventsByWorker.get(worker.id) ?? []
      const state = shiftState(workerEvents)
      if (state.status === 'off') continue

      const loc = locations.get(worker.id)
      const gps = loc ? { point: { lat: loc.lat, lng: loc.lng }, at: loc.server_time } : { point: null as MapPoint | null, at: null as string | null }
      const currentProject = state.projectId ? projectById.get(state.projectId) ?? null : null
      if (gps.point) {
        markers.push({
          worker,
          point: gps.point,
          lastAt: gps.at,
          projectName: currentProject?.name ?? null,
          tone: 'green',
        })
        continue
      }

      const fallbackPoint = currentProject ? projectPoint(currentProject) : null
      if (!fallbackPoint) continue
      markers.push({
        worker,
        point: fallbackPoint,
        lastAt: null,
        projectName: currentProject?.name ?? null,
        tone: 'gray',
      })
    }
    return markers
  }, [eventsByWorker, projectById, team, locations])

  const hiddenNoDataWorkers = useMemo(() => {
    return team.reduce((count, worker) => {
      const workerEvents = eventsByWorker.get(worker.id) ?? []
      const state = shiftState(workerEvents)
      if (state.status === 'off' || locations.get(worker.id)) return count
      const currentProject = state.projectId ? projectById.get(state.projectId) ?? null : null
      return currentProject && projectPoint(currentProject) ? count : count + 1
    }, 0)
  }, [eventsByWorker, projectById, team, locations])

  useEffect(() => {
    const map = mapRef.current
    const layer = layerRef.current
    if (!map || !layer) return

    layer.clearLayers()
    const bounds: L.LatLngExpression[] = []

    for (const { project, point } of projectMarkers) {
      const marker = L.marker([point.lat, point.lng], {
        icon: markerIcon('project', 'project'),
        title: project.name,
      }).addTo(layer)
      marker.bindTooltip(project.name)
      marker.on('click', () => openProject(project))
      bounds.push([point.lat, point.lng])
    }

    for (const markerRow of workerMarkers) {
      const title = markerRow.projectName ? `${markerRow.worker.name} · ${markerRow.projectName}` : markerRow.worker.name
      const marker = L.marker([markerRow.point.lat, markerRow.point.lng], {
        icon: markerIcon('worker', markerRow.tone),
        title,
      }).addTo(layer)
      const detail = markerRow.lastAt
        ? `${title}<br>${t('last_seen')}: ${new Date(markerRow.lastAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
        : `${title}<br>${t('no_gps_data')}`
      marker.bindTooltip(detail)
      marker.on('click', () => openWorker(markerRow.worker))
      bounds.push([markerRow.point.lat, markerRow.point.lng])
    }

    if (!fittedRef.current && bounds.length > 0) {
      if (bounds.length === 1) map.setView(bounds[0], 13)
      else map.fitBounds(L.latLngBounds(bounds), { padding: [34, 34], maxZoom: 14 })
      fittedRef.current = true
    }
  }, [openProject, openWorker, projectMarkers, t, workerMarkers])

  const projectsWithoutGeo = projects.length - projectMarkers.length
  const grayWorkers = workerMarkers.filter((marker) => marker.tone === 'gray').length
  const noGpsWorkers = grayWorkers + hiddenNoDataWorkers
  const markerCount = projectMarkers.length + workerMarkers.length

  return (
    <div className="screen map-screen">
      <div className="row map-head">
        <div>
          <h1>🗺️ {t('live_map')}</h1>
          <p className="muted">{t('map_refreshing')}</p>
        </div>
        <button className="btn ghost small map-refresh" onClick={() => load(true)} disabled={loading || refreshing}>
          ↻ {refreshing ? t('loading') : t('refresh')}
        </button>
      </div>

      {error && <p className="error-msg">{t('load_error')}</p>}

      <div className="map-stats">
        <div className="card center">
          <div className="big">{projectMarkers.length}</div>
          <div className="muted">{t('project_sites')}</div>
        </div>
        <div className="card center">
          <div className="big">{workerMarkers.filter((marker) => marker.tone === 'green').length}</div>
          <div className="muted">{t('on_shift')}</div>
        </div>
        <div className="card center">
          <div className="big">{noGpsWorkers}</div>
          <div className="muted">{t('no_gps_data')}</div>
        </div>
      </div>

      <div className="card map-shell">
        {loading && <div className="map-overlay muted">{t('loading')}</div>}
        <div className="map-canvas" ref={mapEl} />
      </div>

      <div className="map-legend">
        <span><i className="map-dot project" />{t('project_sites')}</span>
        <span><i className="map-dot green" />{t('on_shift')}</span>
        <span><i className="map-dot gray" />{t('no_gps_data')}</span>
      </div>

      {lastUpdated && (
        <p className="muted map-updated">
          {t('map_last_updated')}: {lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </p>
      )}

      {!loading && markerCount === 0 && <div className="card muted">{t('map_no_points')}</div>}
      {!loading && projectsWithoutGeo > 0 && (
        <div className="card muted">
          {t('map_projects_without_geo')}: {projectsWithoutGeo}
        </div>
      )}
      {!loading && hiddenNoDataWorkers > 0 && (
        <div className="card muted">
          {t('map_workers_without_position')}: {hiddenNoDataWorkers}
        </div>
      )}
    </div>
  )
}
