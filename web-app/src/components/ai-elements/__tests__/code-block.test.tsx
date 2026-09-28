import { describe, expect, it } from 'vitest'

import { highlightCode } from '../code-block'

const code = '<!DOCTYPE html>\n<html>\n<head>'

// What a selection copies: the text nodes, in document order.
function selectableText(html: string) {
  const root = document.createElement('div')
  root.innerHTML = html
  return root.textContent ?? ''
}

describe('highlightCode line numbers', () => {
  it('keeps line numbers out of the copyable text (#280)', async () => {
    const [light, dark] = await highlightCode(code, 'html', true)

    for (const html of [light, dark]) {
      expect(selectableText(html)).toBe(code)
    }
  })

  it('still numbers every line through a data attribute', async () => {
    const [light] = await highlightCode(code, 'html', true)
    const root = document.createElement('div')
    root.innerHTML = light

    const gutters = [...root.querySelectorAll('[data-line-number]')]
    expect(gutters.map((node) => node.getAttribute('data-line-number'))).toEqual(
      ['1', '2', '3']
    )
    for (const gutter of gutters) {
      expect(gutter.getAttribute('aria-hidden')).toBe('true')
      expect(gutter.className).toContain(
        'before:content-[attr(data-line-number)]'
      )
    }
  })

  it('adds no gutter when line numbers are off', async () => {
    const [light] = await highlightCode(code, 'html', false)

    expect(light).not.toContain('data-line-number')
    expect(selectableText(light)).toBe(code)
  })
})
