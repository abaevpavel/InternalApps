/**
 * Travel-времена для движка расписания.
 *
 * Источник истины — Google Distance Matrix (через Maps JavaScript SDK, в браузере,
 * без CORS-проблем). Если ключа нет — фолбэк на грубую haversine-эвристику.
 *
 * Движок синхронный, а Matrix асинхронный, поэтому матрицу времён считаем ЗАРАНЕЕ
 * (buildTravelMatrix) и отдаём в движок синхронный lookup-провайдер.
 */
import type { Point, TravelProvider } from '../../domain/task-planner/scheduling-engine'
import { fetchTravelCache, saveTravelCache } from './data'

export const GOOGLE_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined

/* ---------------- Загрузка Google Maps JS SDK ---------------- */

let mapsPromise: Promise<typeof google.maps> | null = null

/** Лениво подгружает Maps JS SDK. Резолвится в google.maps или реджектится. */
function loadGoogleMaps(): Promise<typeof google.maps> {
  if (!GOOGLE_KEY) return Promise.reject(new Error('no-google-key'))
  if (typeof window !== 'undefined' && window.google?.maps) return Promise.resolve(window.google.maps)
  if (mapsPromise) return mapsPromise
  mapsPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    // Синхронный (monolithic) загрузчик: на onload весь API, включая DistanceMatrixService,
    // уже привязан к google.maps. Через loading=async классы не попадают в namespace без
    // importLibrary, а сам importLibrary при простом <script src> не всегда инициализируется.
    s.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_KEY}&v=weekly`
    s.async = true
    s.onerror = () => reject(new Error('google-maps-load-failed'))
    s.onload = () => resolve(window.google.maps)
    document.head.appendChild(s)
  })
  return mapsPromise
}

/* ---------------- Haversine-фолбэк ---------------- */

const heuristicCache = new Map<string, number>()

function haversineKm(a: Point, b: Point): number {
  if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return 0
  const R = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const la1 = (a.lat * Math.PI) / 180
  const la2 = (b.lat * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** Грубая оценка: ~1.6 мин/км (городской трафик DC/MD/VA). Используется без ключа. */
export const estimateTravel: TravelProvider = (from, to) => {
  const key = `${from.lat},${from.lng}|${to.lat},${to.lng}`
  const hit = heuristicCache.get(key)
  if (hit != null) return hit
  const min = Math.round(haversineKm(from, to) * 1.6)
  heuristicCache.set(key, min)
  return min
}

/* ---------------- Google Distance Matrix ---------------- */

export interface MatrixPoint {
  /** стабильный id точки (task_id / адрес стопа / 'home') — ключ для lookup в движке */
  key: string
  /** адрес для запроса в Google (приоритетнее координат) */
  address?: string | null
  lat?: number | null
  lng?: number | null
}

/** Ключ ребра матрицы. */
export function edgeKey(fromKey: string, toKey: string): string {
  return `${fromKey}|${toKey}`
}

/** Глобальный кэш рёбер по парам key — переживает реордеры и перемонтирования. */
const edgeCache = new Map<string, number>()

function originFor(p: MatrixPoint): string | google.maps.LatLngLiteral | null {
  if (p.address && p.address.trim()) return p.address.trim()
  if (p.lat != null && p.lng != null) return { lat: p.lat, lng: p.lng }
  return null
}

/** Делит массив на чанки заданного размера. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export interface MatrixOptions {
  /** время отправления для учёта пробок; используется только если в будущем */
  departureTime?: Date | null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Глобальная ПОСЛЕДОВАТЕЛЬНАЯ очередь запросов к Distance Matrix.
 * Google реджектит burst (OVER_QUERY_LIMIT), когда несколько бригад строят
 * матрицу одновременно. Сериализуем запросы, чтобы не было всплеска.
 */
let dmQueue: Promise<unknown> = Promise.resolve()
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = dmQueue.then(fn, fn)
  dmQueue = run.then(() => {}, () => {})
  return run as Promise<T>
}

/** Запрос матрицы с ретраями (на OVER_QUERY_LIMIT / transient). */
async function requestMatrix(
  svc: google.maps.DistanceMatrixService,
  req: google.maps.DistanceMatrixRequest,
  tries = 4,
): Promise<google.maps.DistanceMatrixResponse> {
  let lastErr: unknown
  for (let i = 0; i < tries; i++) {
    try {
      return await enqueue(() => svc.getDistanceMatrix(req))
    } catch (err) {
      lastErr = err
      await sleep(500 * (i + 1)) // backoff: 0.5s, 1s, 1.5s
    }
  }
  throw lastErr
}

/**
 * Строит матрицу времён (минуты) между всеми точками дня и возвращает Map по edgeKey.
 * Использует Google Distance Matrix; результаты кэшируются глобально по парам key.
 * При ошибке НЕ затирает нулями: если есть координаты — haversine, иначе оставляет
 * ребро пустым (matrixProvider использует fallback — числа AI).
 */
export async function buildTravelMatrix(
  points: MatrixPoint[],
  opts: MatrixOptions = {},
): Promise<Map<string, number>> {
  // уникализируем по key
  const uniq = new Map<string, MatrixPoint>()
  for (const p of points) if (!uniq.has(p.key)) uniq.set(p.key, p)
  const list = [...uniq.values()]
  const result = new Map<string, number>()

  // self-пары = 0
  for (const p of list) result.set(edgeKey(p.key, p.key), 0)

  // какие рёбра ещё не в кэше
  const missing: Array<[MatrixPoint, MatrixPoint]> = []
  for (const a of list) {
    for (const b of list) {
      if (a.key === b.key) continue
      const k = edgeKey(a.key, b.key)
      if (edgeCache.has(k)) {
        result.set(k, edgeCache.get(k)!)
      } else {
        missing.push([a, b])
      }
    }
  }
  if (missing.length) {
    // departureTime только если в будущем (требование Google для duration_in_traffic)
    const now = Date.now()
    const departure = opts.departureTime && opts.departureTime.getTime() > now ? opts.departureTime : null

    // 1) БД-кэш по адресам — только для запросов БЕЗ traffic (duration стабилен;
    //    traffic-времена зависят от момента, их не кэшируем).
    let pending = missing
    if (!departure) {
      const pairs = missing
        .filter(([a, b]) => a.address && b.address)
        .map(([a, b]) => [a.address as string, b.address as string] as [string, string])
      if (pairs.length) {
        const db = await fetchTravelCache(pairs)
        const rest: Array<[MatrixPoint, MatrixPoint]> = []
        for (const [a, b] of missing) {
          const v = a.address && b.address ? db.get(`${a.address}|${b.address}`) : undefined
          if (v != null) {
            const k = edgeKey(a.key, b.key)
            edgeCache.set(k, v)
            result.set(k, v)
          } else {
            rest.push([a, b])
          }
        }
        pending = rest
        if (import.meta.env.DEV && rest.length < missing.length) {
          console.info(`[maps] travel_cache hit: ${missing.length - rest.length}/${missing.length} edges from DB`)
        }
      }
    }

    // 2) Недостающее — из Google, затем сохраняем в БД-кэш.
    if (pending.length) {
      const saveEntries: { from: string; to: string; minutes: number }[] = []
      try {
        const maps = await loadGoogleMaps()
        const svc = new maps.DistanceMatrixService()
        // полный NxN, но батчим origins так, чтобы origins*destinations ≤ 100
        const dest = list.filter((p) => originFor(p) != null)
        const destVals = dest.map(originFor) as (string | google.maps.LatLngLiteral)[]
        const perBatch = Math.max(1, Math.floor(100 / Math.max(1, dest.length)))
        for (const originBatch of chunk(list.filter((p) => originFor(p) != null), perBatch)) {
          const originVals = originBatch.map(originFor) as (string | google.maps.LatLngLiteral)[]
          const resp = await requestMatrix(svc, {
            origins: originVals,
            destinations: destVals,
            travelMode: maps.TravelMode.DRIVING,
            unitSystem: maps.UnitSystem.IMPERIAL,
            ...(departure ? { drivingOptions: { departureTime: departure, trafficModel: maps.TrafficModel.BEST_GUESS } } : {}),
          })
          resp.rows.forEach((row, i) => {
            row.elements.forEach((el, j) => {
              if (el.status !== 'OK') {
                console.warn('[maps] element not OK:', el.status, originBatch[i].address, '→', dest[j].address)
                return
              }
              const sec = el.duration_in_traffic?.value ?? el.duration?.value ?? 0
              const min = Math.round(sec / 60)
              const k = edgeKey(originBatch[i].key, dest[j].key)
              edgeCache.set(k, min)
              result.set(k, min)
              // в БД-кэш только без traffic и при наличии адресов
              const fa = originBatch[i].address, ta = dest[j].address
              if (!departure && fa && ta && originBatch[i].key !== dest[j].key) {
                saveEntries.push({ from: fa, to: ta, minutes: min })
              }
            })
          })
        }
      } catch (err) {
        console.warn('[maps] Distance Matrix failed:', err)
        // НЕ затираем нулями: haversine только при наличии координат, иначе оставляем
        // ребро пустым → matrixProvider возьмёт fallback (числа AI).
        for (const [a, b] of pending) {
          if (a.lat != null && a.lng != null && b.lat != null && b.lng != null) {
            result.set(edgeKey(a.key, b.key), estimateTravel(
              { lat: a.lat, lng: a.lng, key: a.key },
              { lat: b.lat, lng: b.lng, key: b.key },
            ))
          }
        }
      }
      if (saveEntries.length) void saveTravelCache(saveEntries)
    }
  }

  if (import.meta.env.DEV) {
    const nonZero = [...result.entries()].filter(([, v]) => v > 0)
    console.info(
      `[maps] matrix built: ${result.size} edges, ${nonZero.length} non-zero. samples:`,
      nonZero.slice(0, 4).map(([k, v]) => `${k}=${v}m`),
    )
  }
  return result
}

/** Синхронный TravelProvider поверх готовой матрицы (по point.key). */
export function matrixProvider(matrix: Map<string, number>, fallback?: TravelProvider): TravelProvider {
  return (from, to) => {
    const v = matrix.get(edgeKey(from.key ?? '', to.key ?? ''))
    if (v != null) return v
    return fallback ? fallback(from, to) : 0
  }
}
