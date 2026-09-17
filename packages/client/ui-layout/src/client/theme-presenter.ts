/**
 * Global theme DOM applier: projects the resolved ThemeSnapshot onto the
 * document — `html { color-scheme }` for native UA chrome (scrollbars, form
 * controls), `body[data-ds-dark-theme]` for the token palette, the active
 * theme's alias-token overrides as inline CSS variables on body, the content
 * font-size axis (`--dsh-content-font-size`), the background-image layer
 * variables plus `body[data-dsh-wallpaper]` (whose stylesheet rebinds the frame
 * and sidebar surfaces), and one presenter-owned `meta[name="theme-color"]` for
 * surrounding browser UI. Pure DOM writes, no React involvement; the presenter
 * only ever retracts what it wrote itself, so foreign attributes, metadata, and
 * inline styles survive.
 */
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'

/** Body attribute selecting the dark base palette in the token stylesheets. */
export const DARK_ATTRIBUTE = 'data-ds-dark-theme'

/** Body variable carrying the user's content font size in px. */
export const CONTENT_FONT_SIZE_VARIABLE = '--dsh-content-font-size'

/** Body attribute whose stylesheet paints the background-image layer. */
export const WALLPAPER_ATTRIBUTE = 'data-dsh-wallpaper'

/** Body variable carrying the background image as a CSS `url(…)` value. */
export const WALLPAPER_IMAGE_VARIABLE = '--dsh-wallpaper-image'

/** Body variable carrying the background-image layer opacity (0..1). */
export const WALLPAPER_OPACITY_VARIABLE = '--dsh-wallpaper-opacity'

/** Body variable carrying the background-image blur radius in px. */
export const WALLPAPER_BLUR_VARIABLE = '--dsh-wallpaper-blur'

/** Applies theme snapshots to the document; one instance per plugin fiber. */
export class ThemePresenter {
  /** Token names this presenter wrote in the last apply (its retraction set). */
  private appliedTokens: string[] = []
  /** The single metadata node this presenter inserts and removes. */
  private readonly themeColorMeta: HTMLMetaElement

  /** Create the presenter-owned metadata node before the first snapshot arrives. */
  constructor() {
    this.themeColorMeta = document.createElement('meta')
    this.themeColorMeta.name = 'theme-color'
  }

  /**
   * Project a snapshot onto the document: set root `color-scheme` and the body
   * palette attribute from `active.colorScheme` (never the id — `system` is
   * resolved upstream), publish the content font-size axis and the
   * background-image layer, then replace the previously applied token variables
   * with `active.tokens`. Browser theme-color metadata follows the computed
   * body background after those writes, so the rendered palette remains the
   * color authority.
   * @param snapshot - resolved theme snapshot from ctx.theme.
   */
  apply(snapshot: ThemeSnapshot): void {
    const scheme = snapshot.active.colorScheme
    document.documentElement.style.colorScheme = scheme
    const body = document.body
    if (scheme === 'dark') body.setAttribute(DARK_ATTRIBUTE, '')
    else body.removeAttribute(DARK_ATTRIBUTE)
    body.style.setProperty(CONTENT_FONT_SIZE_VARIABLE, `${snapshot.fontSize}px`)
    this.applyWallpaper(body, snapshot.background)
    for (const name of this.appliedTokens) body.style.removeProperty(name)
    this.appliedTokens = []
    for (const [name, value] of Object.entries(snapshot.active.tokens)) {
      body.style.setProperty(name, value)
      this.appliedTokens.push(name)
    }
    this.themeColorMeta.content = getComputedStyle(body).backgroundColor
    if (!this.themeColorMeta.isConnected) document.head.append(this.themeColorMeta)
  }

  /**
   * Publish or retract the background-image layer. The value is always a
   * presenter-encoded `url("data:image/…")`; removing the attribute also
   * removes the variables so a cleared image leaves no stale layer styles.
   * @param body - document body receiving the attribute and variables.
   * @param background - image URL plus layer opacity and blur from the snapshot.
   */
  private applyWallpaper(body: HTMLElement, background: ThemeSnapshot['background']): void {
    if (background.image === '') {
      body.removeAttribute(WALLPAPER_ATTRIBUTE)
      body.style.removeProperty(WALLPAPER_IMAGE_VARIABLE)
      body.style.removeProperty(WALLPAPER_OPACITY_VARIABLE)
      body.style.removeProperty(WALLPAPER_BLUR_VARIABLE)
      return
    }
    body.setAttribute(WALLPAPER_ATTRIBUTE, '')
    body.style.setProperty(WALLPAPER_IMAGE_VARIABLE, `url("${background.image}")`)
    body.style.setProperty(WALLPAPER_OPACITY_VARIABLE, `${background.opacity / 100}`)
    body.style.setProperty(WALLPAPER_BLUR_VARIABLE, `${background.blur}px`)
  }

  /**
   * Retract root color-scheme, the palette attribute, token variables, the
   * font-size axis, the background-image layer, and the owned metadata node.
   */
  dispose(): void {
    document.documentElement.style.removeProperty('color-scheme')
    const body = document.body
    body.removeAttribute(DARK_ATTRIBUTE)
    body.style.removeProperty(CONTENT_FONT_SIZE_VARIABLE)
    this.applyWallpaper(body, { image: '', opacity: 0, blur: 0 })
    for (const name of this.appliedTokens) body.style.removeProperty(name)
    this.appliedTokens = []
    this.themeColorMeta.remove()
  }
}
