// Builds summary.json for runs.html (the live run-log page). Run inside a checkout of the runlog branch.
// Same filters as fastsim/retention.js in the dev repo: drops p_selftest, runs under 10 s and old click-script runs.
import fs from 'fs';
import path from 'path';
const KNOWN = { p_a5lfpfju: 'Philippe' };
const isBot = j => (j.res === 'open' && Array.isArray(j.r) && j.r.length <= 2 && j.ms < 40000) || (Array.isArray(j.r) && j.r.length >= 3 && j.ms / j.r.length < 6000);
const all = [];
for (const p of fs.readdirSync('runs')) for (const f of fs.readdirSync('runs/' + p)) {
  if (!f.endsWith('.json')) continue;
  try { all.push(JSON.parse(fs.readFileSync(`runs/${p}/${f}`, 'utf8'))); } catch (e) {}
}
const tester = new Set(all.filter(j => j.t || KNOWN[j.pid]).map(j => j.pid));
const who = j => KNOWN[j.pid] ? 'me' : tester.has(j.pid) ? 'tester' : 'stranger';
const rows = [], errors = [];
for (const j of all) {
  if (j.pid === 'p_selftest' || j.res === 'bp') continue;   // bp: the board-sharing switch note (TRO-401), not a run
  if (j.res === 'error') {   // TRO-288: a JS error note from the game (untrusted input: types forced, lengths capped)
    const e = j.err && typeof j.err === 'object' ? j.err : {};
    if (typeof e.m !== 'string' || !e.m) continue;
    errors.push({ at: j.at, pid: j.pid, who: who(j), test: j.hd ? 1 : 0, build: j.build === 'demo' ? 'itch' : 'page', v: String(j.v || '').slice(0, 12),
      dev: String(j.dev || '').slice(0, 10), m: String(e.m || '').slice(0, 200), loc: String(e.at || '').slice(0, 60),
      scr: String(e.scr || '').slice(0, 20), rd: Number.isFinite(e.rd) ? e.rd : null, lv: Number.isFinite(e.lv) ? e.lv : null });
    continue;
  }
  const visit = j.res === 'visit';
  if (!visit && (j.ms < 10000 || isBot(j))) continue;
  const last = (j.r || []).filter(x => x.f).pop();
  rows.push({
    at: j.at, pid: j.pid, who: who(j), visit, build: j.build === 'demo' ? 'itch' : 'page', from: j.from || '', dev: j.dev || '',
    v: j.v, lv: j.lv, res: j.res, round: j.round, lives: j.lives, min: Math.round((j.ms || 0) / 6000) / 10,
    daily: j.daily || '', board: last ? last.f.b.map(u => u.split(':').slice(0, 2).join(':')) : [], foe: last ? last.f.en : ''
  });
}
rows.sort((a, b) => a.at < b.at ? 1 : -1);
const built = all.map(j => j.recv || j.at).sort().pop();
errors.sort((a, b) => a.at < b.at ? 1 : -1);

