/**
 * Model picker dialog: a filter box + `SelectList` overlay, so the user can
 * type to narrow the model list (case-insensitive substring over id / name /
 * route) and then pick with the arrow keys + Enter. Mirrors the model selector
 * the deleted official TUI shipped, ported to this REPL's pi-tui 0.84.1 API:
 * a self-contained `Component` whose `handleInput` routes input between the
 * filter `Input` and the `SelectList`, re-filtering on each keystroke.
 */

import { Input, SelectList, matchesKey, type Component } from '@earendil-works/pi-tui'

/** One model choice surfaced in the picker. */
export interface ModelChoice {
  readonly id: string
  readonly name: string
  readonly route: 'responses' | 'completions'
  readonly contextWindow: number | undefined
}

/** Theme callbacks the dialog uses for the underlying list. */
export interface PickerTheme {
  selectedPrefix: (s: string) => string
  selectedText: (s: string) => string
  description: (s: string) => string
  scrollInfo: (s: string) => string
  noMatch: (s: string) => string
}

/** Compose a select item row from a model choice. */
function toSelectItem(choice: ModelChoice, ctx: (n: number | undefined) => string): { value: string; label: string; description: string } {
  return {
    value: choice.id,
    label: choice.id,
    description: `${choice.name} · ctx ${ctx(choice.contextWindow)} · ${choice.route}`,
  }
}

/**
 * A model-picker overlay: an `Input` filter line above a `SelectList`.
 * `done(choiceId, route)` is called on Enter; `cancel()` on Escape with an
 * empty filter. Shift+Tab would change reasoning-effort upstream — not wired
 * here (the REPL runtime does not expose effort selection through its route).
 */
export class ModelPickerDialog implements Component {
  private readonly filter = new Input()
  private list: SelectList
  private readonly choices: ReadonlyMap<string, ModelChoice>
  private readonly theme: PickerTheme
  private readonly maxVisible: number

  constructor(
    choices: readonly ModelChoice[],
    currentId: string | undefined,
    maxVisible: number,
    theme: PickerTheme,
    private readonly done: (choice: ModelChoice) => void,
    private readonly cancel: () => void,
    private readonly fmtCtx: (n: number | undefined) => string,
  ) {
    this.theme = theme
    this.maxVisible = maxVisible
    this.choices = new Map(choices.map(c => [c.id, c]))
    this.filter.setValue('')
    this.filter.focused = true
    this.list = this.buildList(currentId)
  }

  /** Rebuild the list from the current filter, keeping `selectValue` selected when present. */
  private buildList(selectValue: string | undefined): SelectList {
    const items = this.filteredItems()
    const list = new SelectList(items, this.maxVisible, this.theme)
    const index = selectValue === undefined ? 0 : items.findIndex(item => item.value === selectValue)
    list.setSelectedIndex(Math.max(0, index))
    list.onSelect = (item) => {
      const choice = this.choices.get(item.value)
      if (choice !== undefined) this.done(choice)
    }
    list.onCancel = this.cancel
    return list
  }

  /** Case-insensitive substring filter over id, name, and route. */
  private filteredItems(): Array<{ value: string; label: string; description: string }> {
    const query = this.filter.getValue().trim().toLocaleLowerCase()
    const all = [...this.choices.values()]
    if (query === '') return all.map(c => toSelectItem(c, this.fmtCtx))
    return all
      .filter(c => [c.id, c.name, c.route].some(field => field.toLocaleLowerCase().includes(query)))
      .map(c => toSelectItem(c, this.fmtCtx))
  }

  invalidate(): void {
    this.filter.invalidate()
    this.list.invalidate()
  }

  render(width: number): string[] {
    const hint = '\x1b[90m /model 搜索（输入过滤 · Esc 清空 / 再按退出）\x1b[0m'
    const filterLine = this.filter.render(width)
    return [hint, ...(filterLine.length > 0 ? filterLine : ['']), ...this.list.render(width)]
  }

  /** Route input: arrows/Enter → list; Escape → clear filter (or cancel); text → filter. */
  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) {
      if (this.filter.getValue() === '') {
        this.cancel()
      } else {
        this.filter.setValue('')
        this.list = this.buildList(undefined)
      }
      return
    }
    if (matchesKey(data, 'up') || matchesKey(data, 'down') || matchesKey(data, 'enter')) {
      this.list.handleInput(data)
      return
    }
    const previous = this.filter.getValue()
    this.filter.focused = true
    this.filter.handleInput(data)
    if (this.filter.getValue() !== previous) {
      this.list = this.buildList(undefined)
    }
  }
}
