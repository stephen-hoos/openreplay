/**
 * Sprite markup comes from the recording and is turned into a <symbol> in the app
 * document, outside the replay sandbox, so it must never be parsed as HTML there.
 */
import { describe, it, expect } from '@jest/globals';
// Load the player entry first, as the app does: MessageManager is part of an import cycle.
import '../../../player/src';
import { handleSprites } from '../../../player/src/web/MessageManager';

const MARKER = '_$OPENREPLAY_SPRITE$_';

function run(svg: string, id = 1) {
  const spriteMap = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const msg: Record<string, any> = { id, time: 0, value: `${MARKER}${svg}` };
  handleSprites({}, new DOMParser(), msg, spriteMap);
  return { msg, symbol: spriteMap.querySelector('symbol') };
}

const allElements = (root: Element) => [root, ...Array.from(root.querySelectorAll('*'))];

describe('handleSprites', () => {
  it('rebuilds a regular icon and rewrites the href', () => {
    const { msg, symbol } = run(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><g fill="red"><path d="M0 0h16"/><circle r="2"/></g></svg>',
    );
    expect(msg.value).toBe('#symbol-1');
    expect(symbol?.getAttribute('viewBox')).toBe('0 0 16 16');
    expect(symbol?.querySelector('g')?.getAttribute('fill')).toBe('red');
    expect(symbol?.querySelector('path')?.getAttribute('d')).toBe('M0 0h16');
    expect(symbol?.querySelector('circle')).not.toBeNull();
  });

  it('does not let HTML elements break out of SVG context', () => {
    const { symbol } = run(
      '<svg xmlns="http://www.w3.org/2000/svg"><img xmlns="http://www.w3.org/1999/xhtml" src="x" onerror="window.__pwned=1"/></svg>',
    );
    expect(symbol).not.toBeNull();
    const els = allElements(symbol!);
    expect(els.some((e) => e.localName === 'img')).toBe(false);
    expect(els.some((e) => e.namespaceURI !== 'http://www.w3.org/2000/svg')).toBe(false);
  });

  it('drops script-capable elements and attributes', () => {
    const { symbol } = run(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
        '<path d="M0 0" onclick="alert(1)"/>' +
        '<script>alert(1)</script>' +
        '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>' +
        '<a href="javascript:alert(1)"><text>x</text></a>' +
        '<animate attributeName="href" to="javascript:alert(1)"/>' +
        '<set attributeName="onload" to="alert(1)"/>' +
        '<image href="javascript:alert(1)" xlink:href="javascript:alert(2)" width="1"/>' +
        '<style>path{background:url(javascript:alert(1))}</style>' +
        '</svg>',
    );
    const els = allElements(symbol!);
    const tags = els.map((e) => e.localName);
    for (const tag of ['script', 'foreignObject', 'a', 'animate', 'set', 'div', 'text']) {
      expect(tags).not.toContain(tag);
    }
    for (const el of els) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.name.toLowerCase().startsWith('on')).toBe(false);
        expect(attr.value.toLowerCase()).not.toContain('javascript:');
      }
    }
    expect(symbol!.querySelector('path')?.getAttribute('d')).toBe('M0 0');
    expect(symbol!.querySelector('image')?.getAttribute('width')).toBe('1');
    expect(symbol!.querySelector('style')?.textContent).not.toContain('javascript:');
  });
});
