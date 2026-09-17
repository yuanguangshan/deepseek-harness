// @vitest-environment jsdom
/** Background-image intake: source bounds, downscale geometry, and encode fallback. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  encodeWallpaperFile, isBackgroundImageUrl, WALLPAPER_MAX_EDGE, WALLPAPER_MAX_SOURCE_BYTES,
} from '../src/client/wallpaper.ts'

type Bitmap = { width: number; height: number; close: () => void }

function stubBitmap(value: Bitmap): void {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => value))
}

function bitmap(width: number, height: number): Bitmap {
  return { width, height, close: vi.fn() }
}

/** Replace the canvas element `createElement` hands back; returns its recorder. */
function stubCanvas(dataUrl: string | (() => string)) {
  const drawImage = vi.fn()
  const toDataURL = vi.fn(typeof dataUrl === 'function' ? dataUrl : () => dataUrl)
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage }),
    toDataURL,
  } as unknown as HTMLCanvasElement
  vi.spyOn(document, 'createElement').mockReturnValue(canvas)
  return { canvas, drawImage, toDataURL }
}

function file(size = 4): File {
  return new File([new Uint8Array(size)], 'wall.png', { type: 'image/png' })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('isBackgroundImageUrl', () => {
  it('accepts no image and data URLs, refusing every other value', () => {
    expect(isBackgroundImageUrl('')).toBe(true)
    expect(isBackgroundImageUrl('data:image/webp;base64,AAAA')).toBe(true)
    expect(isBackgroundImageUrl('https://example.com/a.png')).toBe(false)
    expect(isBackgroundImageUrl('data:text/html,x')).toBe(false)
  })
})

describe('encodeWallpaperFile', () => {
  it('refuses a source above the byte bound without decoding it', async () => {
    const decode = vi.fn()
    vi.stubGlobal('createImageBitmap', decode)
    const oversized = file()
    Object.defineProperty(oversized, 'size', { value: WALLPAPER_MAX_SOURCE_BYTES + 1 })
    await expect(encodeWallpaperFile(oversized)).resolves.toEqual({ ok: false, reason: 'too-large' })
    expect(decode).not.toHaveBeenCalled()
  })

  it('downscales the long edge to the bound and encodes WebP', async () => {
    const source = bitmap(3200, 1600)
    stubBitmap(source)
    const { canvas, drawImage, toDataURL } = stubCanvas('data:image/webp;base64,ZZZ')
    await expect(encodeWallpaperFile(file())).resolves.toEqual({ ok: true, image: 'data:image/webp;base64,ZZZ' })
    expect(canvas.width).toBe(WALLPAPER_MAX_EDGE)
    expect(canvas.height).toBe(WALLPAPER_MAX_EDGE / 2)
    expect(drawImage).toHaveBeenCalledWith(source, 0, 0, canvas.width, canvas.height)
    expect(source.close).toHaveBeenCalledOnce()
    expect(toDataURL).toHaveBeenCalledWith('image/webp', 0.85)
  })

  it('keeps an image already inside the bound at its own size', async () => {
    stubBitmap(bitmap(800, 600))
    const { canvas } = stubCanvas('data:image/webp;base64,ZZZ')
    await encodeWallpaperFile(file())
    expect(canvas.width).toBe(800)
    expect(canvas.height).toBe(600)
  })

  it('clamps a sub-pixel scaled edge to one pixel', async () => {
    stubBitmap(bitmap(1, 10000))
    const { canvas } = stubCanvas('data:image/webp;base64,ZZZ')
    await encodeWallpaperFile(file())
    expect(canvas.width).toBe(1)
    expect(canvas.height).toBe(WALLPAPER_MAX_EDGE)
  })

  it('falls back to JPEG when the engine answers a non-WebP data URL', async () => {
    stubBitmap(bitmap(400, 300))
    const toDataURL = stubCanvas(() => 'data:image/png;base64,PNG').toDataURL
    toDataURL.mockReturnValueOnce('data:image/png;base64,PNG').mockReturnValueOnce('data:image/jpeg;base64,JPG')
    await expect(encodeWallpaperFile(file())).resolves.toEqual({ ok: true, image: 'data:image/jpeg;base64,JPG' })
    expect(toDataURL).toHaveBeenLastCalledWith('image/jpeg', 0.85)
  })

  it('reports an undecodable file as unsupported', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('undecodable') }))
    await expect(encodeWallpaperFile(file())).resolves.toEqual({ ok: false, reason: 'unsupported' })
  })
})
