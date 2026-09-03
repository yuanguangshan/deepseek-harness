import { describe, expect, it } from 'vitest'
import { extractImageMentions, isImageExtension } from '../src/atfile.ts'

describe('isImageExtension', () => {
  it('accepts the wire-supported image types', () => {
    expect(isImageExtension('a.png')).toBe(true)
    expect(isImageExtension('a.PNG')).toBe(true)
    expect(isImageExtension('dir/a.jpeg')).toBe(true)
    expect(isImageExtension('a.webp')).toBe(true)
    expect(isImageExtension('a.gif')).toBe(true)
  })

  it('rejects non-image and extensionless paths', () => {
    expect(isImageExtension('a.txt')).toBe(false)
    expect(isImageExtension('a')).toBe(false)
    expect(isImageExtension('a.md')).toBe(false)
  })
})

describe('extractImageMentions', () => {
  it('extracts bare mentions and strips them from the text', () => {
    const { text, mentions } = extractImageMentions('看看 @shots/a.png 和 @b.jpg 说明了什么')
    expect(text).toBe('看看 和 说明了什么')
    expect(mentions).toEqual([
      { path: 'shots/a.png', raw: '@shots/a.png', mediaType: 'image/png' },
      { path: 'b.jpg', raw: '@b.jpg', mediaType: 'image/jpeg' },
    ])
  })

  it('extracts quoted mentions with spaces', () => {
    const { text, mentions } = extractImageMentions('@"my shot 1.png" 好看')
    expect(text).toBe('好看')
    expect(mentions).toEqual([{ path: 'my shot 1.png', raw: '@"my shot 1.png"', mediaType: 'image/png' }])
  })

  it('leaves non-image @mentions untouched', () => {
    const { text, mentions } = extractImageMentions('看 @src/index.ts 和 @notes')
    expect(text).toBe('看 @src/index.ts 和 @notes')
    expect(mentions).toEqual([])
  })

  it('expands ~/ through the resolver', () => {
    const { mentions } = extractImageMentions('看 @~/Desktop/s.png', p => `<home>${p.slice(p.indexOf('/Desktop'))}`)
    expect(mentions[0]?.path).toBe('<home>/Desktop/s.png')
  })
})
