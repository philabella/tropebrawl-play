// fastsim engine: run a Tropebrawl build (the single HTML file, unchanged) in Node's vm module, no browser.
//
// The game's <script> runs as a classic top-level script in its own vm context whose global object plays
// `window` (window === globalThis), like a page: top-level function declarations become window properties
// (so `window.rankUp = wrapper` works, as the smartbot and the aiplayer view rely on), top-level const/let
// live in the shared global lexical scope, and scripts loaded later into the same context (bots.js,
// smartbot core.js, the aiplayer view) see them by name, exactly as page.addScriptTag does.
//
// The context is created with vm.constants.DONT_CONTEXTIFY (Node >= 22.8): an ordinary global object with no
// interceptors, which makes global lookups as fast as in a page (about 4x faster than a contextified sandbox).
//
// The DOM is an inert fake. Every element accepts any write and returns harmless defaults, so render(),
// toast(), sheet() and showResult() run their real code (including any RNG they consume) without layout.
// The page's static elements (#app, #sheet, #scrim, #toast) keep what the game writes, so a harness can read
// the rendered HTML; '#id' lookups of rendered sub-elements (#insp ...) return read-only snapshots, and
// '[data-a]' lists the rendered buttons, whose click() goes to the game's onAction like a real click.
// Timers and animation frames never fire; the caller fast-forwards fights (silent battles / skip).
//
// Two engine differences between Node 22 (V8 12.4) and Chromium 141 (V8 14.1) are corrected so that seeded runs
// replay byte-identically to Chromium (parity.js): Array.prototype.sort's comparator call order on arrays of up to
// 7 elements (matters for random comparators), and Math.pow (Chromium uses libm; see native/libmpow.c).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const LEAN = path.resolve(__dirname, '../lean');
const DEFAULT_BUILD = path.resolve(__dirname, '../tropebrawl.html');
const DEFAULT_BOTS = path.resolve(__dirname, '../sim/bots.js');

// mulberry32, the same generator the game's seeded rand() uses; shared with the Chromium parity check
const MATH_RANDOM_SRC = `(function(){ let ms = 0x9E3779B9 | 0;
  Math.random = function(){ ms = ms + 0x6D2B79F5 | 0; let t = Math.imul(ms ^ ms >>> 15, 1 | ms); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  globalThis.__seedMath = function(n){ ms = n | 0; }; globalThis.__mathState = function(){ return ms; }; })();`;

// Array.prototype.sort as Chromium 141 (V8 14.1) calls the comparator. V8 there sorts arrays of up to 7 elements
// with a plain binary insertion sort, while Node 22 (V8 12.4) runs TimSort's run detection first, so a comparator
// is called a different number of times. For a consistent comparator the result is identical either way (both
// sorts are stable); for a random one (bots.js "random" policy: sort(()=>Math.random()-.5)) the call count
// decides the Math.random stream. Measured, not assumed: parity.js checked n=2..100 against Chromium.
const CHROME_SORT_SRC = `(function(){ const nat = Array.prototype.sort;
  Object.defineProperty(Array.prototype, 'sort', { configurable: true, writable: true, enumerable: false, value: function sort(cmp) {
    const a = this, n = a.length;
    if (typeof cmp !== 'function' || !Array.isArray(a) || n > 7 || n < 2) return nat.call(a, cmp);
    for (let i = 0; i < n; i++) if (!(i in a) || a[i] === undefined) return nat.call(a, cmp);
    for (let i = 1; i < n; i++) { const p = a[i]; let l = 0, r = i;
      while (l < r) { const m = l + ((r - l) >> 1); if (cmp(p, a[m]) < 0) r = m; else l = m + 1; }
      for (let j = i; j > l; j--) a[j] = a[j - 1]; a[l] = p; }
    return a; } }); })();`;

// Derive a 32-bit seed from anything (FNV-1a over the string forms). Same code host-side and in-context.
const HSEED_SRC = `function __hseed(){ let h = 0x811c9dc5; for (let a = 0; a < arguments.length; a++) { const s = String(arguments[a]); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } h ^= 0x7f; h = Math.imul(h, 0x01000193); } return h | 0; }`;
const hseed = new Function(HSEED_SRC + '; return __hseed;')();

