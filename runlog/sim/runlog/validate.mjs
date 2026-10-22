// Anti-poisoning filter for collected runs: the relay topic is public, so anyone can post a "run". Before runs train
// the AI rivals or feed a balance read, every run is checked here and sorted into
//   verified   - every fight was re-played in fastsim from the recorded state and seed and gave the recorded result
//                (format 2 runs, from the launch-prep build on, when the build of that version is available)
//   plausible  - passed every plausibility check, but could not be re-played (older format, or no build of its version)
//   rejected   - impossible or tampered (the reasons are listed); --move puts these files in rejected/
// Everything read is untrusted input: nothing is executed, only parsed and compared.
//
//   node runlog/validate.mjs runs/ [more dirs or files] [--build a.html ...] [--git] [--out report.json] [--move]
//   node runlog/validate.mjs --selftest [--n 300] [--build tropebrawl.html]
//
// --build  a build to re-play with (its TB_VERSION decides which runs use it; repeatable). Demo runs re-play on the
//          full build of the same version (the demo changes levels, menus and saves, never a fight).
// --git    also look up the build of every version seen in the git history of tropebrawl.html (cached in
//          fastsim/out/builds/), so old runs re-play with the exact build that recorded them.
// --selftest  plays --n runs in fastsim exactly as a browser records them (live mode, recorder on), checks that all of
//          them are verified, then forges poisoned copies (inflated gold, a forged winning board, a flipped result,
//          a buy that was never offered, unknown ids, too many items, a demo run above the demo's levels, a duplicate)
//          and checks that every one is rejected. Exit 1 on any miss.
import fs from 'fs'; import path from 'path'; import crypto from 'crypto'; import { createRequire } from 'module';
import { execFileSync } from 'child_process'; import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '..');
const { Replayer } = require(path.join(REPO, 'fastsim', 'runreplay.js'));

// ---- limits (generous: measured on 900 live-mode bot runs, Levels 1-18, then widened; a real run never comes close)
const LIM = {
  gold: 400,            // gold held at any point (bots peaked at 194)
  income: 75,           // gold gained between one fight and the next round's start (income, interest, wins, events; peak 36)
  inRound: 40,          // gold gained inside a round besides selling (events, rewards; peak 15)
  // character copies that appear between two fights beyond the logged buys and sells and 3 copies for every logged
  // event, choice or pick (Promotion: a star; Casting Call: a 2-star): 0 in all 900 bot runs. A forged 1->3 star is 5.
  surplusFight: 2, surplusRun: 4,
  actions: 600, rounds: 60, demoMax: 10,
};
const CODES = /^(o|b|r|t|s|e|c|l|i|v|q|n|x|p|d|h)(:[^\n]{0,400})?$/;

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2), A = { _: [], build: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--build') A.build.push(argv[++i]);
  else if (a === '--out' || a === '--n') A[a.slice(2)] = argv[++i];
  else if (a.startsWith('--')) A[a.slice(2)] = true;
  else A._.push(a);
}

