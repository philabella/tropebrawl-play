// Re-plays recorded runs (the in-game run log, fmt 2 from the launch-prep patch on) on the vm engine, for the
// anti-poisoning filter runlog/validate.mjs. No browser, no network.
//
//   const { Replayer } = require('./runreplay');
//   const rp = new Replayer('tropebrawl.html');
//   rp.version                      -> the build's TB_VERSION (only runs recorded by this version are re-played)
//   rp.facts                        -> ids and limits for the plausibility checks (characters, items, Legendaries, ranks...)
//   rp.fight(f, lv)                 -> { win } : re-plays one recorded fight from f.st (+ f.rv) with its seed f.sd
//   rp.live(seed, lv, opts)         -> a run played by a random bot in LIVE mode (unseeded game, seeded Math.random,
//                                      real startBattle -> showResult path) with the recorder forced on: exactly what a
//                                      browser sends, so the filter can be tested on runs that must all pass.
//
// Why it replays: a live fight draws only from its own stream FR, seeded with S.inFight.seed when it starts, and the run
// state it is played from is what a reload restores; the record carries both (f.sd and f.st), plus the fought rival's
// state and stream (f.rv) for rival casts. Shops and events draw from Math.random in live play and are not re-played;
// the validator checks them for plausibility instead (offers vs buys, limits, gold).
'use strict';
const path = require('path');
const { Engine } = require('./engine');

