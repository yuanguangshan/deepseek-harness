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
 * When `onDelete` is supplied, ctrl+d (or the Delete key) on a highlighted
 * row deletes instead of selecting — the /resume picker uses this for
 * cleaning up historical sessions.
 */
export class FilterPickerDialog implements Component {
  private readonly filter = new Input()
  private list: SelectList
  private readonly items: ReadonlyMap<string, PickerItem>
  private readonly theme: PickerTheme
  private readonly maxVisible: number
  private readonly onDelete: ((item: PickerItem) => void) | undefined

  constructor(
    items: readonly PickerItem[],
    currentValue: string | undefined,
    maxVisible: number,
    theme: PickerTheme,
    private readonly done: (item: PickerItem) => void,
    private readonly cancel: () => void,
    private readonly hint: string,
    onDelete?: (item: PickerItem) => void,
  ) {
    this.theme = theme
    this.maxVisible = maxVisible
    this.onDelete = onDelete
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

  /** Route input: arrows/Enter → list; ctrl+d/Delete → delete (when armed); Escape → clear filter (or cancel); text → filter. */
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
    if (this.onDelete !== undefined && (matchesKey(data, 'ctrl+d') || data === '\x1b[3~')) {
      const selected = this.list.getSelectedItem()
      if (selected !== null) {
        const chosen = this.items.get(selected.value)
        if (chosen !== undefined) this.onDelete(chosen)
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

/**
 * A two-line confirmation overlay: a message plus exactly two outcomes
 * (Enter = confirm, Esc/any other key = cancel). Used for irreversible
 * actions such as deleting a historical session.
 */
export class ConfirmDialog implements Component {
  private readonly messageLines: readonly string[]

  constructor(
    message: string,
    private readonly onConfirm: () => void,
    private readonly onCancel: () => void,
    private readonly hint: string,
  ) {
    this.messageLines = message.split('\n')
  }

  invalidate(): void {}

  render(width: number): string[] {
    void width
    return [...this.messageLines, this.hint]
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'enter')) {
      this.onConfirm()
      return
    }
    // Any other key cancels: Esc, n, arrows — irreversible actions resolve
    // strictly, so confirmation requires a deliberate Enter.
    this.onCancel()
  }
}
