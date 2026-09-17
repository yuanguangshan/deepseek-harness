---
description: "Theme, content-font-size, and background-image settings for the dsh web client: --dsw-* token stylesheets, ThemeRuntime state, General settings rows, and the pre-plugin bootstrap."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-theme

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-theme` lets Web GUI users choose `light`, `dark`, or `system`, set conversation content text from 12 to 17 px, and set a background image with its layer opacity and blur in Settings. A loopback client stores every value in the `ui-theme` settings namespace, which the local provider persists in `$DSH_HOME/settings.yaml` by default. The plugin resolves `system` through `prefers-color-scheme` and publishes immutable `ThemeSnapshot`s; ui-layout applies each snapshot to the document. The package also ships the `--dsw-*` token stylesheets, including the background-image layer, and injects a synchronous bootstrap so the selected palette and font size apply before the shell loads. Third-party themes can register alias-token overrides through `ctx.theme`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Users switch the color scheme, set the content font size, and choose a background image from three rows in Settings (General section); every choice persists across restarts on a loopback browser. Feature plugins consume the current snapshot through `ctx.theme` and read the `--dsw-*` tokens in CSS; they do not manage theme state themselves.

### Appearance and font size

The plugin registers Appearance preference cubes and a font-size stepper in the General section. The stepper accepts integer values from 12 through 17 px and defaults to 14 px. It changes conversation headings and base text by the same increment, including the user bubble and composer draft; flow-row titles, summaries, and tables follow one step under the body size, while small text and code keep fixed sizes. Each accepted change writes through the Host settings API. Rapid changes serialize in gesture order with namespace revisions, and a rejected latest write reloads the durable values. Non-loopback pages keep both choices process-local.

### Background image

The plugin registers a background-image row that stores the chosen file as a bounded `data:image/…` URL in the same namespace, alongside its layer opacity (0 through 100%) and blur radius (0 through 24 px). Choosing a file decodes it, scales its longer edge to at most 2560 px, and re-encodes it as WebP, falling back to JPEG when the engine has no WebP encoder; a source above 20 MB or one the browser cannot decode is refused with the row's localized message. The image applies to the whole application: ui-layout writes the URL, opacity, and blur as body variables and toggles `body[data-dsh-wallpaper]`, and `wallpaper.css` paints a fixed layer below the application surfaces while rebinding the full-bleed column surfaces — the layout frame and sidebar track, the sidebar root, and the conversation root — to translucent tints. Cards and panels keep their solid fills and stay readable over the image. Clearing the image removes the attribute, the variables, and the rebinds together. The settings document is written through the Host settings API like the other values; the pre-plugin bootstrap does not embed the image, so the first paint has no background and the layer appears when the client adopts the persisted value.

### Registering a theme

A composition can register a third-party theme id with alias-token overrides through `ctx.theme`; the override layer folds into the active snapshot's tokens in registration order. Removing one never overwrites the last durable built-in preference. Third-party theme ids remain an in-process extension and do not cross the built-in settings schema.

### Pre-plugin palette

When the host composition includes an HTTP server, the host half embeds the registered `ui-theme` settings, or schema defaults, into each index response. Head CSS selects the document canvas color scheme before any script runs, including a `prefers-color-scheme` query for the `system` preference. A body script then sets `body[data-ds-dark-theme]` and `--dsh-content-font-size` before the loading page and application scripts, so the first paint uses the selected palette and text size.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The service owns theme and font-size state and publishes snapshots. The ui-layout presenter applies those snapshots, and the token sheets own the color and conversation text scales.

### Stylesheets

`src/styles/` holds seven sheets imported in order by ui-theme's dynamic client entry: `base.css`, `corner-shape.css`, `design-platform.css`, `scrollbar.css`, `gradient-shadow-text.css`, `shiki.css`, and `wallpaper.css`. The client bundle compiles and injects them as plugin-owned global styles, so unload and HMR remove them with ui-theme. `scrollbar.css` is the sole consumer of the `--dsw-alias-scrollbar-*` tokens and must follow `design-platform.css`, which declares them.

`wallpaper.css` owns the background-image layer: under `body[data-dsh-wallpaper]` it paints a fixed `::before` from `--dsh-wallpaper-image`, applies `--dsh-wallpaper-opacity` and `--dsh-wallpaper-blur`, and rebinds `--dsh-app-background` and `--dsh-app-sidebar-background` to translucent `color-mix` tints of the active surface tokens. ui-layout's frame and sidebar track, ui-sidebar's root, and ui-conversation's root read those two indirections with the opaque token as the fallback, so every background-image color decision stays in ui-theme while cards and panels keep their solid fills.

`corner-shape.css` smooths every rounded corner: inside `@supports (corner-shape: superellipse(1.5))` it defines `--dsw-corner-shape` and applies it to all elements and their `::before`/`::after` through the universal selector, so engines without `corner-shape` keep circular corners. Full-round shapes — `border-radius: 50%` circles and pill radii — pair `corner-shape: round` with their radius in the owning component sheet because a superellipse deforms them; the corner-shape stylesheet spec enforces that pairing across every package stylesheet.

`gradient-shadow-text.css` derives `--dsh-content-font-delta` from `--dsh-content-font-size` and shifts the Markdown heading and base-text ladder by that increment. It also derives the secondary tier `--dsh-content-font-size-secondary` (setting −1 at ≤14, setting −2 above; 13px at the default) with its own `--dsh-content-font-delta-secondary` for the table variants and the flow rows one step under the body. Dense small and code variants stay fixed. Outside the ladder, the user bubble and composer draft read the body pair directly, and flow-row titles and summaries read the secondary pair. The sheet also owns the shadow scale (`--dsw-shadow-lv*`) and the elevation tokens: `--dsw-elevation-stroke` draws a 0.5px hairline through the rebindable `--dsw-elevation-stroke-color`, and `--dsw-elevation-panel`/`--dsw-elevation-prominent`/`--dsw-elevation-soft` (the composer's larger-blur, lower-alpha tier) layer two faint soft shadows over that stroke, so elevated surfaces set `border: 0` and carry no layout-consuming outline; the derived tokens are re-declared per element so a surface's stroke-color rebind takes effect.

### Scrollbar rebinding

`scrollbar.css` binds `--dsh-scrollbar-thumb` and `--dsh-scrollbar-thumb-hover` on `body` to the l1 base-surface tokens; an elevated surface (menu, popover, dialog) rebinds them to the l2 tokens on its own container, and the pair's other legal target is `transparent` (ui-sidebar rebinds its column that way while the pointer is elsewhere). WebKit-based browsers also read `--dsh-scrollbar-width`, `--dsh-scrollbar-thumb-border`, and `--dsh-scrollbar-track-margin`; a scroll surface may rebind them to keep a wide draggable rail around a narrower visible thumb or to inset the track from rounded ends. The two rendering paths are mutually exclusive by construction: Firefox takes the standard thin scrollbar inside `@supports not selector(::-webkit-scrollbar)`, and WebKit-based engines take the pseudo-elements, so geometry and hover customization apply only through the pseudo-element path.

### Preference persistence

The service provides itself immediately with the schema defaults on a loopback browser, then loads the `ui-theme` namespace and writes each accepted theme, font-size, or background-image change through the Host settings API. Pushed settings changes and reconnects refetch the namespace. Non-loopback pages do not create that Host-backed scope. The persistence boundary is owned by the [Host-backed preferences note](../../../.agents/notes/implemented/bug-fix/2026-08-06-host-backed-web-preferences.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the layout presenter, the token consumers, and the styling rules.

- [ui-layout](../ui-layout/README.md) — the presenter that applies the resolved theme snapshot.
- [ui-sidebar](../ui-sidebar/README.md) — a consumer of the scrollbar rebinding contract.
- [ui-conversation](../ui-conversation/README.md) — a consumer of `--dsh-scrollbar-width` for the composer seat.
- [Web styling](../../../docs/web-styling.md) — the authoritative styling rules for web client components.
- [Host-backed preferences](../../../.agents/notes/implemented/bug-fix/2026-08-06-host-backed-web-preferences.md) — the persistence boundary decision.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the theme extension surface and the color authority; they are current package constraints.

- **Third-party themes are an extension point, not a product** — registering one means overriding same-named alias variables; no validation exists that an override set is complete.
- **The background image is stored inline in the settings document** — it is downscaled and re-encoded before persisting, so the durable value stays bounded, but there is no separate asset store and no image-URL form; a cleared image leaves no file to reclaim.
- **The token sheets are the sole color authority** — values absent from the design system are deliberately not appended; the nearest semantic token wins, and design-owner-approved additions enter as a static step plus a semantic alias in the same change.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The settings scope validates and publishes the durable theme section, while the registry emits `theme/change` synchronously with its own mutations. Store/registry agreement is covered directly by this package's Host, scope, and service behavior specs.
