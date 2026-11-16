// Fast disclosure/input checks without a renderer, browser, or world assets.
import assert from 'node:assert/strict';
import { createGameMenu } from '../game/src/gamemenu.js';

class Element {
  listeners = new Map(); attributes = new Map(); hidden = false; disabled = false; children = [];
  constructor(id) { this.id = id; }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  emit(type, event = {}) { this.listeners.get(type)?.(event); }
  setAttribute(key, value) { this.attributes.set(key, value); }
  focus() { document.activeElement = this; }
  contains(el) { return el === this || this.children.some(child => child.contains(el)); }
  closest() { return this.disabled ? null : this; }
  querySelectorAll() { return this.children.filter(el => !el.disabled); }
  querySelector() { return this.querySelectorAll()[0]; }
  getClientRects() { return [1]; }
}
const bar = new Element('menu-bar'), button = new Element('menu-button'), panel = new Element('menu-panel');
const mp = new Element('mp-button'), garage = new Element('garage-button'), link = new Element('suggest-button');
const outside = new Element('world');
bar.children = [button, panel]; panel.children = [mp, garage, link]; panel.hidden = true; button.disabled = true; mp.disabled = true;
const nodes = new Map([bar, button, panel].map(el => [el.id, el]));
const documentListeners = new Map(), windowListeners = new Map();
globalThis.document = {
  activeElement: null, getElementById: id => nodes.get(id),
  addEventListener: (type, fn) => documentListeners.set(type, fn),
};
globalThis.addEventListener = (type, fn) => windowListeners.set(type, fn);
let opens = 0, changes = 0;
const menu = createGameMenu({ onOpen: () => opens++, onChange: () => changes++ });
const key = (code, shiftKey = false) => {
  const event = { code, shiftKey, target: document.activeElement, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
  windowListeners.get('keydown')(event); return event;
};
menu.ready(); assert.equal(button.disabled, false);
button.emit('click'); assert.equal(menu.open, true); assert.equal(opens, 1);
assert.equal(button.attributes.get('aria-expanded'), 'true'); assert.equal(document.activeElement, garage);
assert.equal(key('KeyW').gameUI, true); assert.equal(menu.open, true);
link.focus(); assert.equal(key('Tab').prevented, true); assert.equal(document.activeElement, button);
assert.equal(key('Tab', true).prevented, true); assert.equal(document.activeElement, link);
const escape = key('Escape'); assert.equal(escape.stopped, true); assert.equal(menu.open, false);
assert.equal(button.attributes.get('aria-expanded'), 'false'); assert.equal(document.activeElement, button);
assert.equal(key('Space').gameUI, true); // native button activation never brakes the car
assert.equal(key('KeyM').gameUI, undefined); // map shortcut remains available when closed
for (const code of ['KeyV', 'KeyJ', 'KeyM', 'KeyT', 'KeyP', 'KeyR', 'KeyF', 'KeyH', 'KeyC', 'KeyG', 'KeyL', 'KeyU', 'F8', 'Backspace']) {
  button.emit('click');
  const event = key(code);
  assert.equal(menu.open, false, `${code} closes the menu`);
  assert.equal(event.gameUI, undefined, `${code} reaches the game`);
  assert.equal(event.prevented, undefined); assert.equal(event.stopped, undefined);
}
button.emit('click'); documentListeners.get('pointerdown')({ target: garage }); assert.equal(menu.open, true);
documentListeners.get('pointerdown')({ target: outside }); assert.equal(menu.open, false);
button.emit('click'); documentListeners.get('focusin')({ target: outside }); assert.equal(menu.open, false);
button.emit('click'); panel.emit('click', { target: link }); assert.equal(menu.open, false);
assert.equal(document.activeElement, button); // subsequent item handlers can focus their own dialog
button.emit('click'); button.emit('click'); assert.equal(menu.open, false);
assert.equal(changes, opens * 2);
console.log('PASS: disclosure state/ARIA, disabled items, focus return, Tab wrap, input isolation, game shortcut passthrough, outside pointer/focus, item activation, toggle');
