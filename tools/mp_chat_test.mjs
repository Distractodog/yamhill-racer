import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { chatText } from '../game/src/mp/chatwire.js';
import { createChat, protectChatKeys, editingInput } from '../game/src/mp/chat.js';

for (const value of [null, {}, 42, '', ' \n\t ', 'a'.repeat(201)]) assert.equal(chatText(value), null);
assert.equal(chatText(' \the\u0000llo\n\u007f\u0085 '), 'hello');
assert.equal(chatText(' x '.repeat(1)), 'x');
assert.equal(chatText('a'.repeat(200)), 'a'.repeat(200));
assert.equal(chatText(' café 🏎️ <script> '), 'café 🏎️ <script>');
class Element {
  children = []; hidden = false; style = {}; listeners = new Map(); value = ''; _text = '';
  constructor(tag) { this.tagName = tag.toUpperCase(); }
  set innerHTML(_) { throw Error('Chat must never render HTML'); }
  set textContent(v) { this._text = v; this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  setAttribute() {}
  append(...children) { for (const c of children) { c.parent = this; this.children.push(c); } }
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  addEventListener(t, fn) { this.listeners.set(t, fn); }
  focus() { doc.activeElement = this; }
  blur() { if (doc.activeElement === this) { doc.activeElement = doc.body; this.listeners.get('blur')?.(); } }
  matches() { return this.tagName === 'INPUT'; }
}
const doc = { createElement: tag => new Element(tag), body: new Element('body') }; doc.activeElement = doc.body;
const listeners = [], handlers = new Map(), sent = [], keys = new Set(['KeyW', 'KeyQ']);
let time = 0, next = 0, blocked = false;
const jobs = new Map(), timers = { setTimeout(fn, ms) { const id = ++next; jobs.set(id, { fn, at: time + ms }); return id; }, clearTimeout(id) { jobs.delete(id); } };
function advance(ms) { time += ms; for (const [id, job] of [...jobs]) if (job.at <= time) { jobs.delete(id); job.fn(); } }
const mp = { inGame: false, on: (t, fn) => handlers.set(t, fn), send: msg => sent.push(msg) };
listeners.push(protectChatKeys);
// Earlier capture consumers must see gameUI and leave the chat keystroke alone.
let shortcuts = 0;
listeners.push(e => { if (!e.gameUI && /^Key[VJMT]$/.test(e.code)) shortcuts++; });
const chat = createChat({ mp, clearKeys: () => keys.clear(), canOpen: () => !blocked, doc,
  events: { addEventListener(t, fn) { if (t === 'keydown') listeners.push(fn); } }, now: () => time, timers });
function key(code, extra = {}) {
  const e = { code, key: code.slice(3), target: doc.activeElement, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra };
  for (const fn of listeners) { fn(e); if (e.stopped) break; } return e;
}
key('Enter'); assert.equal(chat.open, false, 'single player has no chat');
mp.inGame = true; handlers.get('connected')();
blocked = true; key('Enter'); assert.equal(chat.open, false, 'welcome and panels retain Enter'); blocked = false;
key('Enter'); assert.equal(chat.open, true); assert.equal(keys.size, 0); assert.equal(editingInput(doc.activeElement), true);
assert.equal(chat.input.maxLength, 200); assert.equal(chat.input.placeholder, 'Chat');
for (const code of ['KeyW', 'KeyQ', 'Space', 'KeyV', 'KeyJ', 'KeyM', 'KeyT']) assert.equal(key(code).gameUI, true);
assert.equal(shortcuts, 0);
chat.input.value = '  Hi\u0000 <script>  '; key('Enter', { isComposing: true }); assert.equal(sent.length, 0);
key('Enter'); assert.deepEqual(sent, [{ t: 'chat', text: 'Hi <script>' }]); assert.equal(chat.open, false);
assert.equal(chat.root.children[0].children.length, 0, 'wait for authoritative echo');
handlers.get('chat')({ name: '<img>', text: 'Hi <script>' });
const list = chat.root.children[0]; assert.equal(list.textContent, '<img>: Hi <script>');
key('Enter'); chat.input.value = 'too soon'; key('Enter'); assert.equal(sent.length, 1); assert.equal(chat.open, true); assert.match(chat.root.textContent, /Slow down/);
advance(1000); key('Enter'); assert.equal(sent.length, 2); assert.equal(chat.open, false);
advance(11000); assert.equal(list.children[0].style.opacity, '0', 'fade at 12 seconds');
key('Enter'); assert.equal(list.children[0].style.opacity, '1', 'open input reveals history');
for (let i = 0; i < 10; i++) handlers.get('chat')({ name: 'Ada', text: `message ${i}` });
assert.equal(list.children.length, 8); assert.equal(list.children[0].textContent, 'Ada: message 2');
advance(12000); assert.equal(list.children.at(-1).style.opacity, '1');
key('Escape'); assert.equal(chat.open, false); assert.equal(list.children.at(-1).style.opacity, '0');
key('Enter'); chat.input.value = 'cancel'; chat.input.blur(); assert.equal(chat.open, false); assert.equal(chat.input.value, '');
mp.inGame = false; handlers.get('disconnected')(); assert.equal(chat.root.hidden, true); assert.equal(list.children.length, 0); assert.equal(jobs.size, 0);

// Exercise the actual main key listener, including the focused-input guard, without loading world assets.
const main = await readFile(new URL('../game/src/main.js', import.meta.url), 'utf8');
const handler = main.slice(main.indexOf("addEventListener('keydown', e => {", main.indexOf('combat = createCombat')), main.indexOf("addEventListener('keyup'", main.indexOf('combat = createCombat')));
let onKey;
vm.runInNewContext(handler, { addEventListener: (_, fn) => onKey = fn, keys, letters: new Map(), editingInput, document: doc,
  builder: { open: false }, audio: { start() {} }, combat: { stopped: false } });
doc.activeElement = chat.input;
onKey({ code: 'KeyQ', key: 'q', target: chat.input }); assert.equal(keys.size, 0, 'typing cannot fire');
onKey({ code: 'KeyW', key: 'w', target: doc.body }); assert.equal(keys.size, 0, 'active input blocks synthetic/body keys too');
doc.activeElement = doc.body;
onKey({ code: 'KeyQ', key: 'q', target: doc.body }); assert.ok(keys.has('KeyQ'), 'fire key still reaches game outside chat');
console.log('PASS chat sanitation, rate limit, focus, authoritative text rendering, history/fade, lifecycle and main key handling');

// The early chat guard must not change welcome Enter/Escape/Space or V/J/M/T behavior.
const settingsSource = await readFile(new URL('../game/src/settings.js', import.meta.url), 'utf8');
const start = settingsSource.indexOf("addEventListener('keydown', e => {");
const welcomeHandler = settingsSource.slice(start, settingsSource.indexOf('  }, true);', start) + '  }, true);'.length);
for (const code of ['Enter', 'Escape', 'Space', 'KeyV', 'KeyJ', 'KeyM', 'KeyT']) {
  let handler, closed = 0, tuning = 0;
  const context = { addEventListener: (_, fn) => handler = fn, ready: true, external: null, welcomeOpen: true, current: null,
    document: doc, Element, welcomeHide: new Element('input'), closeWelcome: () => closed++, show: () => tuning++ };
  vm.runInNewContext(welcomeHandler, context);
  const event = { code, target: doc.body, preventDefault() {}, stopImmediatePropagation() { this.stopped = true; } };
  protectChatKeys(event); handler(event);
  assert.equal(closed, 1, `${code} still closes welcome`);
  assert.equal(tuning, code === 'KeyT' ? 1 : 0);
  assert.equal(!!event.stopped, !['KeyV', 'KeyJ', 'KeyM'].includes(code));
}
console.log('PASS welcome Enter/Escape/Space and T/V/J/M behavior preserved');