// Everything a page offers that the game touches at load time or in UI code. Runs inside the context.
const STUBS = String.raw`
var window = globalThis, self = globalThis;
(function(){
  'use strict';
  const noop = function(){};
  const ROOT_IDS = (globalThis.__FS_ROOTS || []);
  function text(html){ return String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi,'').replace(/<br\s*\/?>/gi,'\n')
    .replace(/<\/(div|p|h\d|li|button|tr|section|aside|header|footer|ul|ol|table)>/gi,'\n').replace(/<(div|p|h\d|li|tr|section|aside|ul|ol|table)\b[^>]*>/gi,'\n')
    .replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&')
    .replace(/[ \t]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{2,}/g,'\n').trim(); }
  const classList = { add: noop, remove: noop, toggle(){ return false; }, contains(){ return false; }, replace: noop };
  const attr = (tag, name) => { const m = new RegExp('\\s' + name + '(?:\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+)))?(?=[\\s/>])', 'i').exec(tag); return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null; };
  const unesc = s => s == null ? s : String(s).replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&');
  class El {
    constructor(tag, id){ this.tagName = String(tag||'div').toUpperCase(); this.id = id||''; this.style = {}; this.dataset = {}; this.classList = classList;
      this.hidden = false; this._html = ''; this.textContent = ''; this.parentNode = null; this.value = ''; this.disabled = false; this.title = ''; this.className = ''; this._attrs = {}; }
    get innerHTML(){ return this._html; } set innerHTML(v){ this._html = String(v); }
    get outerHTML(){ return this._html; } set outerHTML(v){ this._html = String(v); }
    get innerText(){ return text(this._html || this.textContent); }
    get offsetWidth(){ return 0; } get offsetHeight(){ return 0; } get children(){ return []; } get firstChild(){ return null; }
    querySelector(){ return new El('div'); } querySelectorAll(){ return []; } closest(){ return null; } matches(){ return false; }
    appendChild(c){ if (c) c.parentNode = this; return c; } append(){} prepend(){} insertBefore(c){ return c; } removeChild(c){ return c; }
    insertAdjacentHTML(pos, h){ this._html += String(h); } remove(){} focus(){} blur(){} scrollIntoView(){} scrollTo(){}
    click(){ if (this.disabled || this.dataset.a == null || typeof globalThis.onAction !== 'function') return; globalThis.onAction(this.dataset.a, this.dataset.v, this); }
    setAttribute(k, v){ this._attrs[k] = String(v); } getAttribute(k){ return k in this._attrs ? this._attrs[k] : null; } removeAttribute(k){ delete this._attrs[k]; } hasAttribute(k){ return k in this._attrs; }
    addEventListener(){} removeEventListener(){} dispatchEvent(){ return true; }
    animate(){ return { onfinish: null, cancel: noop, finish: noop, play: noop, pause: noop }; }
    getBoundingClientRect(){ return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }; }
  }
  // the page's static elements (parsed from the build's markup): they keep what the game writes
  const byId = {};
  ROOT_IDS.forEach(r => { const e = new El(r.tag, r.id); e.hidden = !!r.hidden; byId[r.id] = e; });
  const visibleRoots = () => Object.values(byId).filter(e => !e.hidden && e._html);
  // a rendered element by id: a read-only snapshot of its inner HTML (balanced on its own tag name)
  function findRendered(id){
    for (const root of visibleRoots()) {
      const h = root._html; const m = new RegExp('<(\\w+)\\b[^>]*\\sid="' + id + '"[^>]*>', 'i').exec(h); if (!m) continue;
      const tag = m[1].toLowerCase(); const re = new RegExp('<(/?)' + tag + '\\b[^>]*>', 'gi'); re.lastIndex = m.index + m[0].length;
      let depth = 1, mm, end = h.length; while ((mm = re.exec(h))) { depth += mm[1] ? -1 : 1; if (!depth) { end = mm.index; break; } }
      const e = new El(tag, id); e._html = h.slice(m.index + m[0].length, end); return e;
    }
    return null;
  }
  // rendered elements with a data-a attribute (the game's buttons), in document order
  function dataA(){
    const out = [];
    for (const root of visibleRoots()) {
      const h = root._html; const re = /<(\w+)\b([^>]*\sdata-a=("[^"]*"|'[^']*')[^>]*)>/gi; let m;
      while ((m = re.exec(h))) {
        const tag = m[1].toLowerCase(), t = m[0]; const e = new El(tag);
        e.dataset.a = unesc(attr(t, 'data-a')); const v = attr(t, 'data-v'); if (v != null) e.dataset.v = unesc(v);
        const l = attr(t, 'data-l'); if (l != null) e.dataset.l = unesc(l); const s = attr(t, 'data-s'); if (s != null) e.dataset.s = unesc(s);
        e.disabled = attr(t, 'disabled') != null; const al = attr(t, 'aria-label'); if (al != null) e._attrs['aria-label'] = unesc(al);
        const close = h.indexOf('</' + tag + '>', m.index + t.length); e._html = close < 0 ? '' : h.slice(m.index + t.length, close);
        out.push(e);
      }
    }
    return out;
  }
  const document = {
    querySelector(sel){
      sel = String(sel).trim(); let m;
      if ((m = /^#([\w-]+)(:not\(\[hidden\]\))?$/.exec(sel))) { const r = byId[m[1]]; if (r) return m[2] && r.hidden ? null : r; return findRendered(m[1]); }
      if (sel === '[data-a]') return dataA()[0] || null;
      return null;
    },
    querySelectorAll(sel){ return String(sel).trim() === '[data-a]' ? dataA() : []; },
    getElementById(id){ return byId[id] || findRendered(id); },
    createElement(t){ return new El(t); }, createTextNode(t){ const e = new El('#text'); e.textContent = t; return e; },
    addEventListener: noop, removeEventListener: noop, body: new El('body'), documentElement: new El('html'), head: new El('head'), activeElement: null,
  };
  const store = {};
  const localStorage = { getItem(k){ return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; }, setItem(k, v){ store[k] = String(v); }, removeItem(k){ delete store[k]; }, clear(){ for (const k in store) delete store[k]; }, key(i){ return Object.keys(store)[i] || null; }, get length(){ return Object.keys(store).length; } };
  // media queries: min/max-width against innerWidth (1280, a desktop window like the aiplayer's), everything else false
  function matchMedia(q){
    let ok = /width/.test(q);
    q.replace(/\((min|max)-width\s*:\s*(\d+)px\)/g, (_, k, n) => { ok = ok && (k === 'min' ? globalThis.innerWidth >= +n : globalThis.innerWidth <= +n); });
    return { matches: ok, media: q, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop };
  }
  // structuredClone for plain game state (objects, arrays, primitives, Date, Map, Set), keeping shared references
  function structuredClone(v){
    const seen = new Map();
    const c = x => {
      if (x === null || typeof x !== 'object') { if (typeof x === 'function' || typeof x === 'symbol') throw new Error('DataCloneError: could not be cloned'); return x; }
      if (seen.has(x)) return seen.get(x);
      let o;
      if (Array.isArray(x)) { o = new Array(x.length); seen.set(x, o); for (let i = 0; i < x.length; i++) if (i in x) o[i] = c(x[i]); return o; }
      if (x instanceof Date) { o = new Date(x.getTime()); seen.set(x, o); return o; }
      if (x instanceof Map) { o = new Map(); seen.set(x, o); x.forEach((v2, k) => o.set(c(k), c(v2))); return o; }
      if (x instanceof Set) { o = new Set(); seen.set(x, o); x.forEach(v2 => o.add(c(v2))); return o; }
      o = {}; seen.set(x, o); for (const k of Object.keys(x)) o[k] = c(x[k]); return o;
    };
    return c(v);
  }
  let tid = 0, clock = 0;
  Object.assign(globalThis, {
    document, localStorage, sessionStorage: localStorage, matchMedia, structuredClone,
    requestAnimationFrame(){ return ++tid; }, cancelAnimationFrame: noop,
    setTimeout(){ return ++tid; }, clearTimeout: noop, setInterval(){ return ++tid; }, clearInterval: noop, queueMicrotask(f){ Promise.resolve().then(f); },
    performance: { now(){ return clock += 16; } },
    navigator: { userAgent: 'fastsim', language: 'en-US' }, innerWidth: 1280, innerHeight: 900, devicePixelRatio: 1,
    scrollTo: noop, getComputedStyle(){ return {}; }, addEventListener: noop, removeEventListener: noop,
    __fs: { El, text, byId, store, findRendered, dataA },
  });
})();
` + MATH_RANDOM_SRC + '\n' + HSEED_SRC + '\nglobalThis.__hseed = __hseed;\n';

