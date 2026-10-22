import { describe, expect, test, afterEach, jest } from '@jest/globals'
import TopObserver from '../main/app/observer/top_observer.js'
import Nodes from '../main/app/nodes/index.js'
import Sanitizer from '../main/app/sanitizer.js'
import selection from '../main/modules/selection.js'
import { Type } from '../common/messages.gen.js'

let sent: any[]
let observer: TopObserver
let app: any

function setup(body: string, sanitizerOptions: Record<string, any> = {}) {
  document.documentElement.innerHTML = `<head></head><body>${body}</body>`
  sent = []
  const listeners: Array<() => void> = []
  app = {
    options: { forceNgOff: true },
    safe: (f: any) => f,
    send: (msg: any) => sent.push(msg),
    getBaseHref: () => 'http://localhost/',
    callResanitizeCallbacks: jest.fn(),
    attachEventListener: (_t: any, _e: string, l: () => void) => listeners.push(l),
    debug: { log: jest.fn(), warn: jest.fn(), info: jest.fn(), error: jest.fn() },
  }
  app.nodes = new Nodes({ node_id: '__openreplay_id', forceNgOff: true, maintainer: { enabled: false } })
  app.sanitizer = new Sanitizer({ app, options: sanitizerOptions })
  app.attributeSender = {
    sendSetAttribute: (id: number, name: string, value: string) =>
      app.send([Type.SetNodeAttribute, id, name, value]),
  }
  observer = new TopObserver({ app, options: { disableThrottling: true } })
  observer.observe()
  selection(app)
  return () => listeners.forEach((l) => l())
}

const attr = (el: Element, name: string) =>
  sent.find((m) => m[0] === Type.SetNodeAttribute && m[1] === app.nodes.getID(el) && m[2] === name)?.[3]

function select(from: Node, to: Node, fire: () => void) {
  const range = document.createRange()
  range.setStart(from, 0)
  range.setEnd(to, to.textContent!.length)
  const sel = document.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
  fire()
  return sent.filter((m) => m[0] === Type.SelectionChange).pop()?.[3]
}

afterEach(() => {
  observer.disconnect()
  document.getSelection()?.removeAllRanges()
})

describe('attributes of masked elements', () => {
  test('text attributes are masked, layout attributes are kept', () => {
    setup('<span id="s" data-openreplay-obscured title="SSN 123" aria-label="secret" data-email="a@b.c" class="big">x</span>')
    const s = document.getElementById('s')!
    expect(attr(s, 'title')).toBe('*** ***')
    expect(attr(s, 'aria-label')).toBe('******')
    expect(attr(s, 'data-email')).toBe('*****')
    expect(attr(s, 'class')).toBe('big')
  })

  test('children of masked elements inherit the masking', () => {
    setup('<div data-openreplay-obscured><img id="i" alt="John Smith"></div>')
    expect(attr(document.getElementById('i')!, 'alt')).toBe('**** *****')
  })

  test('attributes of unmasked elements are unchanged', () => {
    setup('<span id="s" title="Help">x</span>')
    expect(attr(document.getElementById('s')!, 'title')).toBe('Help')
  })
})

describe('selected text', () => {
  test('selection inside visible text is sent', () => {
    const fire = setup('<p id="p">hello world</p>')
    const t = document.getElementById('p')!.firstChild!
    expect(select(t, t, fire)).toBe('hello world')
  })

  test('selection inside masked text is masked', () => {
    const fire = setup('<p id="p" data-openreplay-obscured>secret text</p>')
    const t = document.getElementById('p')!.firstChild!
    expect(select(t, t, fire)).toBe('****** ****')
  })

  test('selection spanning a masked element is masked', () => {
    const fire = setup('<p id="a">start</p><p data-openreplay-obscured>secret</p><p id="b">end</p>')
    const a = document.getElementById('a')!.firstChild!
    const b = document.getElementById('b')!.firstChild!
    expect(select(a, b, fire)).not.toContain('secret')
  })

  test('selection spanning a hidden (unrecorded) element is masked', () => {
    const fire = setup('<p id="a">start</p><div data-openreplay-hidden>secret</div><p id="b">end</p>')
    const a = document.getElementById('a')!.firstChild!
    const b = document.getElementById('b')!.firstChild!
    expect(select(a, b, fire)).not.toContain('secret')
  })

  test('privateMode masks selections', () => {
    const fire = setup('<p id="p" data-openreplay-unmask>hello</p>', { privateMode: true })
    const t = document.getElementById('p')!.firstChild!
    expect(select(t, t, fire)).toBe('*****')
  })
})