// Totals block for runs.html (TRO-501). Aggregates only (no player ids leave this script). Same definitions as
// fastsim/retention.js in the dev repo: real run = not selftest, 10 s or more, not a script run; stranger = run not
// marked t:1 and not Philippe's pid. Days are America/Winnipeg days. TB_SINCE=<ISO date> limits the window (cross-check).
const SINCE = process.env.TB_SINCE || '', TZ = 'America/Winnipeg', NOW = Date.now(), WK = 7 * 864e5;
const dkey = s => new Date(s).toLocaleDateString('en-CA', { timeZone: TZ });
const GEN = {}, GK = new Set(['army', 'bug', 'undead', 'heist', 'west', 'horror', 'space', 'kaiju', 'ball']);
try { const h = fs.readFileSync(process.env.GAME_HTML || path.join('..', 'src', 'index.html'), 'utf8');
  for (const m of h.matchAll(/\[\s*'(\w+)'\s*,\s*'[^']*'\s*,\s*'(\w+)'\s*,/g)) if (!GEN[m[1]] && GK.has(m[2])) GEN[m[1]] = m[2]; } catch (e) {}
const real = all.filter(j => j.pid && j.pid !== 'p_selftest' && j.res !== 'error' && j.res !== 'bp' && j.res !== 'visit' && j.ms >= 10000 && !isBot(j) && (!SINCE || j.at >= SINCE))
  .sort((a, b) => a.at < b.at ? -1 : 1);
const grp = j => KNOWN[j.pid] ? 'me' : j.t === 1 ? 'tester' : 'stranger';
const byP = {}; for (const j of real) (byP[j.pid] = byP[j.pid] || []).push(j);
const isLoss = j => j.res === 'lose' || j.res === 'loss';
const sum = a => a.reduce((x, j) => x + j.ms / 60000, 0), r1 = x => Math.round(x * 10) / 10;
const med = a => { if (!a.length) return null; a = a.slice().sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const todayK = dkey(new Date(NOW).toISOString()), wk = j => NOW - Date.parse(j.at) < WK;
const st = real.filter(j => grp(j) === 'stranger'), sp = [...new Set(st.map(j => j.pid))];
const per = (a, f) => { const o = {}; for (const j of a) { const k = f(j); if (k != null && k !== '') (o[k] = o[k] || new Set()).add(j.pid); } return o; };
const top = (a, f, n) => { const o = {}; for (const j of a) { for (const k of [].concat(f(j))) if (k != null && k !== '') o[k] = (o[k] || 0) + 1; }
  return Object.entries(o).sort((x, y) => y[1] - x[1]).slice(0, n); };
const grpStat = g => { const a = real.filter(j => grp(j) === g); return { players: new Set(a.map(j => j.pid)).size, runs: a.length, min: Math.round(sum(a)), runs7: a.filter(wk).length, min7: Math.round(sum(a.filter(wk))) }; };
const firstAt = p => byP[p].find(j => grp(j) === 'stranger').at;
const newDay = {}; for (const p of sp) { const d = dkey(firstAt(p)); newDay[d] = (newDay[d] || 0) + 1; }
const days30 = []; for (let i = 29; i >= 0; i--) { const d = dkey(new Date(NOW - i * 864e5).toISOString()); days30.push([d, newDay[d] || 0]); }
const first = sp.map(p => byP[p][0]);
const past3 = first.filter(j => j.res === 'win' || isLoss(j) || (j.round | 0) >= 4);
const sameVisit = sp.filter(p => { const a = byP[p]; return a[1] && Date.parse(a[1].at) - Date.parse(a[0].end || a[0].at) <= 18e5; });
const elig = sp.filter(p => dkey(byP[p][0].at) < todayK), back = elig.filter(p => byP[p].some(j => dkey(j.at) > dkey(byP[p][0].at)));
const won = new Set(st.filter(j => j.res === 'win').map(j => j.pid)), enc = new Set(st.filter(j => j.enc != null).map(j => j.pid));
const fin = st.filter(j => j.res === 'win' || isLoss(j));
const big = j => { const f = (Array.isArray(j.r) ? j.r : []).filter(x => x.f && Array.isArray(x.f.b)).slice(-1)[0], c = {};
  if (f) for (const u of f.f.b) { const g = GEN[String(u).split(':')[0]]; if (g) c[g] = (c[g] || 0) + 1; } return Object.keys(c).filter(g => c[g] >= 4); };
const vkey = v => String(v || '0').split('.').map(x => x.padStart(4, '0')).join('.');
const vers = {}; for (const j of st) { const v = String(j.v || '?').slice(0, 12); (vers[v] = vers[v] || { runs: 0, players: new Set() }).runs++; vers[v].players.add(j.pid); }
const fromP = per(st, j => j.from);
const totals = {
  since: SINCE || null, tz: TZ,
  strangers: { all: sp.length, week: new Set(st.filter(wk).map(j => j.pid)).size, today: new Set(st.filter(j => dkey(j.at) === todayK).map(j => j.pid)).size, newPerDay: days30 },
  groups: { stranger: grpStat('stranger'), tester: grpStat('tester'), me: grpStat('me') },
  like: { past3: [past3.length, first.length], sameVisit: [sameVisit.length, sp.length], cameBack: [back.length, elig.length],
    won: [won.size, sp.length], encore: [enc.size, sp.length], medianRunMin: r1(med(st.map(j => j.ms / 60000))) },
  play: { levels: top(st, j => 'Level ' + j.lv, 6), genres: top(fin, j => big(j), 9), showrunners: top(st, j => j.sr, 8), srRuns: st.filter(j => j.sr).length,
    versions: Object.entries(vers).sort((a, b) => vkey(b[0]) < vkey(a[0]) ? -1 : 1).slice(0, 6).map(([v, o]) => [v, o.runs, o.players.size]) },
  origin: { daily: [st.filter(j => j.daily).length, st.length], dailyPlayers: new Set(st.filter(j => j.daily).map(j => j.pid)).size, challenge: st.filter(j => j.chal).length,
    from: Object.entries(fromP).map(([k, s]) => [k, s.size]).sort((a, b) => b[1] - a[1]).slice(0, 6) },
};
fs.writeFileSync(process.env.TB_OUT || 'summary.json', JSON.stringify({ built, generated: new Date().toISOString(), rows, errors, totals }));
console.log('summary.json:', rows.length, 'rows,', errors.length, 'errors; totals:', JSON.stringify({ s: totals.strangers, g: totals.groups, like: totals.like }));
