/** Theme preferences stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Built-in preferences accepted at the registry and settings boundaries. */
export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const

/** Settings namespace owned by the theme plugin. */
export const THEME_SETTINGS_NAMESPACE = 'ui-theme'

/** Field carrying the selected built-in theme preference. */
export const THEME_PREFERENCE_FIELD = 'preference'

/** Field carrying the conversation content font size. */
export const FONT_SIZE_FIELD = 'fontSize'

/** Field carrying the user's background image as a `data:image/…` URL. */
export const BACKGROUND_IMAGE_FIELD = 'backgroundImage'

/** Field carrying the background image layer opacity in percent. */
export const BACKGROUND_OPACITY_FIELD = 'backgroundOpacity'

/** Field carrying the background image blur radius in px. */
export const BACKGROUND_BLUR_FIELD = 'backgroundBlur'

/** Theme preference persisted by the product Appearance row. */
export type ThemePreference = typeof THEME_PREFERENCES[number]

/** Default preference when the user-settings document has no override. */
export const DEFAULT_PREFERENCE: ThemePreference = 'system'

/** Smallest accepted content font size (px). */
export const FONT_SIZE_MIN = 12

/** Largest accepted content font size (px). */
export const FONT_SIZE_MAX = 17

/** Content font size when the user-settings document has no override (px). */
export const DEFAULT_FONT_SIZE = 14

/** No background image; the layer does not paint. */
export const DEFAULT_BACKGROUND_IMAGE = ''

/** Smallest accepted background image opacity (percent). */
export const BACKGROUND_OPACITY_MIN = 0

/** Largest accepted background image opacity (percent). */
export const BACKGROUND_OPACITY_MAX = 100

/** Background image opacity when the user-settings document has no override (percent). */
export const DEFAULT_BACKGROUND_OPACITY = 100

/** Smallest accepted background image blur radius (px). */
export const BACKGROUND_BLUR_MIN = 0

/** Largest accepted background image blur radius (px). */
export const BACKGROUND_BLUR_MAX = 24

/** Background image blur radius when the user-settings document has no override (px). */
export const DEFAULT_BACKGROUND_BLUR = 0

/** Durable theme section shared by the Host schema and the browser scope. */
export interface ThemeSettings {
  /** Selected built-in preference. */
  preference: ThemePreference
  /** Conversation content font size in px (integer within {@link FONT_SIZE_MIN}..{@link FONT_SIZE_MAX}). */
  fontSize: number
  /** Background image as a `data:image/…` URL, or the empty string for none. */
  backgroundImage: string
  /** Background image layer opacity in percent (integer within {@link BACKGROUND_OPACITY_MIN}..{@link BACKGROUND_OPACITY_MAX}). */
  backgroundOpacity: number
  /** Background image blur radius in px (integer within {@link BACKGROUND_BLUR_MIN}..{@link BACKGROUND_BLUR_MAX}). */
  backgroundBlur: number
}

/** Durable theme schema; also the wire envelope the browser scope validates against. */
export const ThemeSettingsSchema: z<ThemeSettings> = z.object({
  [THEME_PREFERENCE_FIELD]: z.union([...THEME_PREFERENCES]).default(DEFAULT_PREFERENCE),
  [FONT_SIZE_FIELD]: z.number().step(1).min(FONT_SIZE_MIN).max(FONT_SIZE_MAX).default(DEFAULT_FONT_SIZE),
  [BACKGROUND_IMAGE_FIELD]: z.string().default(DEFAULT_BACKGROUND_IMAGE),
  [BACKGROUND_OPACITY_FIELD]: z.number().step(1).min(BACKGROUND_OPACITY_MIN)
    .max(BACKGROUND_OPACITY_MAX).default(DEFAULT_BACKGROUND_OPACITY),
  [BACKGROUND_BLUR_FIELD]: z.number().step(1).min(BACKGROUND_BLUR_MIN).max(BACKGROUND_BLUR_MAX).default(DEFAULT_BACKGROUND_BLUR),
})

/**
 * Narrow one wire or registry value to a persistable preference.
 * @param value - value crossing the settings or registry boundary.
 * @returns whether the value is a built-in preference.
 */
export function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.some(preference => preference === value)
}