// ---------------------------------------------------------------- builds and replayers
const verOf = f => { const m = /const TB_VERSION='([^']+)'/.exec(fs.readFileSync(f, 'utf8')); return m ? m[1] : null; };
const BUILDS = new Map();   // version -> path
for (const b of A.build) { const v = verOf(b); if (v) BUILDS.set(v, path.resolve(b)); else console.error('no TB_VERSION in', b); }
// where --git looks: this checkout's tropebrawl.html, or (useGit, TRO-401 pool build) the play repo's index.html
const GIT = { on: !!A.git, repo: REPO, file: 'tropebrawl.html', cache: path.join(REPO, 'fastsim', 'out', 'builds') };
// scan: read the version of every commit of the file once (index in <cache>/commits.json) instead of one `git log -S`
// per version (the play repo: ~one commit per version, so a scan is cheaper than a pickaxe over 8 MB blobs)
export function useGit(repo, file, cache, scan) { Object.assign(GIT, { on: true, repo: path.resolve(repo), file, cache: path.resolve(cache), scan: !!scan }); }
export function addBuild(b) { const v = verOf(b); if (v) BUILDS.set(v, path.resolve(b)); return v; }
let SCAN = null;
function scanned() {
  if (SCAN) return SCAN;
  const idx = path.join(GIT.cache, 'commits.json'), known = fs.existsSync(idx) ? JSON.parse(fs.readFileSync(idx, 'utf8')) : {};
  SCAN = new Map();   // version -> newest commit with it
  try {
    const cs = execFileSync('git', ['-C', GIT.repo, 'log', '--format=%H', '--', GIT.file], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    for (const c of cs) {
      if (!(c in known)) { try { const m = /const TB_VERSION='([^']+)'/.exec(execFileSync('git', ['-C', GIT.repo, 'show', `${c}:${GIT.file}`], { encoding: 'utf8', maxBuffer: 64e6 })); known[c] = m ? m[1] : null; } catch (e) { known[c] = null; } }
      if (known[c] && !SCAN.has(known[c])) SCAN.set(known[c], c);
    }
    fs.mkdirSync(GIT.cache, { recursive: true }); fs.writeFileSync(idx, JSON.stringify(known));
  } catch (e) {}
  return SCAN;
}
function gitBuild(v) {
  if (!/^\d+\.\d+$/.test(v)) return null;
  const dir = GIT.cache, f = path.join(dir, v + '.html');
  if (fs.existsSync(f)) return f;
  if (GIT.scan) {
    const c = scanned().get(v); if (!c) return null;
    try { const src = execFileSync('git', ['-C', GIT.repo, 'show', `${c}:${GIT.file}`], { encoding: 'utf8', maxBuffer: 64e6 }); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f, src); return f; } catch (e) { return null; }
  }
  try {
    const h = execFileSync('git', ['-C', GIT.repo, 'log', '--format=%H', '-S', `const TB_VERSION='${v}'`, '--', GIT.file], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    for (const c of h) {   // the commit that introduced the version (oldest last); take the newest one that still has it
      const src = execFileSync('git', ['-C', GIT.repo, 'show', `${c}:${GIT.file}`], { encoding: 'utf8', maxBuffer: 64e6 });
      if (src.includes(`const TB_VERSION='${v}'`)) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f, src); return f; }
    }
  } catch (e) {}
  return null;
}
const RP = new Map();
export function replayer(v) {
  if (RP.has(v)) return RP.get(v);
  let b = BUILDS.get(v) || (GIT.on ? gitBuild(v) : null), rp = null;
  if (b) { try { rp = new Replayer(b); if (rp.version !== v) rp = null; } catch (e) { console.error('build', b, e.message); rp = null; } }
  RP.set(v, rp); return rp;
}
export function dropReplayers() { RP.clear(); }   // one engine per version: free them between version groups

