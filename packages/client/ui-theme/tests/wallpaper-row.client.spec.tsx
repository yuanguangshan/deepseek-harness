// @vitest-environment jsdom
/** Background-image settings row: choose/remove, preview, sliders, and refusals. */
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { WallpaperRow } from '../src/client/WallpaperRow.tsx'
import type { WallpaperRowComponentProps, WallpaperRowInjected } from '../src/client/WallpaperRow.tsx'
import { createWallpaperRowStore } from '../src/client/settings-store.ts'
import type { WallpaperEncodeFailure } from '../src/client/wallpaper.ts'

// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

afterEach(cleanup)

const COPY: Record<string, string> = {
  'wallpaper.title': 'Background image',
  'wallpaper.description': 'Add a custom background image to the whole interface',
  'wallpaper.choose': 'Choose image',
  'wallpaper.replace': 'Replace image',
  'wallpaper.remove': 'Remove',
  'wallpaper.opacity': 'Opacity',
  'wallpaper.blur': 'Blur',
  'wallpaper.percentUnit': '%',
  'wallpaper.pixelUnit': 'px',
  'wallpaper.errorTooLarge': 'Image is too large; choose one under 20 MB',
  'wallpaper.errorUnsupported': 'This image format cannot be read',
}

const IMAGE = 'data:image/webp;base64,AAAA'

function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined })
  return bindSnapshotSelector(store)
}
function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceSnapshot>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  })
  return bindSnapshotSelector(store)
}

type AttentionSnapshot = Parameters<Parameters<WallpaperRowComponentProps['useSessionPendingInteraction']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionPendingInteraction: WallpaperRowComponentProps['useSessionPendingInteraction'] = selector => selector(noAttention)

function mount(options: {
  image?: string
  opacity?: number
  blur?: number
  failure?: WallpaperEncodeFailure
} = {}) {
  // Real store instance — the sanctioned zero-machinery path for tests.
  const store = createWallpaperRowStore().create()
  store.actions.sync(options.image ?? '', options.opacity ?? 100, options.blur ?? 0, 0)
  const injected: WallpaperRowInjected = {
    setBackgroundImage: vi.fn(async () => options.failure),
    clearBackgroundImage: vi.fn(),
    setBackgroundOpacity: vi.fn(),
    setBackgroundBlur: vi.fn(),
  }
  const props: WallpaperRowComponentProps = {
    useSessions: emptySessions(),
    useSessionPendingInteraction,
    usePanelInfo,
    useResource,
    useWorkspaces: emptyWorkspaces(),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    t: (key: string) => COPY[key] ?? key,
    ...injected,
  }
  const view = render(<WallpaperRow {...props} />)
  return { store, ...injected, container: view.container }
}

const fileInput = (container: HTMLElement): HTMLInputElement => {
  const input = container.querySelector('input[type="file"]')
  if (input === null) throw new Error('the row did not render its file input')
  return input as HTMLInputElement
}

describe('WallpaperRow', () => {
  it('renders the copy with both sliders present but disabled while no image is set', () => {
    const { container } = mount()
    expect(screen.getByText('Background image')).toBeDefined()
    expect(screen.getByText('Add a custom background image to the whole interface')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Choose image' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByRole('slider', { name: /Opacity/ })).toHaveProperty('disabled', true)
    expect(screen.getByRole('slider', { name: /Blur/ })).toHaveProperty('disabled', true)
    expect(screen.getByText('100%')).toBeDefined()
    expect(screen.getByText('0px')).toBeDefined()
  })

  it('shows the preview, the replace and remove actions, and the persisted slider values once an image is stored', () => {
    const { container } = mount({ image: IMAGE, opacity: 40, blur: 6 })
    expect(screen.queryByRole('button', { name: 'Choose image' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Replace image' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDefined()
    expect(container.querySelector('img')?.getAttribute('src')).toBe(IMAGE)
    expect(screen.getByRole('slider', { name: /Opacity/ })).toHaveProperty('disabled', false)
    expect(screen.getByText('40%')).toBeDefined()
    expect(screen.getByText('6px')).toBeDefined()
  })

  it('routes slider changes to the injected setters', () => {
    const b = mount({ image: IMAGE, opacity: 40, blur: 6 })
    fireEvent.change(screen.getByRole('slider', { name: /Opacity/ }), { target: { value: '70' } })
    fireEvent.change(screen.getByRole('slider', { name: /Blur/ }), { target: { value: '12' } })
    expect(b.setBackgroundOpacity).toHaveBeenCalledWith(70)
    expect(b.setBackgroundBlur).toHaveBeenCalledWith(12)
  })

  it('routes the remove action to the injected clear', () => {
    const b = mount({ image: IMAGE })
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(b.clearBackgroundImage).toHaveBeenCalledOnce()
  })

  it('opens the file picker from the choose button', () => {
    const b = mount()
    const click = vi.spyOn(fileInput(b.container), 'click').mockImplementation(() => {})
    fireEvent.click(screen.getByRole('button', { name: 'Choose image' }))
    expect(click).toHaveBeenCalledOnce()
  })

  it('forwards a chosen file and shows no error when it is accepted', async () => {
    const b = mount()
    const chosen = new File(['x'], 'wall.png', { type: 'image/png' })
    fireEvent.change(fileInput(b.container), { target: { files: [chosen] } })
    await waitFor(() => { expect(b.setBackgroundImage).toHaveBeenCalledWith(chosen) })
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports a refused file with the reason-specific copy', async () => {
    const tooLarge = mount({ failure: 'too-large' })
    fireEvent.change(fileInput(tooLarge.container), { target: { files: [new File(['x'], 'wall.png')] } })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(COPY['wallpaper.errorTooLarge']) })

    cleanup()
    const unsupported = mount({ failure: 'unsupported' })
    fireEvent.change(fileInput(unsupported.container), { target: { files: [new File(['x'], 'wall.png')] } })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(COPY['wallpaper.errorUnsupported']) })
  })

  it('ignores a change event carrying no selection', () => {
    const b = mount()
    const input = fileInput(b.container)
    // jsdom reports `files` as null until a selection, then as an empty list.
    fireEvent.change(input)
    fireEvent.change(input, { target: { files: [] } })
    expect(b.setBackgroundImage).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
