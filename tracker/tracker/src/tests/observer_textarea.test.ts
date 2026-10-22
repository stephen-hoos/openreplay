import { describe, expect, test, afterEach, jest } from '@jest/globals'
import TopObserver from '../main/app/observer/top_observer.js'
import Nodes from '../main/app/nodes/index.js'
import Sanitizer from '../main/app/sanitizer.js'
import { Type } from '../common/messages.gen.js'

let sent: any[]
let observer: TopObserver

function setup(body: string) {
  document.documentElement.innerHTML = `<head></head><body>${body}</body>`
  sent = []
  const app: any = {
    options: { forceNgOff: true },
    safe: (f: any) => f,
    send: (msg: any) => sent.push(msg),
    getBaseHref: () => 'http://localhost/',
    callResanitizeCallbacks: jest.fn(),
    debug: { log: jest.fn(), warn: jest.fn(), info: jest.fn(), error: jest.fn() },
  }
  app.nodes = new Nodes({ node_id: '__openreplay_id', forceNgOff: true, maintainer: { enabled: false } })
  app.sanitizer = new Sanitizer({ app, options: {} })
  app.attributeSender = {
    sendSetAttribute: (id: number, name: string, value: string) =>
      app.send([Type.SetNodeAttribute, id, name, value]),
  }
  observer = new TopObserver({ app, options: { disableThrottling: true } })
}

const nodeData = () => sent.filter((m) => m[0] === Type.SetNodeData).map((m) => m[2])
const flush = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  observer.disconnect()
})

describe('textarea text nodes', () => {
  test('initial textarea content is not sent in plain text', () => {
    setup('<textarea id="t">my secret note</textarea><p>visible text</p>')
    observer.observe()
    expect(nodeData()).not.toContain('my secret note')
    expect(nodeData()).toContain('** ****** ****')
    expect(nodeData()).toContain('visible text')
  })

  test('updated textarea content (React defaultValue) is not sent in plain text', async () => {
    setup('<textarea id="t"></textarea>')
    observer.observe()
    const t = document.getElementById('t') as HTMLTextAreaElement
    t.defaultValue = 'typed secret'
    await flush()
    expect(nodeData()).not.toContain('typed secret')
    expect(nodeData()).toContain('***** ******')
  })
})