// ---------------------------------------------------------------- the checks
const isInt = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;
export function check(rec, rp) {
  const why = [], bad = m => { if (why.length < 12) why.push(m); };
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return { status: 'rejected', why: ['not a record'] };
  if (!/^[a-z0-9]{4,24}$/.test(rec.rid || '')) bad('bad run id');
  if (typeof rec.v !== 'string' || !/^[0-9a-z.]{1,16}$/.test(rec.v)) bad('bad version');
  if (!isInt(rec.lv, 0, 30)) bad('bad level');
  if (!Array.isArray(rec.r) || !rec.r.length || rec.r.length > LIM.rounds) return { status: 'rejected', why: why.concat('no rounds or too many') };
  if (rec.res != null && !['win', 'lose', 'loss', 'quit', 'open'].includes(rec.res)) bad('bad result');
  if (rec.build != null && !['full', 'demo'].includes(rec.build)) bad('unknown build tag');
  if (rec.build === 'demo' && rec.lv > LIM.demoMax) bad(`demo run at Level ${rec.lv} (the demo stops at ${LIM.demoMax})`);
  const F = rp ? rp.facts : null, HERO = F ? new Set(F.heroes) : null, ITEM = F ? new Set(F.items) : null, LEG = F ? new Set(F.legends) : null;
  const C = F ? F.copies : [1, 3, 6], maxLvl = C.length;
  if (F) {
    if (rec.lv < F.lvMin || rec.lv > F.lvMax) bad('level outside the ladder');
    if (rec.v !== F.version) bad('version mismatch');
  }
  const sched = F && F.rounds[rec.lv] ? F.rounds[rec.lv].sched : 40;
  const unit = (s, where) => {   // "id:level[:slot]"
    const [id, l] = String(s).split(':');
    if (HERO && !HERO.has(id)) bad(`unknown character ${String(id).slice(0, 20)} (${where})`);
    if (!isInt(+l, 1, maxLvl)) bad(`bad character level (${where})`);
    return { id, l: +l };
  };
  let prevKey = -1, offer = null, cp = null, lastF = null, surplusRun = 0, evs = 0;
  for (const [k, r] of rec.r.entries()) {
    const at = `round ${r && r.n}`;
    if (!r || typeof r !== 'object') { bad('bad round'); continue; }
    if (!isInt(r.n, 1, Math.min(LIM.rounds, sched + 3)) || !isInt(r.p || 0, 0, 3)) { bad(`${at}: round number out of range`); continue; }
    const key = r.n * 4 + (r.p || 0); if (key < prevKey) bad(`${at}: rounds out of order`); prevKey = key;
    if (!isInt(r.g, 0, LIM.gold)) bad(`${at}: gold ${r.g} out of bounds`);
    if (!isInt(r.lf, -5, 40)) bad(`${at}: lives out of bounds`);
    if (!isInt(r.rk, 1, F ? F.rankMax : 12)) bad(`${at}: rank out of bounds`);
    if (!Array.isArray(r.a) || r.a.length > LIM.actions) { bad(`${at}: bad action list`); continue; }
    if (lastF && Number.isInteger(r.g) && r.g - lastF.g > LIM.income) bad(`${at}: +${r.g - lastF.g} gold since the last fight (max ${LIM.income})`);
    const got = {}; let sellGold = 0;
    for (const a of r.a) {
      if (typeof a !== 'string' || !CODES.test(a)) { bad(`${at}: unknown action`); break; }
      const c = a[0], v = a.slice(2);
      if (c === 'e' || c === 'c' || c === 'l' || c === 'i') evs++;
      if (c === 'o') { offer = v.split(',').map(x => x === '-' ? '-' : x); offer.forEach(x => { if (x !== '-') unit(x.replace('*', ':') + (x.includes('*') ? '' : ':1'), at + ' offer'); }); }
      else if (c === 'b') {
        // offers are logged since v19.1x; older runs have none, so there is nothing to compare with
        const u = unit(v, at + ' buy'), tag = u.id + (u.l > 1 ? '*' + u.l : ''), i = offer ? offer.indexOf(tag) : 0;
        if (i < 0) bad(`${at}: bought ${tag} that the shop never offered`); else if (offer) offer[i] = '-';
        got[u.id] = (got[u.id] || 0) + (C[u.l - 1] || 1);
      } else if (c === 's') {
        const u = unit(v, at + ' sell'); got[u.id] = (got[u.id] || 0) - (C[u.l - 1] || 1);
        sellGold += F && F.price[u.id] ? Math.ceil(F.price[u.id] * (C[u.l - 1] || 1) / 2) + 2 : 30;
      }
    }
    const f = r.f; if (!f) continue;
    if (typeof f !== 'object' || !Array.isArray(f.b) || f.b.length > 12) { bad(`${at}: bad fight record`); continue; }
    if (!isInt(f.g, 0, LIM.gold)) bad(`${at}: fight gold out of bounds`);
    if (Number.isInteger(r.g) && Number.isInteger(f.g) && f.g - r.g > LIM.inRound + sellGold) bad(`${at}: gold rose ${f.g - r.g} inside the round`);
    f.b.forEach(x => unit(x, at + ' board')); (Array.isArray(f.n) ? f.n : []).forEach(x => unit(x, at + ' bench'));
    const it = Array.isArray(f.it) ? f.it : [];
    if (F && it.length > F.itemCap) bad(`${at}: ${it.length} items (max ${F.itemCap})`);
    it.forEach(x => { const [id, l] = String(x).split(':'); if (ITEM && !ITEM.has(id)) bad(`${at}: unknown item`); if (!isInt(+l, 1, F ? F.itemMax : 5)) bad(`${at}: bad item level`); });
    if (f.lg != null && LEG && !LEG.has(f.lg)) bad(`${at}: unknown Legendary`);
    // the replay state must say what the summary says
    const st = f.st;
    if (st) {
      if (typeof st !== 'object' || !Array.isArray(st.units) || st.units.length > 20 || !Array.isArray(st.trinkets)) { bad(`${at}: bad fight state`); continue; }
      const field = st.units.filter(u => u && typeof u.slot === 'string' && u.slot[0] !== 'n' && u.slot !== 'gone').map(u => u.id + ':' + u.level + ':' + u.slot).sort().join(' ');
      if (field !== f.b.slice().sort().join(' ')) bad(`${at}: board differs from its fight state`);
      if (st.gold !== f.g || st.rank !== f.rk || st.round !== r.n || st.lv !== rec.lv) bad(`${at}: fight state disagrees (gold, rank, round or level)`);
      if (st.trinkets.map(t => t + ':' + ((st.tlv || {})[t] || 1)).join() !== it.join()) bad(`${at}: items differ from the fight state`);
      if ((st.legend || null) !== (f.lg || null)) bad(`${at}: Legendary differs from the fight state`);
      if (Number.isInteger(st.maxLives) && r.lf > st.maxLives) bad(`${at}: more lives than the maximum`);
      st.units.forEach(u => unit(u.id + ':' + u.level, at + ' state'));
      // characters that appear without a logged buy (gifts and events exist, but only a few copies)
      const now = {}; st.units.forEach(u => { if (u.slot !== 'gone') now[u.id] = (now[u.id] || 0) + (C[u.level - 1] || 1); });
      if (cp) { let s = 0; for (const id in now) { const d = now[id] - ((cp[id] || 0) + (got[id] || 0)); if (d > 0) s += d; }
        s = Math.max(0, s - 3 * evs);
        if (s > LIM.surplusFight) bad(`${at}: ${s} character copies appeared without a buy or an event`); surplusRun += s; }
      cp = now; evs = 0;
    } else if (cp) { for (const id in got) cp[id] = (cp[id] || 0) + got[id]; }
    lastF = f;
  }
  if (surplusRun > LIM.surplusRun) bad(`${surplusRun} character copies appeared without a buy or an event over the run`);
  if (why.length) return { status: 'rejected', why };
  // ---- re-play every finished fight (format 2 + a build of this version)
  if ((rec.fmt | 0) < 2) return { status: 'plausible', why: ['older format: no replay data'] };
  if (!rp) return { status: 'plausible', why: [`no build of v${rec.v} to re-play with`] };
  let n = 0;
  for (const r of rec.r) {
    const f = r.f; if (!f || f.w == null) continue;
    if (!f.st || !Number.isInteger(f.sd)) { bad(`round ${r.n}: fight without replay data`); continue; }
    const x = rp.fight(f, rec.lv); n++;
    if (x.err || x.win == null) bad(`round ${r.n}: fight does not replay (${x.err || 'no result'})`);
    else if (x.win !== !!f.w) bad(`round ${r.n}: recorded a ${f.w ? 'win' : 'loss'}, the replay is a ${x.win ? 'win' : 'loss'}`);
    if (x.cap != null && x.nf > x.cap) bad(`round ${r.n}: ${x.nf} board slots used, the rank allows ${x.cap}`);
  }
  if (why.length) return { status: 'rejected', why };
  return { status: 'verified', why: [`${n} fights re-played`] };
}

