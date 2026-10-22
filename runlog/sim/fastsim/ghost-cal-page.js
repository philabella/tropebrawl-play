// Runs inside the game (fastsim Engine) for ghost.js calibrate. Uses the game's own ghState / ghFoes (v19.67+).
// For one ghost at round r: the reference boards (other ghosts of the round, standing in for players) fight the round's
// monster fights scaled by q and against the ghost scaled by m; q50 and m50 are where they win half their fights
// (bisection on the log scale, then a logistic fit). The ghost's multiplier is m50 / q50 (pref column = q50).
globalThis.GHCAL = (function () {
  ['render', 'save', 'closeSheet', 'toast', 'showPending', 'drawBattle', 'shake', 'sheet', 'sfx', 'tlFight', 'tlRes', 'tlAct'].forEach(n => { if (typeof globalThis[n] === 'function') globalThis[n] = function () { }; });
  newRun(); const BASE = S;
  const asG = row => [row[1], row[2], row[3], row[4], row[5], row[6], row[7], 1];
  function playerState(ref, r) { S = BASE; const st = ghState(asG(ref)); st.round = r; st.part = 0; st.bossTries = 0; S = st; return st; }
  function fight() { startBattle(true); let g = 0; while (!B.done && g++ < 6000) step(DT); return B.win ? 1 : 0; }
  function vsMonsters(ref, r, q) {
    playerState(ref, r); const on = TUNE.ghOn; TUNE.ghOn = 0;
    try { prepareFight(); } finally { TUNE.ghOn = on; }
    if (S.enemy.elite) { S.enemy.norm /= TUNE.lvElite; S.enemy.elite = false; }
    S.enemy.norm *= q; return fight();
  }
  function vsGhost(ref, r, g, m) { playerState(ref, r); const gg = g.slice(); gg[7] = m; S.enemy = { gh: gg, enc: [], tpl: 'ghost', title: 'cal', norm: 1 }; return fight(); }
  // the scale x (log) at which the reference boards win half their fights: bisection, then a logistic fit of all fights
  function half(job, lo, hi, play) {
    const pts = []; let k = 0;
    for (let s = 0; s < job.steps; s++) {
      const x = (lo + hi) / 2; let w = 0;
      for (let i = 0; i < job.fights; i++) { const y = play(job.refs[(k++) % job.refs.length], Math.exp(x)); w += y; pts.push([x, y]); }
      if (w / job.fights > .5) lo = x; else hi = x;
    }
    let x = (lo + hi) / 2, a = 0, b = -1;
    for (let it = 0; it < 25; it++) {
      let ga = 0, gb = 0, haa = 1e-3, hab = 0, hbb = 1e-3;
      for (const [xi, yi] of pts) { const p = 1 / (1 + Math.exp(-(a + b * xi))), w = p * (1 - p) + 1e-6; ga += yi - p; gb += (yi - p) * xi; haa += w; hab += w * xi; hbb += w * xi * xi; }
      const det = haa * hbb - hab * hab; if (Math.abs(det) < 1e-9) break;
      a += (hbb * ga - hab * gb) / det; b += (haa * gb - hab * ga) / det;
    }
    if (b < -0.3) { const xf = -a / b; if (Math.abs(xf - x) < 1) x = xf; }
    return { x, b, n: pts.length };
  }
  function run(job) {
    const r = job.ghost[0], g = asG(job.ghost);
    const q = half(job, Math.log(.3), Math.log(8), (ref, s) => vsMonsters(ref, r, s));
    const m = half(job, Math.log(.05), Math.log(8), (ref, s) => vsGhost(ref, r, g, s));
    S = BASE;
    // the ghost at m50 is as hard as the monsters at q50, so at monster scale 1 it gets m50 / q50
    return { m: Math.exp(m.x - q.x), pref: Math.exp(q.x), b: m.b, n: q.n + m.n };
  }
  return { run };
})();
