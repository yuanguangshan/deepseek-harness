import type { EditRange } from './contract.ts'

/** The selection and edit family a `beforeinput` recorded, with the draft length it applied to. */
export interface PendingEdit {
  readonly start: number
  readonly end: number
  readonly draftLength: number
  readonly inputType: string
}

/**
 * Resolve one edit's range from the record taken before it applied.
 * A selection the edit replaces is the range outright. A caret delete replaces
 * nothing and reports the bare caret, so the removed span is whatever the draft
 * lost, on the side `inputType` names — measured, because one caret gesture can
 * remove a multi-unit grapheme, a word, or a line.
 * @param pending - record taken at `beforeinput`, null when none was seen.
 * @param prevLength - length of the draft the edit applied to.
 * @param nextLength - length of the resulting draft.
 * @returns the exact range, or undefined when the record cannot describe this
 * edit and the machine's diff scan has to recover it.
 */
export function editRangeOf(pending: PendingEdit | null, prevLength: number, nextLength: number): EditRange | undefined {
  if (pending === null || pending.draftLength !== prevLength) return undefined
  const { start, end, inputType } = pending
  // A DOM selection cannot invert; the check keeps that a precondition of the
  // math below rather than an assumption about the element.
  if (start > end || end > prevLength) return undefined
  const insertedLength = nextLength - prevLength + (end - start)
  if (insertedLength >= 0) return { start, end, insertedLength }
  if (start !== end) return undefined
  const removed = prevLength - nextLength
  if (inputType.endsWith('Backward')) {
    return removed <= start ? { start: start - removed, end: start, insertedLength: 0 } : undefined
  }
  if (inputType.endsWith('Forward')) {
    return start + removed <= prevLength ? { start, end: start + removed, insertedLength: 0 } : undefined
  }
  return undefined
}