// ---------------------------------------------------------------- a batch
export function validateAll(items) {   // items: [{file, rec}]
  const seen = new Map(), out = [];
  for (const it of items) {
    let res;
    if (!it.rec) res = { status: 'rejected', why: ['not JSON'] };
    else {
      const h = crypto.createHash('sha1').update(JSON.stringify(it.rec.r || null)).digest('hex');
      if (seen.has(h)) res = { status: 'rejected', why: [`duplicate of ${seen.get(h)}`] };
      else { seen.set(h, it.rec.rid || it.file); res = check(it.rec, typeof it.rec.v === 'string' ? replayer(it.rec.v) : null); }
    }
    out.push(Object.assign({ file: it.file, rid: it.rec && it.rec.rid, v: it.rec && it.rec.v, build: it.rec && it.rec.build || null }, res));
  }
  return out;
}
const summary = rs => { const c = { verified: 0, plausible: 0, rejected: 0 }; rs.forEach(r => c[r.status]++); return c; };

// ---------------------------------------------------------------- self-test
function selftest() {
  const b = A.build[0] || path.join(REPO, 'tropebrawl.html'), N = +A.n || 300;
  const rp = new Replayer(b); BUILDS.set(rp.version, path.resolve(b)); RP.set(rp.version, rp);
  if (!rp.facts) throw new Error('no facts');
  const runs = [], lvs = [1, 2, 3, 4, 5, 7, 9, 10, 12, 13, 14, 15, 16, 17, 18];
  for (let i = 0; runs.length < N && i < N * 3; i++) { const rec = rp.live(7001 + i * 104729, lvs[i % lvs.length], i % 9 === 4 ? { quitAt: 4 + i % 7 } : null); if (rec) runs.push(rec); }
  let fails = 0; const ok = (name, c, x) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + name + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 400) : '')); };
  const legit = validateAll(runs.map((rec, i) => ({ file: 'legit' + i, rec })));
  const fights = runs.reduce((a, r) => a + r.r.filter(x => x.f && x.f.w != null).length, 0);
  const rivals = runs.reduce((a, r) => a + r.r.filter(x => x.f && x.f.rv).length, 0);
  ok(`${runs.length} live-mode runs (${fights} fights, ${rivals} vs rival casts): all verified`, legit.every(r => r.status === 'verified'), legit.filter(r => r.status !== 'verified').slice(0, 3));
  // forge
  const clone = o => JSON.parse(JSON.stringify(o));
  const pick = (pred) => runs.find(pred);
  const long = pick(r => r.r.filter(x => x.f && x.f.w != null).length >= 6 && r.r.some(x => x.f && x.f.w === 0)) || runs[0];
  const forgeries = [];
  const add = (name, fn, base) => { const rec = clone(base || long); rec.rid = (rec.rid + 'x' + forgeries.length).slice(0, 24); try { fn(rec); } catch (e) {} forgeries.push({ name, rec }); };
  const lastF = rec => rec.r.filter(x => x.f && x.f.w != null).slice(-1)[0];
  add('gold inflated at a round start', rec => { rec.r[Math.min(3, rec.r.length - 1)].g += 120; });
  add('gold inflated in the fight state', rec => { const r = lastF(rec); r.f.g += 90; r.f.st.gold += 90; });
  add('a lost fight flipped to a win', rec => { rec.r.find(x => x.f && x.f.w === 0).f.w = 1; });
  add('a forged 3-star board (summary and state)', rec => { const r = lastF(rec); const u = r.f.st.units.find(x => x.slot[0] !== 'n') || r.f.st.units[0]; u.level = 3; r.f.b = r.f.st.units.filter(x => x.slot[0] !== 'n').map(x => x.id + ':' + x.level + ':' + x.slot); });
  add('board summary differs from the state', rec => { const r = lastF(rec); r.f.b[0] = r.f.b[0].replace(/:1:/, ':2:'); if (!/:2:/.test(r.f.b[0])) r.f.b.push('riot:1:f9'); });
  add('a buy the shop never offered', rec => { const r = rec.r.find(x => x.a.some(a => a[0] === 'b')); r.a.push('b:' + rp.facts.heroes[rp.facts.heroes.length - 1] + ':2'); });
  add('an unknown character', rec => { lastF(rec).f.b.push('superman:1:f1'); });
  add('six items (cap 5)', rec => { const r = lastF(rec); r.f.it = rp.facts.items.slice(0, rp.facts.itemCap + 1).map(t => t + ':1'); r.f.st.trinkets = rp.facts.items.slice(0, rp.facts.itemCap + 1); r.f.st.tlv = Object.fromEntries(r.f.st.trinkets.map(t => [t, 1])); });
  add('item level above the maximum', rec => { const r = lastF(rec); r.f.it = [rp.facts.items[0] + ':' + (rp.facts.itemMax + 2)]; r.f.st.trinkets = [rp.facts.items[0]]; r.f.st.tlv = { [rp.facts.items[0]]: rp.facts.itemMax + 2 }; });
  add('rank 15', rec => { rec.r[1].rk = 15; });
  add('a demo run at Level 15', rec => { rec.build = 'demo'; rec.lv = 15; rec.r.forEach(x => { if (x.f && x.f.st) x.f.st.lv = 15; }); }, pick(r => r.lv === 15) || long);
  add('fight replay data stripped', rec => { delete lastF(rec).f.sd; });
  add('a different fight seed (fishing for a win)', rec => { const r = rec.r.find(x => x.f && x.f.w === 0); r.f.w = 1; r.f.sd = (r.f.sd ^ 0x2545F491) | 0; });
  add('characters out of nowhere (state and summary)', rec => { const r = lastF(rec); const ids = rp.facts.heroes.filter(h => !r.f.st.units.some(u => u.id === h)).slice(0, 3);
    ids.forEach((id, j) => r.f.st.units.push({ uid: 900 + j, id, level: 3, slot: 'n' + (j + 1), cost: 1 })); r.f.n = (r.f.n || []).concat(ids.map(id => id + ':3')); });
  add('rounds out of order', rec => { const t = rec.r[1]; rec.r[1] = rec.r[2]; rec.r[2] = t; });
  add('not a run', rec => { rec.r = 'hello'; });
  forgeries.push({ name: 'a duplicate of a legit run under a new id', rec: Object.assign(clone(long), { rid: 'dup' + long.rid.slice(0, 18) }) });
  const res = validateAll([{ file: 'orig', rec: long }].concat(forgeries.map((f, i) => ({ file: 'forged' + i, rec: f.rec }))));
  ok('the original of the forgeries is verified', res[0].status === 'verified', res[0]);
  forgeries.forEach((f, i) => ok('rejected: ' + f.name, res[i + 1].status === 'rejected', res[i + 1].why));
  const old = clone(long); delete old.fmt; old.r.forEach(x => { if (x.f) { delete x.f.st; delete x.f.sd; delete x.f.rv; } }); old.rid = 'old' + old.rid.slice(0, 18);
  const ro = validateAll([{ file: 'old', rec: old }])[0];
  ok('an older-format copy (no replay data) is plausible, not verified', ro.status === 'plausible', ro);
  console.log(fails ? `${fails} FAIL` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
}

