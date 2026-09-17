/**
 * Background-image intake: turn a user-chosen image file into the bounded
 * `data:image/…` URL the theme settings namespace persists. The source is
 * decoded, scaled to at most {@link WALLPAPER_MAX_EDGE} on its longer edge,
 * and re-encoded, so the durable settings document never carries an original
 * multi-megabyte photograph.
 */

/** Longest edge the stored background image keeps, in px. */
export const WALLPAPER_MAX_EDGE = 2560

/** Largest source file accepted before decoding, in bytes. */
export const WALLPAPER_MAX_SOURCE_BYTES = 20 * 1024 * 1024

/** Encoder quality for the re-encoded background image. */
const WALLPAPER_QUALITY = 0.85

/** Why a chosen file could not become a background image. */
export type WallpaperEncodeFailure = 'too-large' | 'unsupported'

/** Outcome of encoding one chosen file. */
export type WallpaperEncodeResult =
  | { ok: true; image: string }
  | { ok: false; reason: WallpaperEncodeFailure }

/**
 * Whether a persisted value is a usable background image URL. `''` (no image)
 * and `data:image/…` URLs are accepted; anything else is refused at the
 * settings boundary rather than handed to the CSS layer.
 * @param value - candidate string from the settings document.
 * @returns whether the value can be applied as a background image.
 */
export function isBackgroundImageUrl(value: string): boolean {
  return value === '' || value.startsWith('data:image/')
}

/**
 * Encode one chosen image file for the settings document.
 * @param file - user-selected image file.
 * @returns the bounded data URL, or the reason the file was refused.
 */
export async function encodeWallpaperFile(file: File): Promise<WallpaperEncodeResult> {
  if (file.size > WALLPAPER_MAX_SOURCE_BYTES) return { ok: false, reason: 'too-large' }
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch (_undecodableImage) {
    // The browser could not decode the chosen bytes: an unsupported or
    // corrupt image, reported to the row rather than stored as-is.
    return { ok: false, reason: 'unsupported' }
  }
  try {
    const scale = Math.min(1, WALLPAPER_MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    /* v8 ignore next 2 -- every browser that decodes an ImageBitmap has a 2d context; only a canvas-less test environment reaches this */
    if (context === null) return { ok: false, reason: 'unsupported' }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const webp = canvas.toDataURL('image/webp', WALLPAPER_QUALITY)
    // Engines without a WebP encoder answer a PNG data URL; re-encode to JPEG
    // so the durable value keeps the size win the format check promised.
    const image = webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', WALLPAPER_QUALITY)
    return { ok: true, image }
  } finally {
    bitmap.close()
  }
}
