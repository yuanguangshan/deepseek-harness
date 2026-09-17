/**
 * Appearance, font-size, and background-image row slot stores: mirrors of the
 * theme service snapshot. The plugin's apply-world change listener is the only
 * writer; the row components read via props.useStore.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import {
  DEFAULT_BACKGROUND_BLUR, DEFAULT_BACKGROUND_IMAGE, DEFAULT_BACKGROUND_OPACITY,
  DEFAULT_FONT_SIZE, type ThemePreference,
} from '../theme-settings.ts'

/** Store state mirrored from the theme snapshot. */
export interface AppearanceRowState {
  /** Persisted preference (selection state reads this, never the resolved active theme). */
  preference: ThemePreference
  /** Service revision; -1 until first sync so revision 0 lands as a change. */
  revision: number
}

/** Declared action shape giving the exported factory a stable return type. */
type AppearanceRowActions = {
  sync: (draft: AppearanceRowState, preference: ThemePreference, revision: number) => void
}

/**
 * Declares the Appearance row state and write surface.
 * @returns the store handle.
 */
export function createAppearanceRowStore(): EngineStoreHandle<AppearanceRowState, AppearanceRowActions> {
  return defineStore({
    init: (): AppearanceRowState => ({ preference: 'system', revision: -1 }),
    actions: {
      sync: (d, preference: ThemePreference, revision: number) => {
        if (revision <= d.revision) return
        d.preference = preference
        d.revision = revision
      },
    },
  })
}

/** Store state mirrored from the theme snapshot's font size. */
export interface FontSizeRowState {
  /** Persisted content font size in px. */
  fontSize: number
  /** Service revision; -1 until first sync so revision 0 lands as a change. */
  revision: number
}

/** Declared action shape giving the exported factory a stable return type. */
type FontSizeRowActions = {
  sync: (draft: FontSizeRowState, fontSize: number, revision: number) => void
}

/**
 * Declares the font-size row state and write surface.
 * @returns the store handle.
 */
export function createFontSizeRowStore(): EngineStoreHandle<FontSizeRowState, FontSizeRowActions> {
  return defineStore({
    init: (): FontSizeRowState => ({ fontSize: DEFAULT_FONT_SIZE, revision: -1 }),
    actions: {
      sync: (d, fontSize: number, revision: number) => {
        if (revision <= d.revision) return
        d.fontSize = fontSize
        d.revision = revision
      },
    },
  })
}

/** Store state mirrored from the theme snapshot's background image. */
export interface WallpaperRowState {
  /** Persisted background image URL, or the empty string for none. */
  image: string
  /** Persisted layer opacity in percent. */
  opacity: number
  /** Persisted blur radius in px. */
  blur: number
  /** Service revision; -1 until first sync so revision 0 lands as a change. */
  revision: number
}

/** Declared action shape giving the exported factory a stable return type. */
type WallpaperRowActions = {
  sync: (draft: WallpaperRowState, image: string, opacity: number, blur: number, revision: number) => void
}

/**
 * Declares the background-image row state and write surface.
 * @returns the store handle.
 */
export function createWallpaperRowStore(): EngineStoreHandle<WallpaperRowState, WallpaperRowActions> {
  return defineStore({
    init: (): WallpaperRowState => ({
      image: DEFAULT_BACKGROUND_IMAGE,
      opacity: DEFAULT_BACKGROUND_OPACITY,
      blur: DEFAULT_BACKGROUND_BLUR,
      revision: -1,
    }),
    actions: {
      sync: (d, image: string, opacity: number, blur: number, revision: number) => {
        if (revision <= d.revision) return
        d.image = image
        d.opacity = opacity
        d.blur = blur
        d.revision = revision
      },
    },
  })
}
