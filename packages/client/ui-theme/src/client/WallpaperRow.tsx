/**
 * Background-image preference row registered into the General section item
 * slot: title + description, a choose/replace control, an optional preview,
 * and the opacity and blur sliders. Registered by this package — the theme
 * feature owns its own settings surface. Every displayed value follows the
 * persisted setting, never the click echo, and the row reads the chosen file
 * through its injected face so image decoding stays outside the component.
 */
import { useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import {
  BACKGROUND_BLUR_MAX, BACKGROUND_OPACITY_MAX,
} from '../theme-settings.ts'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { createWallpaperRowStore } from './settings-store.ts'
import type { WallpaperEncodeFailure } from './wallpaper.ts'
import css from './WallpaperRow.module.css'

/** Injected business face: the background-image writes (t rides the standard locale seat). */
export interface WallpaperRowInjected {
  /**
   * Decode, bound, and persist a chosen image file.
   * @param file - user-selected image file.
   * @returns the refusal reason, or undefined when the image was stored.
   */
  setBackgroundImage: (file: File) => Promise<WallpaperEncodeFailure | undefined>
  /** Remove the stored background image. */
  clearBackgroundImage: () => void
  /** Change the layer opacity (integer percent within 0..BACKGROUND_OPACITY_MAX). */
  setBackgroundOpacity: (percent: number) => void
  /** Change the blur radius (integer px within 0..BACKGROUND_BLUR_MAX). */
  setBackgroundBlur: (px: number) => void
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type WallpaperRowComponentProps =
  PropsRuntime<'settings.general.item'> & PropsStore<ReturnType<typeof createWallpaperRowStore>>
  & PropsLocale<'settings.theme'> & WallpaperRowInjected

/** One 0-based slider row: label, native range input, and the value with its unit. */
function SliderRow(props: {
  label: string
  value: number
  max: number
  unit: string
  disabled: boolean
  onChange: (value: number) => void
}) {
  return (
    <label className={css.sliderRow}>
      <span className={css.sliderLabel}>{props.label}</span>
      <input
        className={css.slider}
        type="range"
        min={0}
        max={props.max}
        step={1}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => { props.onChange(Number(event.currentTarget.value)) }}
      />
      <span className={css.sliderValue}>{props.value}{props.unit}</span>
    </label>
  )
}

/**
 * Render the background-image row.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function WallpaperRow({
  t, useStore, setBackgroundImage, clearBackgroundImage, setBackgroundOpacity, setBackgroundBlur,
}: WallpaperRowComponentProps) {
  const image = useStore(s => s.image)
  const opacity = useStore(s => s.opacity)
  const blur = useStore(s => s.blur)
  const [failure, setFailure] = useState<WallpaperEncodeFailure | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const hasImage = image !== ''

  const onFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.currentTarget.files?.[0]
    // Clear the input so re-choosing the same file fires change again.
    event.currentTarget.value = ''
    if (file === undefined) return
    setFailure(null)
    void setBackgroundImage(file).then((reason) => { setFailure(reason ?? null) })
  }

  return (
    <div className={css.group}>
      <div className={css.head}>
        <div className={css.rowText}>
          <div className={css.title}>{t('wallpaper.title')}</div>
          <div className={css.desc}>{t('wallpaper.description')}</div>
        </div>
        <div className={css.actions}>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              /* v8 ignore next -- the input renders unconditionally beside the button, so the ref is attached before any click */
              fileInput.current?.click()
            }}
          >
            {t(hasImage ? 'wallpaper.replace' : 'wallpaper.choose')}
          </Button>
          {hasImage && (
            <Button size="sm" variant="ghost" onClick={clearBackgroundImage}>{t('wallpaper.remove')}</Button>
          )}
        </div>
      </div>
      <input
        ref={fileInput}
        className={css.fileInput}
        type="file"
        accept="image/*"
        onChange={onFileChange}
      />
      {failure !== null && (
        <div className={css.error} role="alert">
          {t(failure === 'too-large' ? 'wallpaper.errorTooLarge' : 'wallpaper.errorUnsupported')}
        </div>
      )}
      {hasImage && <img className={css.preview} src={image} alt="" />}
      <SliderRow
        label={t('wallpaper.opacity')}
        value={opacity}
        max={BACKGROUND_OPACITY_MAX}
        unit={t('wallpaper.percentUnit')}
        disabled={!hasImage}
        onChange={setBackgroundOpacity}
      />
      <SliderRow
        label={t('wallpaper.blur')}
        value={blur}
        max={BACKGROUND_BLUR_MAX}
        unit={t('wallpaper.pixelUnit')}
        disabled={!hasImage}
        onChange={setBackgroundBlur}
      />
    </div>
  )
}
