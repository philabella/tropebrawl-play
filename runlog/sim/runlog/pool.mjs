// The real-player board pool for "Reruns from real studios" (async PvP part 1, TRO-401; design in
// docs/design/async-pvp-feasibility.md). Run inside a checkout of the runlog branch (runs/<pid>/<rid>.json):
//
//   node <tropebrawl>/runlog/pool.mjs --build <current game html> [--gitrepo <repo> --gitfile index.html]
//        [--builds <cache dir>] [--scan] [--legacy <snapshot.json>] [--max 2000] [--workers 4] [--out pool.json]
//        [--status pool-status.json]
//
// 1. Real runs only (summary.mjs rules: no p_selftest, no script runs, 10 s+, no tester or Philippe), no duplicates.
// 2. Verified runs only: every fight re-played exactly by validate.mjs on the build of the run's version (--build for
//    the current one, --gitrepo/--gitfile find older ones in git history). Results are cached by rid + file hash.
// 3. Every fight board -> a Rerun row [rank, legend, lives, maxLives, streak, items, units, m, {id, r, lv}] (the
//    game's GHOSTS format plus provenance for the VS card: the board's round and Game Level; never an id, a date, a
//    country or a device). Boards with a character, item or Legendary no longer in the game are dropped.
// 4. Calibration: each board's strength m (ghost-cal-page.js, as `ghost.js calibrate`: reference boards fight the
//    round's monsters and this board; m = where both are won half the time) on a Level 10 copy of the current build.
//    References = the game's own Rerun boards of the round (GHOSTS), else other real boards of the round. Cached per
//    board id + game version, so a new version recalibrates (characters reworked since are re-measured, not trusted);
//    at most --max boards a run, the rest keep their last m until their turn.
// 5. Filters per (Level band, round): board at least 75% filled for its rank, m inside 0.2-2.5, strength (1/m) above
//    the round's 95th percentile dropped, at most 15% of a round from one player (newest kept), at most 30 boards
//    (newest kept). One copy per board id (TRO-318: the game never shows the same board twice in a run).
// 6. Consent: a board is served only if its run says `bp:1` ("Let other players fight my saved boards"; the field
//    arrives with the game patch). Runs from before the switch never go in pool.json; --legacy writes them to a
//    snapshot for the labs only (fastsim/pvp/, never published).
// Out: pool.json (served; `ready` per band = every fight round has 20+ boards from 8+ players) and pool-status.json
// (counts for docs/design/async-pvp-status.md, consented and not-yet-consented boards).
import fs from 'fs'; import path from 'path'; import os from 'os'; import crypto from 'crypto';
import { createRequire } from 'module'; import { fileURLToPath, pathToFileURL } from 'url';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '..');
const { Engine } = require(path.join(REPO, 'fastsim', 'engine.js'));
const CALPAGE = path.join(REPO, 'fastsim', 'ghost-cal-page.js');
const RULE = { minBoards: 20, minPlayers: 8, maxShare: 0.15, maxPerRound: 30, fill: 0.75, mLo: 0.2, mHi: 2.5, pct: 0.95, calLv: 10, fights: 24, steps: 7, refs: 8 };
const BANDS = [['4-8', 4, 8], ['9-13', 9, 13], ['14-18', 14, 99]];
const KNOWN = { p_a5lfpfju: 'Philippe' };
const hseed = (...xs) => { let h = 0x811c9dc5; for (const x of xs) { const s = String(x); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } h ^= 0x7f; h = Math.imul(h, 0x01000193); } return (h >>> 1) || 1; };

// ---------------------------------------------------------------- calibration worker
if (!isMainThread) {
  const eng = new Engine({ build: workerData.build, scripts: [] });
  eng.ev(fs.readFileSync(CALPAGE, 'utf8'));
  parentPort.on('message', m => { let r; try { r = eng.ctx.GHCAL.run(m.job); } catch (e) { r = { err: e.message }; } parentPort.postMessage(Object.assign({ id: m.id }, r)); });
} else main();

