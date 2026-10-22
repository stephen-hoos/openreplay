// @ts-nocheck
import { describe, expect, test, jest, beforeAll, afterAll, afterEach } from '@jest/globals'
import App from '../main/app/index.js'

jest.mock('@openreplay/network-proxy', () => ({
  default: jest.fn(() => 'mocked network-proxy content'),
}))

const baseOptions = {
  projectKey: 'test-project-key',
  ingestPoint: 'test-ingest-point',
  respectDoNotTrack: false,
  network: {},
  mouse: {},
  __DISABLE_SECURE_MODE: true,
}

const BATCH = 'batch of messages from an iframe window'
const START_IFRAME = 'start tracker inside frame'

function makeApp(crossdomain?: Record<string, any>) {
  const app = new App(baseOptions.projectKey, undefined, { ...baseOptions, crossdomain }, jest.fn(), false)
  app.active = () => true
  app.messages = []
  return app
}

function batchFrom(source: any, origin = 'https://child.example') {
  return { source, origin, data: { line: BATCH, context: 'ctx', messages: [[42, 'injected']] } }
}

describe('crossdomain messages', () => {
  let addListener: any

  beforeAll(() => {
    Object.defineProperty(window, 'performance', { value: { timing: {}, now: jest.fn(() => 1000) } })
    Object.defineProperty(window, 'Worker', { value: jest.fn(() => 'mocked worker content') })
    globalThis.IntersectionObserver = jest.fn(() => ({
      observe: jest.fn(),
      unobserve: jest.fn(),
      disconnect: jest.fn(),
    }))
  })

  afterAll(() => {
    delete window.performance
    delete window.Worker
    delete globalThis.IntersectionObserver
  })

  afterEach(() => {
    document.body.innerHTML = ''
    addListener?.mockRestore()
  })

  test('no cross-frame listener unless crossdomain is enabled', () => {
    addListener = jest.spyOn(window, 'addEventListener')
    const app = makeApp()
    expect(addListener.mock.calls.some(([, l]) => l === app.crossDomainIframeListener)).toBe(false)
    addListener.mockRestore()

    addListener = jest.spyOn(window, 'addEventListener')
    const enabled = makeApp({ enabled: true })
    expect(addListener.mock.calls.some(([, l]) => l === enabled.crossDomainIframeListener)).toBe(true)
  })

  test('batches from a child iframe are merged', () => {
    const app = makeApp({ enabled: true })
    const frame = document.createElement('iframe')
    document.body.appendChild(frame)
    app.crossDomainIframeListener(batchFrom(frame.contentWindow))
    expect(app.messages).toContainEqual([42, 'injected'])
  })

  test('batches from a window that is not a child iframe are ignored', () => {
    const app = makeApp({ enabled: true })
    const opener = { postMessage: jest.fn() }
    app.crossDomainIframeListener(batchFrom(opener))
    expect(app.messages).toEqual([])
  })

  test('childDomains restricts which iframes are accepted', () => {
    const app = makeApp({ enabled: true, childDomains: ['https://widgets.example'] })
    const frame = document.createElement('iframe')
    document.body.appendChild(frame)
    app.crossDomainIframeListener(batchFrom(frame.contentWindow, 'https://ads.example'))
    expect(app.messages).toEqual([])
    app.crossDomainIframeListener(batchFrom(frame.contentWindow, 'https://widgets.example'))
    expect(app.messages).toContainEqual([42, 'injected'])
  })

  test('start commands are only accepted from the parent window', () => {
    const app = makeApp({ enabled: true })
    const setToken = jest.spyOn(app.session, 'setSessionToken')
    app.parentCrossDomainFrameListener({
      source: { postMessage: jest.fn() },
      origin: 'https://evil.example',
      data: { line: START_IFRAME, token: 'attacker-token', id: 1 },
    })
    expect(setToken).not.toHaveBeenCalled()
  })
})
