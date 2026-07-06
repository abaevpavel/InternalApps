/**
 * Клиентская компрессия изображения в JPEG (как в оригинале 06-HR-Checklists):
 * ≤ maxDimension по большей стороне, целевой размер ≤ maxKB (снижаем quality итеративно).
 */
export async function compressToJpeg(file: File, maxKB = 200, maxDimension = 1920): Promise<Blob> {
  const bitmap = await loadBitmap(file)

  let { width, height } = bitmap
  const scale = Math.min(1, maxDimension / Math.max(width, height))
  width = Math.round(width * scale)
  height = Math.round(height * scale)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable')
  ctx.drawImage(bitmap, 0, 0, width, height)
  if ('close' in bitmap && typeof bitmap.close === 'function') bitmap.close()

  const maxBytes = maxKB * 1024
  let quality = 0.9
  let blob = await toBlob(canvas, quality)
  while (blob.size > maxBytes && quality > 0.3) {
    quality -= 0.1
    blob = await toBlob(canvas, quality)
  }
  return blob
}

function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) return createImageBitmap(file)
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = (e) => {
      URL.revokeObjectURL(url)
      reject(e)
    }
    img.src = url
  })
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', quality)
  })
}
