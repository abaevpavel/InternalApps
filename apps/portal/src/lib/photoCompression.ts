/**
 * Сжатие фото с телефона перед загрузкой (BAS-1442): библиотека browser-image-compression —
 * сжимает в отдельном потоке (страница не подвисает на 10 фото), учитывает поворот снимка.
 * Скрипт потока раздаём сами, а не с CDN (по умолчанию библиотека тянет его с jsdelivr).
 *
 * HEIC/HEIF (iPhone) браузер вне Safari не открывает — такие файлы сначала конвертируем в JPEG
 * (heic-to, ~3 МБ, грузится только когда встретился такой файл; так же в Retool, BAS-1744).
 */
import imageCompression from 'browser-image-compression'
import workerLibUrl from 'browser-image-compression/dist/browser-image-compression.js?url'

const HEIC_EXT = /\.(heic|heif)$/i
const HEIC_MIME = /^image\/(heic|heif)(-sequence)?$/i

export function isHeicFile(file: Pick<File, 'type' | 'name'>): boolean {
  return HEIC_MIME.test(file.type) || HEIC_EXT.test(file.name)
}

export interface PhotoCompressionOptions {
  /** Целевой размер, КБ */
  maxKB: number
  /** Длинная сторона, px */
  maxDimension: number
}

export async function compressPhoto(file: File, opts: PhotoCompressionOptions): Promise<Blob> {
  let source: File = file
  if (isHeicFile(file)) {
    const { heicTo } = await import('heic-to/csp')
    const jpeg = await heicTo({ blob: file, type: 'image/jpeg', quality: 0.92 })
    source = new File([jpeg], file.name.replace(HEIC_EXT, '.jpg'), { type: 'image/jpeg' })
  }
  return imageCompression(source, {
    maxSizeMB: opts.maxKB / 1024,
    maxWidthOrHeight: opts.maxDimension,
    fileType: 'image/jpeg',
    initialQuality: 0.85,
    useWebWorker: true,
    libURL: new URL(workerLibUrl, window.location.href).href,
  })
}