// Pull the game's inline script(s) and static element ids out of the build (a body fragment or a full page).
function parseBuild(html) {
  const scripts = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) { if (/\bsrc\s*=/.test(m[1])) continue; const ty = /type\s*=\s*["']?([^"'\s>]+)/i.exec(m[1]); if (ty && !/javascript|ecmascript/i.test(ty[1])) continue; scripts.push(m[2]); }
  if (!scripts.length) throw new Error('no inline <script> found in the build');
  const markup = html.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '');
  const roots = []; const re2 = /<(\w+)\b([^>]*\sid\s*=\s*["']([\w-]+)["'][^>]*)>/gi;
  while ((m = re2.exec(markup))) roots.push({ tag: m[1], id: m[3], hidden: /\shidden(\s|=|$)/i.test(m[2] + ' ') });
  return { scripts, roots };
}

const cache = new Map(); // build path -> parsed build
// hand a build parsed in another thread to this one (worker threads: the main thread reads, hashes and parses the
// 8 MB file once and passes the result in workerData, instead of every worker doing it again)
function primeBuild(b) { if (b && b.path && b.scripts && !cache.has(b.path)) cache.set(b.path, b); return b; }
function readBuild(buildPath) {
  const p = path.resolve(buildPath || DEFAULT_BUILD);
  if (cache.has(p)) return cache.get(p);
  const html = fs.readFileSync(p, 'utf8');
  const b = Object.assign({ path: p, hash: crypto.createHash('sha1').update(html).digest('hex').slice(0, 10) }, parseBuild(html));
  cache.set(p, b); return b;
}

const HAS_FAST_CONTEXT = !!(vm.constants && vm.constants.DONT_CONTEXTIFY);

// V8 code cache for the build's big scripts (vm.Script cachedData): each new thread or process otherwise parses and
// compiles ~8 MB of game code again (~90 ms) plus every function the load touches. The cache is keyed by the build's
// hash, the script index and the Node version, lives in fastsim/.cache (gitignored), and V8 itself rejects a stale or
// mismatched cache (then the script compiles normally and the cache is rewritten). It holds bytecode only, so the
// game runs the same code either way. FASTSIM_CODE_CACHE=0 turns it off; FASTSIM_CACHE_DIR moves it.
const CODE_CACHE = process.env.FASTSIM_CODE_CACHE !== '0';
const CACHE_DIR = process.env.FASTSIM_CACHE_DIR || path.join(__dirname, '.cache');
function runCached(src, ctx, filename, key) {
  if (!CODE_CACHE || src.length < 100000) return vm.runInContext(src, ctx, { filename });
  const file = path.join(CACHE_DIR, `code-${key}-node${process.versions.node}-v8${process.versions.v8}.bin`);
  let data = null; try { data = fs.readFileSync(file); } catch (e) { /* first run */ }
  const script = new vm.Script(src, data ? { filename, cachedData: data } : { filename });
  const r = script.runInContext(ctx);
  if (!data || script.cachedDataRejected) {
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp';
      fs.writeFileSync(tmp, script.createCachedData()); fs.renameSync(tmp, file); } catch (e) { /* read-only checkout: run without a cache */ }
  }
  return r;
}

// Math.pow as Chromium computes it. Chromium 141 (V8 14.1) calls the system libm pow (glibc here: 40,027 of
// 40,027 test cases identical; parity.js re-checks 20,084), while Node 22 (V8 12.4) uses fdlibm's pow, which is 1 ulp off in about 9% of
// cases (0.9**4 = 0.6561000000000001). The game's enemy scaling uses Math.pow, so without this the fights and
// results are still the same but float stats drift in the 16th digit. native/libmpow.node is a 20-line N-API
// addon (native/build.sh); if it is missing, the engine falls back to Node's pow and says so in engine.pow.
let LIBM_POW = null, POW_NOTE = 'libm (as Chromium)';
try { LIBM_POW = require('./native/libmpow.node').pow; if (LIBM_POW(0.9, 4) !== 0.6561) throw new Error('unexpected libm pow result'); }
catch (e) { LIBM_POW = null; POW_NOTE = 'Node fdlibm (native/libmpow.node not built: run native/build.sh for exact Chromium float parity)'; }
const POW_STUB = `(function(){ const lp = globalThis.__libmPow; if (typeof lp !== 'function') return;
  Object.defineProperty(Math, 'pow', { configurable: true, writable: true, enumerable: false, value: function pow(x, y) {
    x = +x; y = +y; if (y !== y) return NaN; if ((x === 1 || x === -1) && (y === Infinity || y === -Infinity)) return NaN; return lp(x, y); } }); })();`;

class Engine {
  // opts: {build, scripts:[files loaded after the game, like page.addScriptTag], tune:{...}|json, console,
  //        contextify:false (true = classic contextified sandbox, 4x slower), nativeSort:false (true = Node's own sort order),
  //        nativePow:false (true = Node's own Math.pow)}
  constructor(opts = {}) {
    const b = readBuild(opts.build);
    this.build = b.path; this.hash = b.hash;
    if (HAS_FAST_CONTEXT && !opts.contextify) { this.ctx = vm.createContext(vm.constants.DONT_CONTEXTIFY); this.ctx.console = opts.console || console; }
    else this.ctx = vm.createContext({ console: opts.console || console });
    this.ctx.__FS_ROOTS = b.roots;
    this.pow = LIBM_POW && !opts.nativePow ? POW_NOTE : LIBM_POW ? 'Node fdlibm (nativePow requested)' : POW_NOTE;
    if (LIBM_POW && !opts.nativePow) this.ctx.__libmPow = LIBM_POW;
    vm.runInContext(STUBS, this.ctx, { filename: 'fastsim-stubs.js' });
    if (opts.nativeSort !== true) vm.runInContext(CHROME_SORT_SRC, this.ctx, { filename: 'fastsim-chrome-sort.js' });
    vm.runInContext(POW_STUB, this.ctx, { filename: 'fastsim-libm-pow.js' });
    b.scripts.forEach((src, i) => runCached(src, this.ctx, path.basename(b.path) + (i ? '#script' + i : ''), b.hash + '-' + i));
    (opts.scripts || []).forEach(s => this.load(s));
    if (opts.tune) this.tune(opts.tune);
  }
  // like page.addScriptTag({path}): a classic script in the page's global scope
  load(file) { vm.runInContext(fs.readFileSync(file, 'utf8'), this.ctx, { filename: path.basename(file) }); return this; }
  // evaluate code in the page's global scope (what (0,eval) does in a page)
  ev(code) { return vm.runInContext(code, this.ctx); }
  get(name) { try { return this.ev(name); } catch (e) { return undefined; } }
  // page.evaluate equivalent: fn's source runs in the context with a JSON-copied argument
  evaluate(fn, arg) {
    const src = typeof fn === 'function' ? fn.toString() : String(fn);
    return this.ev(`(${src})(${arg === undefined ? '' : JSON.stringify(arg)})`);
  }
  tune(obj) { const T = this.ev('TUNE'); Object.assign(T, typeof obj === 'string' ? JSON.parse(obj) : obj); return this; }
  // seed the game's own rand() (its seeded mode) and Math.random from one run seed
  seed(s) { s = s | 0; this.ctx.__seedMath(hseed('math', s)); this.ev(`seeded=true;rngState=${s}`); return this; }
  unseed() { this.ev('seeded=false'); return this; }
  rng() { return { seeded: this.ev('seeded'), state: this.ev('rngState'), math: this.ctx.__mathState() }; }
  setRng(r) { if (!r) return this; this.ev(`seeded=${!!r.seeded};rngState=${r.state | 0}`); if (r.math != null) this.ctx.__seedMath(r.math); return this; }
  html(id) { const e = this.ctx.__fs.byId[id]; return e ? e._html : ''; }
  text(html) { return this.ctx.__fs.text(html); }
}

module.exports = { Engine, readBuild, primeBuild, parseBuild, hseed, MATH_RANDOM_SRC, CHROME_SORT_SRC, DEFAULT_BUILD, DEFAULT_BOTS, LEAN, HAS_FAST_CONTEXT };
