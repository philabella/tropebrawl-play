// Builds summary.json for runs.html (the live run-log page). Run inside a checkout of the runlog branch.
// Same filters as fastsim/retention.js in the dev repo: drops p_selftest, runs under 10 s and old click-script runs.
import fs from 'fs';
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
  if (j.pid === 'p_selftest') continue;
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
fs.writeFileSync('summary.json', JSON.stringify({ built, rows, errors }));
console.log('summary.json:', rows.length, 'rows,', errors.length, 'errors');
