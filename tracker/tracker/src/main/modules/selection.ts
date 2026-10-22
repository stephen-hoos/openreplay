import type App from '../app/index.js'
import { SelectionChange } from '../app/messages.gen.js'
import { stringWiper } from '../app/sanitizer.js'

// Selections over more text nodes than this are masked instead of inspected node by node.
const MAX_INSPECTED_TEXT_NODES = 500

/**
 * The selected text can span several nodes, including masked or hidden ones that are not
 * recorded at all, so it may only be sent as-is if every text node it covers is recorded and
 * not masked. Otherwise the whole text is masked.
 */
function selectedText(app: App, selection: Selection): string {
  const text = selection.toString().replace(/\s+/g, ' ')
  if (app.sanitizer.privateMode || selection.rangeCount === 0) {
    return stringWiper(text)
  }
  let firstId: number | undefined
  let inspected = 0
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i)
    const root = range.commonAncestorContainer
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node: Node | null = root.nodeType === Node.TEXT_NODE ? root : walker.nextNode(); node; node = walker.nextNode()) {
      if (!range.intersectsNode(node) || !node.textContent?.trim()) {
        continue
      }
      const id = app.nodes.getID(node)
      if (++inspected > MAX_INSPECTED_TEXT_NODES || id === undefined || app.sanitizer.isObscured(id)) {
        return stringWiper(text)
      }
      firstId ??= id
      if (root.nodeType === Node.TEXT_NODE) {
        break
      }
    }
  }
  // Same number/email masking as regular page text.
  return firstId === undefined ? stringWiper(text) : app.sanitizer.sanitize(firstId, text)
}

function selection(app: App) {
  app.attachEventListener(document, 'selectionchange', () => {
    const selection = document.getSelection()
    if (selection !== null && !selection.isCollapsed) {
      const selectionStart = app.nodes.getID(selection.anchorNode!)
      const selectionEnd = app.nodes.getID(selection.focusNode!)
      if (selectionStart && selectionEnd) {
        app.send(SelectionChange(selectionStart, selectionEnd, selectedText(app, selection)))
      }
    } else {
      app.send(SelectionChange(-1, -1, ''))
    }
  })
}

export default selection