function args() {
  const A = {}; process.argv.slice(2).forEach((a, i, v) => { if (a.startsWith('--')) A[a.slice(2)] = v[i + 1] && !v[i + 1].startsWith('--') ? v[i + 1] : true; });
  return A;
}

async function main() {
  const A = args(), t0 = Date.now();
  if (!A.build) { console.error('--build <current game html> needed'); process.exit(1); }
  const V = await import(pathToFileURL(path.join(REPO, 'runlog', 'validate.mjs')).href);
  const BUILD = path.resolve(A.build), CUR = V.addBuild(BUILD);
  // older versions' builds from git history, cached outside the runlog checkout (--scan: one pass over every commit)
  if (A.gitrepo) V.useGit(A.gitrepo, A.gitfile || 'index.html', path.resolve(A.builds || path.join(os.tmpdir(), 'tb-builds')), !!A.scan);
  fs.mkdirSync('pool', { recursive: true });
  // Level 10 copy for calibration (same reference level as the TRO-323 study)
  const src = fs.readFileSync(BUILD, 'utf8'), LVSRC = 'const lv=Math.max(0,Math.min(LV_MAX,UI.lv|0))';
  if (src.split(LVSRC).length !== 2) { console.error('Level line not found once in the build: update LVSRC in pool.mjs'); process.exit(1); }
  const LV10 = path.join(os.tmpdir(), `tb-pool-lv10-${CUR}.html`); fs.writeFileSync(LV10, src.replace(LVSRC, 'const lv=' + RULE.calLv));
  const eng = new Engine({ build: LV10, scripts: [] });
  eng.ev(`['render','save','closeSheet','toast','showPending','drawBattle','shake','sheet','sfx'].forEach(n=>{if(typeof globalThis[n]==='function')globalThis[n]=function(){};});UI.lv=${RULE.calLv};newRun();
    globalThis.PL={fill(g){const pS=S;try{S=ghState(g);return [boardSize(),S.units.reduce((a,u)=>a+(twoSlot(u.id)?2:1),0)];}finally{S=pS;}}};`);
  const HERO = eng.ev('HERO'), TR = eng.ev('TR'), LEG = new Set(Object.keys(eng.ev('LEGENDS_ALL')));
  const GHOSTS = eng.ev('GHOSTS');
  const FIGHT_ROUNDS = eng.ev(`JSON.stringify(SCHEDULE.map((e,i)=>e.type==='fight'?i+1:0).filter(Boolean))`);
  const FR = JSON.parse(FIGHT_ROUNDS), FRS = new Set(FR);

  // ---------------------------------------------------------------- runs
  const isBot = j => (j.res === 'open' && Array.isArray(j.r) && j.r.length <= 2 && j.ms < 40000) || (Array.isArray(j.r) && j.r.length >= 3 && j.ms / j.r.length < 6000);
  const files = [];
  for (const p of fs.existsSync('runs') ? fs.readdirSync('runs') : []) {
    const d = path.join('runs', p); if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d)) if (f.endsWith('.json')) files.push(path.join(d, f));
  }
  const all = [];
  for (const f of files) { try { const t = fs.readFileSync(f, 'utf8'); if (t.length < 4e6) all.push({ f, t, j: JSON.parse(t) }); } catch (e) { } }
  const tester = new Set(all.filter(x => x.j.t || KNOWN[x.j.pid]).map(x => x.j.pid));
  const real = all.filter(({ j }) => Array.isArray(j.r) && j.res !== 'visit' && j.res !== 'error' && j.pid !== 'p_selftest' && !isBot(j) && j.ms >= 10000 && !tester.has(j.pid));
  // duplicates (same rounds under another id): keep the first by start time
  real.sort((a, b) => String(a.j.at) < String(b.j.at) ? -1 : 1);
  const seen = new Set(), runs = [];
  for (const x of real) { const h = crypto.createHash('sha1').update(JSON.stringify(x.j.r)).digest('hex'); if (!seen.has(h)) { seen.add(h); runs.push(x); } }

  // ---------------------------------------------------------------- verify (cached)
  const CF = path.join('pool', 'cache.json');
  const cache = fs.existsSync(CF) ? JSON.parse(fs.readFileSync(CF, 'utf8')) : {};
  cache.ver = cache.ver || {}; cache.cal = cache.cal || {};
  const withState = runs.filter(x => x.j.r.some(r => r.f && r.f.st));
  const todo = withState.filter(x => { const c = cache.ver[x.j.rid]; return !c || c.h !== hash(x.t); });
  const byV = {}; todo.forEach(x => { (byV[x.j.v] = byV[x.j.v] || []).push(x); });
  for (const v of Object.keys(byV)) {
    for (const x of byV[v]) { const r = V.check(x.j, typeof x.j.v === 'string' ? V.replayer(x.j.v) : null); cache.ver[x.j.rid] = { h: hash(x.t), s: r.status, why: (r.why || []).slice(0, 2) }; }
    V.dropReplayers();
  }
  const st = { verified: 0, plausible: 0, rejected: 0 }; withState.forEach(x => { st[cache.ver[x.j.rid].s]++; });
  console.log(`runs: ${all.length} files, ${runs.length} real, ${withState.length} with board state; verified ${st.verified}, plausible ${st.plausible}, rejected ${st.rejected} (${todo.length} checked now)`);

  // ---------------------------------------------------------------- boards
  const bandOf = lv => { const b = BANDS.find(b => lv >= b[1] && lv <= b[2]); return b ? b[0] : null; };
  const drop = {}; const no = k => { drop[k] = (drop[k] || 0) + 1; };
  const boards = new Map();   // id -> board (one copy per id; newest run wins)
  for (const x of withState) {
    const j = x.j; if (cache.ver[j.rid].s !== 'verified') { no('run not verified'); continue; }
    const band = bandOf(j.lv | 0); if (!band) { no('Pilot / tutorial level'); continue; }
    const consent = j.bp === 1 ? 'yes' : j.bp === 0 ? 'no' : 'before';
    for (const r of j.r) {
      const f = r.f; if (!f || !f.st || !Array.isArray(f.st.units)) continue;
      const s = f.st, round = s.round != null ? s.round : r.n;
      if (!FRS.has(round) || (s.part | 0) > 1) { no('boss or event round'); continue; }
      const field = s.units.filter(u => u.slot && u.slot[0] !== 'n');
      if (!field.length) { no('empty board'); continue; }
      if (field.some(u => !HERO[u.id])) { no('character no longer in the game'); continue; }
      if (s.legend && !LEG.has(s.legend)) { no('Legendary no longer in the game'); continue; }
      if ((s.trinkets || []).some(k => !TR[k])) { no('item no longer in the game'); continue; }
      const row = [s.rank, s.legend || '', s.lives, s.maxLives || s.lives, s.streak || 0,
        (s.trinkets || []).map(k => k + ':' + ((s.tlv && s.tlv[k]) || 1)).join(','), field.map(u => u.id + ':' + u.level + ':' + u.slot).join(','), 1];
      const [cap, nf] = eng.ctx.PL.fill(row);
      if (nf < RULE.fill * cap) { no('board under 75% filled'); continue; }
      const id = hash(round + '|' + row.slice(0, 7).join('|')).slice(0, 10);
      const b = { id, row, round, lv: j.lv | 0, band, pid: j.pid, at: String(j.at || ''), consent };
      const o = boards.get(id); if (!o || o.at < b.at) boards.set(id, b); else no('same board again');
    }
  }
  const B = [...boards.values()];
  console.log(`boards: ${B.length} from verified Level 4+ runs; dropped ${Object.entries(drop).map(([k, v]) => `${k} ${v}`).join(', ')}`);

  // ---------------------------------------------------------------- calibrate (cached per board id + version)
  const key = b => b.id + '@' + CUR;
  const need = B.filter(b => !cache.cal[key(b)]).sort((a, b) => a.at < b.at ? 1 : -1).slice(0, +(A.max || 2000));
  const byRound = {}; B.forEach(b => { (byRound[b.round] = byRound[b.round] || []).push(b); });
  const ghR = Object.keys(GHOSTS).map(Number);
  const refsFor = b => {
    let L = (GHOSTS[b.round] || []).map(g => [b.round].concat(g.slice(0, 7)));
    if (L.length < RULE.refs) L = L.concat((byRound[b.round] || []).filter(o => o.id !== b.id).map(o => [b.round].concat(o.row.slice(0, 7))));
    if (L.length < 3) { const r = ghR.sort((x, y) => Math.abs(x - b.round) - Math.abs(y - b.round))[0]; L = L.concat(GHOSTS[r].map(g => [b.round].concat(g.slice(0, 7)))); }
    const out = []; for (let k = 0; k < RULE.refs; k++) out.push(L[hseed('ref', b.id, k) % L.length]); return out;
  };
  if (need.length) {
    const NW = Math.max(1, Math.min(os.cpus().length, +(A.workers || 4), need.length));
    console.log(`calibrating ${need.length} boards on v${CUR} (Level ${RULE.calLv}), ${NW} workers`);
    await new Promise(res => {
      let next = 0, done = 0; const W = Array.from({ length: NW }, () => new Worker(fileURLToPath(import.meta.url), { workerData: { build: LV10 } }));
      const feed = w => { if (next >= need.length) return; const b = need[next++]; w.postMessage({ id: b.id, job: { ghost: [b.round].concat(b.row.slice(0, 7)), refs: refsFor(b), fights: RULE.fights, steps: RULE.steps } }); };
      W.forEach(w => {
        w.on('message', m => {
          if (!m.err) cache.cal[m.id + '@' + CUR] = +m.m.toFixed(3);
          if (++done % 100 === 0) console.log(`  ${done}/${need.length} ${((Date.now() - t0) / 60000).toFixed(1)} min`);
          if (done === need.length) { W.forEach(x => x.terminate()); res(); } else feed(w);
        });
        w.on('error', e => { console.error(e); done++; if (done === need.length) { W.forEach(x => x.terminate()); res(); } else feed(w); });
        feed(w);
      });
    });
  }
  // m: this version's, else the newest older one (until its turn), else not usable yet
  const lastM = {}; Object.entries(cache.cal).forEach(([k, m]) => { const [id, v] = k.split('@'); if (!lastM[id] || vcmp(v, lastM[id].v) > 0) lastM[id] = { v, m }; });
  B.forEach(b => { const c = cache.cal[key(b)]; b.m = c != null ? c : lastM[b.id] ? lastM[b.id].m : null; b.stale = c == null; });
  // the cache keeps only boards still in the pool (this version and the newest older m)
  const keep = {}; B.forEach(b => { if (cache.cal[key(b)] != null) keep[key(b)] = cache.cal[key(b)]; else if (lastM[b.id]) keep[b.id + '@' + lastM[b.id].v] = lastM[b.id].m; });
  cache.cal = keep;
  fs.writeFileSync(CF, JSON.stringify(cache));

  // ---------------------------------------------------------------- filters per (band, round)
  const pick = list => {
    const fdrop = {}; const no2 = k => { fdrop[k] = (fdrop[k] || 0) + 1; };
    const out = {};
    for (const [band] of BANDS) for (const r of FR) {
      let xs = list.filter(b => b.band === band && b.round === r);
      if (!xs.length) continue;
      xs = xs.filter(b => { if (b.m == null) { no2('not calibrated yet'); return false; } if (b.m < RULE.mLo || b.m > RULE.mHi) { no2('m outside 0.2-2.5'); return false; } return true; });
      if (xs.length) {
        const s = xs.map(b => 1 / b.m).sort((a, b) => a - b), p95 = s[Math.ceil(RULE.pct * s.length) - 1];
        xs = xs.filter(b => { if (1 / b.m > p95) { no2('strongest 5% of the round'); return false; } return true; });
      }
      xs.sort((a, b) => a.at < b.at ? 1 : -1);
      const capP = Math.max(1, Math.ceil(RULE.maxShare * xs.length)), per = {};
      xs = xs.filter(b => { per[b.pid] = (per[b.pid] || 0) + 1; if (per[b.pid] > capP) { no2('over 15% from one player'); return false; } return true; });
      if (xs.length > RULE.maxPerRound) { fdrop['over 30 a round (oldest)'] = (fdrop['over 30 a round (oldest)'] || 0) + xs.length - RULE.maxPerRound; xs = xs.slice(0, RULE.maxPerRound); }
      if (xs.length) out[band + '|' + r] = xs;
    }
    return { out, fdrop };
  };
  const served = pick(B.filter(b => b.consent === 'yes')), wouldBe = pick(B.filter(b => b.consent !== 'no'));
  const bandsOut = (sel, withPid) => Object.fromEntries(BANDS.map(([band, lo, hi]) => {
    const rounds = {}, cnt = {}; let ready = true;
    for (const r of FR) {
      const xs = sel.out[band + '|' + r] || [], pl = new Set(xs.map(b => b.pid)).size;
      cnt[r] = [xs.length, pl]; if (xs.length < RULE.minBoards || pl < RULE.minPlayers) ready = false;
      if (xs.length) rounds[r] = xs.map(b => b.row.slice(0, 7).concat([b.m, Object.assign({ id: b.id, r: b.round, lv: b.lv }, withPid ? { p: hash(b.pid).slice(0, 6), stale: b.stale ? 1 : 0 } : {})]));
    }
    const players = new Set(Object.keys(sel.out).filter(k => k.startsWith(band + '|')).flatMap(k => sel.out[k].map(b => b.pid))).size;
    return [band, { lv: [lo, Math.min(hi, 18)], ready, players, count: cnt, rounds }];
  }));
  const head = { fmt: 1, built: new Date().toISOString(), v: CUR, cal: { lv: RULE.calLv, refs: 'GHOSTS of the round, else real boards of the round', fights: RULE.fights, steps: RULE.steps }, rule: RULE };
  const pool = Object.assign({}, head, { bands: bandsOut(served, false) });
  fs.writeFileSync(A.out || 'pool.json', JSON.stringify(pool));
  if (A.legacy) fs.writeFileSync(path.resolve(A.legacy), JSON.stringify(Object.assign({}, head, { legacy: 'includes runs recorded before the board-sharing switch: labs only, never publish', bands: bandsOut(wouldBe, true) })));
  const strip = b => Object.fromEntries(Object.entries(b).map(([k, x]) => [k, { ready: x.ready, players: x.players, count: x.count }]));
  const status = Object.assign({}, head, { runs: { files: all.length, real: runs.length, withState: withState.length, verified: st.verified, plausible: st.plausible, rejected: st.rejected },
    boards: { all: B.length, consented: B.filter(b => b.consent === 'yes').length, before: B.filter(b => b.consent === 'before').length, refused: B.filter(b => b.consent === 'no').length, uncalibrated: B.filter(b => b.m == null).length },
    dropped: drop, filtered: wouldBe.fdrop, served: strip(pool.bands), ifConsented: strip(bandsOut(wouldBe, false)), fightRounds: FR });
  fs.writeFileSync(A.status || 'pool-status.json', JSON.stringify(status, null, 1));
  const line = (b, n) => Object.entries(b).map(([k, x]) => `${k}: ${x.ready ? 'READY' : 'not ready'}, ${x.players} players, ${Object.values(x.count).reduce((s, c) => s + c[0], 0)} boards`).join('; ');
  console.log(`pool.json (served, consented only): ${line(pool.bands)}`);
  console.log(`if every pre-switch run had consented: ${line(status.ifConsented)}`);
  console.log(`done in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  process.exit(0);
}
function hash(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
function vcmp(a, b) { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; }