// ---------------------------------------------------------------- main
const MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);   // not when imported
if (MAIN && A.selftest) selftest();
else if (MAIN) {
  if (!A._.length) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 22).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }
  const files = [];
  const walk = p => { const s = fs.statSync(p); if (s.isDirectory()) { for (const f of fs.readdirSync(p).sort()) if (f !== 'rejected') walk(path.join(p, f)); } else if (/\.json$/.test(p) && path.basename(p) !== 'state.json') files.push(p); };
  A._.forEach(walk);
  const items = files.map(f => { let rec = null; try { const t = fs.readFileSync(f, 'utf8'); if (t.length < 4e6) rec = JSON.parse(t); } catch (e) {} return { file: f, rec }; });
  const rs = validateAll(items), c = summary(rs);
  const out = A.out || path.join(REPO, 'fastsim', 'out', 'runlog', 'validate.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), counts: c, limits: LIM, runs: rs }, null, 1));
  if (A.move) for (const r of rs) if (r.status === 'rejected') {
    const dst = path.join(path.dirname(r.file), 'rejected', path.basename(r.file)); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.renameSync(r.file, dst);
  }
  const reasons = {}; rs.filter(r => r.status === 'rejected').forEach(r => { const k = (r.why[0] || '').replace(/round \d+/, 'round N').replace(/\d+/g, '#'); reasons[k] = (reasons[k] || 0) + 1; });
  console.log(`runs ${rs.length}: verified ${c.verified}, plausible ${c.plausible}, rejected ${c.rejected}${A.move ? ' (moved to rejected/)' : ''} -> ${out}`);
  Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([k, n]) => console.log(`  ${n} x ${k}`));
}
