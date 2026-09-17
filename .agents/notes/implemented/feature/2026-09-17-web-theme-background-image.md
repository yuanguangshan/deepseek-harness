# Agent Note: User background image for the Web theme

Status: implemented

English | [中文](2026-09-17-web-theme-background-image.zh.md)

## Problem

The `ui-theme` settings surface owned two axes: the light/dark/system palette and the conversation content font size. Users who wanted a personal backdrop had no supported route — the `--dsw-*` palette is the sole color authority, themes register alias-token overrides only, and no surface let a user attach an image. The layout also painted every column with opaque fills (`--dsw-alias-bg-base` on the frame, `--dsw-specific-sidebar-fill` on the sidebar), so an image placed behind the application would have been invisible without changing those surfaces.

## Decision

One optional background image, owned end to end by `dsh-client-ui-theme`:

- **Durable state.** The `ui-theme` settings namespace adds `backgroundImage` (a `data:image/…` URL, empty for none), `backgroundOpacity` (integer 0–100), and `backgroundBlur` (integer 0–24 px), each with a schema default. `ThemeSnapshot` carries them as a frozen `background` object, and `ThemeRuntime` exposes `setBackgroundImage`, `setBackgroundOpacity`, and `setBackgroundBlur` as the only write entries; `adopt()` compares and adopts all five durable fields. Writes ride the existing [Host-backed preference boundary](../../bug-fix/2026-08-06-host-backed-web-preferences.md).
- **Bounded intake.** The settings row hands the chosen `File` to its injected face, which calls `encodeWallpaperFile` in `client/wallpaper.ts`: refuse a source above 20 MB or one `createImageBitmap` cannot decode, scale the longer edge to at most 2560 px, draw to a canvas, and encode WebP at 0.85 with a JPEG fallback when the engine answers a non-WebP data URL. The durable value is therefore a re-encoded image, never the original file, and no separate asset store or HTTP route exists. Refusals return `'too-large'` or `'unsupported'`, which the row renders through localized copy; the encode lives outside the component so the presentation layer stays pure.
- **Projection.** ui-layout's `ThemePresenter` writes `--dsh-wallpaper-image` (`url("…")`), `--dsh-wallpaper-opacity` (0–1), and `--dsh-wallpaper-blur` (`Npx`) on body and toggles `data-dsh-wallpaper`; with no image it removes all four, so a cleared image leaves no stale layer.
- **Painting.** `wallpaper.css` paints a fixed `body[data-dsh-wallpaper]::before` at `z-index: -1` — below in-flow backgrounds but above the canvas the body background propagates to — with the presenter's variables, bleeding past the viewport by twice the blur radius so no blurred edge reveals the canvas. The same sheet rebinds `--dsh-app-background` and `--dsh-app-sidebar-background` to translucent `color-mix` tints of `--dsw-alias-bg-base` and `--dsw-specific-sidebar-fill`. Every full-bleed column surface reads those indirections with the opaque token as fallback — ui-layout's frame and sidebar track, ui-sidebar's root, and ui-conversation's root, including the composer seat's fade mask — while cards, code blocks, and panels keep their solid fills and stay readable. Every color decision therefore stays in ui-theme, and no feature package targets another's class names.
- **Surface.** A third General-section row (`id: 'wallpaper'`, order 12) offers choose/replace, remove, a preview, and the two sliders; the copy lives in the `settings.theme` dictionary for both locales, and the pre-plugin bootstrap deliberately does not embed the image so index responses stay small.

## Alternatives considered

- **Store an image URL instead of the bytes.** Rejected: the requirement was a locally chosen file, and an external URL introduces network, CSP, and durability failure modes the durable settings document should not own.
- **Persist the original file as an attachment and serve it through a Host route.** Rejected for this change: it adds a route, a cleanup story, and a settings-to-asset reference, while the encoded-and-bounded data URL already keeps the document within a few hundred kilobytes. The inline-storage limitation is recorded in the package README.
- **Make `--dsw-alias-bg-base` translucent under the wallpaper attribute.** Rejected: the body background propagates to the canvas, so a translucent base would also lighten overscroll and every surface reading the alias, including code blocks and message cards. A dedicated pair of indirections localizes the rebind to the full-bleed column surfaces.
- **Apply the wallpaper only to the conversation column.** Rejected by the stated scope: the image covers the whole application, and the sidebar keeps its own tint so the columns stay distinguishable.
- **Encode the image in the React component.** Rejected: canvas work is a browser capability, not presentation, and the component cannot surface a typed refusal without owning encoding errors.

## Consequences

- The theme settings document now carries an image payload; every settings write re-serializes the whole document, so a large wallpaper makes unrelated writes marginally heavier. Downscaling and re-encoding bound that cost.
- Non-loopback pages keep the image process-local like the other `ui-theme` values, and clearing it leaves no file to reclaim.
- `ThemeSnapshot` gained a required `background` member, so every consumer constructing a snapshot literal must supply it; the Gui suites and the terminal fixtures were updated in the same change.
- A future separate asset store can replace the data URL without touching the runtime API: `setBackgroundImage` already accepts any `data:image/…` string.

## Testing

`wallpaper.client.spec.ts` covers the byte bound, downscale geometry, the one-pixel clamp, the JPEG fallback, and the undecodable refusal; `wallpaper-row.client.spec.tsx` covers the choose/remove/slider gestures, the refusal copy, and the empty selection; `theme.client.spec.ts` and `host.client.spec.ts` cover the new setters, their bounds, adoption, and the Host schema; `theme-presenter.client.spec.ts` covers variable publication, retraction, and dispose. `pnpm run test:gui` passes for these packages; two pre-existing stylesheet-contract failures in `ui-settings-sysadmin` and one in `ui-model-selection` are unrelated to this change and were red before it.