const PAGE = String.raw`globalThis.RP=(function(){
  const STUB=['render','save','closeSheet','toast','showPending','drawBattle','shake','sheet','sfx','gbClear','banner','feel'];
  STUB.forEach(n=>{if(typeof globalThis[n]==='function')globalThis[n]=function(){};});
  const clone=o=>JSON.parse(JSON.stringify(o));
  function skeleton(lv){const pS=seeded,pR=rngState;seeded=true;rngState=12345;UI.lv=lv|0;newRun(false);const b=S;seeded=pS;rngState=pR;return b;}
  function facts(){
    const lvs=Object.keys(LADDER).map(Number).filter(n=>n>=0);
    return {version:TB_VERSION,heroes:HEROES.map(h=>h[0]),items:TRINKETS.map(a=>a[0]),itemMax:ITEM_MAX,itemCap:TRINKET_CAP,legends:Object.keys(LEGENDS),
      lvMin:lvMin(),lvMax:LV_MAX,rankMax:RANK.board.length,boardMax:Math.max.apply(null,RANK.board),
      rounds:Object.fromEntries(lvs.map(n=>{try{UI.lv=n;const b=skeleton(n);return [n,{sched:SCHEDULE.length,lives:b.maxLives||b.lives}];}catch(e){return [n,null];}})),
      copies:COPIES.slice(),price:Object.fromEntries(HEROES.map(h=>[h[0],PRICE[HERO[h[0]].tier-1]]))};}
  // one recorded fight: the state it started from, its seed, the fought rival
  function fight(f,lv){
    const keepFR=FR,keepSeed=seeded,keepS=S,keepB=B;let win=null,err=null,cap=null,nf=null;
    try{const base=skeleton(lv);
      S=Object.assign(clone(f.st),{pool:base.pool,seen:base.seen,stats:base.stats,shop:[],usedEvents:[],preDone:base.preDone,pending:[],event:null,lobby:null});
      if(f.rv)S.lobby={rv:[{id:f.rv.id,rng:f.rv.rng,st:clone(f.rv.st),out:!!f.rv.out,snap:f.rv.snap||null}]}; // v20.19: out + snap
      S.inFight={seed:f.sd|0};seeded=false;cap=boardSize();nf=fielded().reduce((a,u)=>a+(twoSlot(u.id)?2:1),0);
      const tf=globalThis.tlFight,ts=globalThis.tlSeed;globalThis.tlFight=function(){};globalThis.tlSeed=function(){};
      try{startBattle(false);let g=0;while(!B.done&&g++<40000)step(DT);win=B.done?!!B.win:null;}
      finally{globalThis.tlFight=tf;globalThis.tlSeed=ts;}}
    catch(e){err=String(e&&e.message||e).slice(0,160);}
    finally{FR=keepFR;seeded=keepSeed;S=keepS;B=keepB;}
    return {win,err,cap,nf};}
  // live-mode bot run, recorder forced (globalThis.__tlForce -> __tlOut)
  function live(seed,lv,o){o=o||{};let st=seed>>>0||1;const R=()=>{st=Math.imul(st^st>>>15,1|st)+0x6D2B79F5|0;return ((st^st>>>14)>>>0)/4294967296;};
    seeded=false;FR=null;UI.lv=lv|0;globalThis.__tlForce=true;globalThis.__tlOut=[];TL=null;
    newRun(false);let guard=0;
    const settleEv=()=>{let g=0;while(S.event&&S.event.picked&&(!S.event.sub||S.event.subDone)&&g++<5)finishEvent();};
    settleEv();
    while(S&&!S.over&&guard++<4000){
      if(S.event||(S.pending&&S.pending.length)){const A=ENVL.legal();if(!A.length)break;ENVL.step(A[Math.floor(R()*A.length)]);settleEv();continue;}
      // shop: a few random buys / places / sells / rerolls / trains, then fight
      // a crude but alive shopper (o.mix 0 = pure random): field what fits, buy, sometimes train / reroll / sell
      let k=0;while(k++<16){const L=ENVL.legal(),by=t=>L.filter(a=>a.t===t);
        const pl=by('place').filter(a=>a.slot[0]!=='n'),b=by('buy'),tr=by('train'),rr=by('reroll'),sl=by('sell');
        const any=L.filter(a=>a.t!=='fight'&&a.t!=='lock'&&(a.t!=='place'||a.slot[0]!=='n'));
        let a=null;const x=R();
        if(R()<(o.mix==null?.15:o.mix))a=any.length&&R()<.8?any[Math.floor(R()*any.length)]:null;
        else if(pl.length&&fielded().length<boardSize())a=pl[Math.floor(R()*pl.length)];
        else if(b.length&&x<.6)a=b[Math.floor(R()*b.length)];
        else if(tr.length&&x<.7)a=tr[0];else if(rr.length&&x<.78)a=rr[0];else if(sl.length&&x<.8&&S.units.length>boardSize())a=sl[Math.floor(R()*sl.length)];
        if(!a)break;ENVL.step(a);if(S.event||(S.pending&&S.pending.length))break;}
      if(S.event||(S.pending&&S.pending.length))continue;
      if(!fielded().length&&S.units.length)S.units[0].slot='f1';
      if(o.quitAt&&S.round>=o.quitAt){tlEnd(true);break;}
      startBattle(false);let g=0;while(!B.done&&g++<40000)step(DT);
      FR=null;delete S.inFight;const res=settle();
      if(S.over)lvRecord();else advanceAfterFight(res);settleEv();}
    globalThis.__tlForce=false;const out=globalThis.__tlOut||[];globalThis.__tlOut=[];return out[out.length-1]||null;}
  return {facts,fight,live};})();`;

// the step environment's action list (env.js), reused for event / pending / shop choices in live() above
const ENVL = String.raw`globalThis.ENVL=(function(){const E=globalThis.ENV;return {legal:()=>E.legal(),step:a=>E.step(a)};})();`;

class Replayer {
  constructor(build) {
    const { TropebrawlEnv } = require('./env');
    // env.js puts its ENV object (legal moves, codes) into the context; the replayer page goes on top of it
    this.env = new TropebrawlEnv({ build: path.resolve(build) });
    this.eng = this.env.eng;
    this.eng.ev(ENVL); this.eng.ev(PAGE);
    this.RP = this.eng.ctx.RP;
    this.facts = this.RP.facts();
    this.version = this.facts.version;
  }
  fight(f, lv) { return this.RP.fight(f, lv | 0); }
  live(seed, lv, opts) { const r = this.RP.live(seed | 0, lv | 0, opts || null); return r ? JSON.parse(JSON.stringify(r)) : null; }
}
module.exports = { Replayer };
