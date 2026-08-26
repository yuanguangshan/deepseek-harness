/**
 * Generic filterable picker overlay: a search box + `SelectList`, so the user
 * can type to narrow a list (case-insensitive substring over label/description/
 * value) and then pick with the arrow keys + Enter. `/model`, `/resume`, and
 * `/memory edit` all drive this one dialog.
 */

import { Input, SelectList, matchesKey, type Component } from '@earendil-works/pi-tui'

/** One choice surfaced in the picker. */
export interface PickerItem {
  readonly value: string
  readonly label: string
  readonly description: string
}

/** Theme callbacks the dialog uses for the underlying list. */
export interface PickerTheme {
  selectedPrefix: (s: string) => string
  selectedText: (s: string) => string
  description: (s: string) => string
  scrollInfo: (s: string) => string
  noMatch: (s: string) => string
}

/**
 * A filterable picker overlay: an `Input` filter line above a `SelectList`.
 * `done(item)` is called on Enter; `cancel()` on Escape with an empty filter.
 */
export class FilterPickerDialog implements Component {
  private readonly filter = new Input()
  private list: SelectList
  private readonly items: ReadonlyMap<string, PickerItem>
  private readonly theme: PickerTheme
  private readonly maxVisible: number

  constructor(
    items: readonly PickerItem[],
    currentValue: string | undefined,
    maxVisible: number,
    theme: PickerTheme,
    private readonly done: (item: PickerItem) => void,
    private readonly cancel: () => void,
    private readonly hint: string,
  ) {
    this.theme = theme
    this.maxVisible = maxVisible
    this.items = new Map(items.map(item => [item.value, item]))
    this.filter.setValue('')
    this.filter.focused = true
    this.list = this.buildList(currentValue)
  }

  /** Rebuild the list from the current filter, keeping `selectValue` selected when present. */
  private buildList(selectValue: string | undefined): SelectList {
    const visible = this.filteredItems()
    const list = new SelectList(visible, this.maxVisible, this.theme)
    const index = selectValue === undefined ? 0 : visible.findIndex(item => item.value === selectValue)
    list.setSelectedIndex(Math.max(0, index))
    list.onSelect = (item) => {
      const chosen = this.items.get(item.value)
      if (chosen !== undefined) this.done(chosen)
    }
    list.onCancel = this.cancel
    return list
  }

  /** Case-insensitive substring filter over value, label, and description. */
  private filteredItems(): PickerItem[] {
    const query = this.filter.getValue().trim().toLocaleLowerCase()
    const all = [...this.items.values()]
    if (query === '') return all
    return all.filter(item =>
      [item.value, item.label, item.description].some(field => field.toLocaleLowerCase().includes(query)),
    )
  }

  invalidate(): void {
    this.filter.invalidate()
    this.list.invalidate()
  }

  render(width: number): string[] {
    return [this.hint, ...(this.filter.render(width).length > 0 ? this.filter.render(width) : ['']), ...this.list.render(width)]
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
