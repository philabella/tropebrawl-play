// Tropebrawl as a step-by-step environment (AI roadmap Phase 0): every bot (search, learned policies, imitation of
// human runs) drives the real game through the same small interface, in Node, no browser.
//
//   const { TropebrawlEnv } = require('./env');
//   const env = new TropebrawlEnv({ build: 'tropebrawl.html', lv: 10 });
//   let obs = env.reset(seed);
//   while (!env.done) { const acts = env.legal(); const r = env.step(acts[k]); }   // r = { obs, reward, done, info }
//   const snap = env.snapshot(); ... env.restore(snap);                         // branch and come back (search)
//   env.encode() -> Float32Array: a fixed-length view of the decision state (for learned policies)
//   env.log -> the decision log, one entry per action, in the run-log codes (shared with human runs, see below)
//
// Actions: {t:'buy',i} {t:'sell',uid} {t:'reroll'} {t:'train'} {t:'lock'} {t:'place',uid,slot} {t:'fight'}
//          {t:'event',k} {t:'sub',v} {t:'pend',v}      (v null = skip / take the gold)
// Log codes: the game's own run-log codes b:id:level s:id:level r t e:key c:choice l:legendary i:item, plus
//            q (lock), p:id:slot (place) and f:win|loss (fight). Human runs log the same codes (no placements yet).
// Events, item and Legendary picks offer exactly what the game's screens offer (picks are cached on the pending
// entry like the UI does, so asking for legal moves never draws extra random numbers).
'use strict';
const path = require('path');
const { Engine } = require('./engine');

const PAGE = String.raw`globalThis.ENV=(function(){
  const STUB=['render','save','closeSheet','toast','showPending','drawBattle','shake','sheet','sfx'];
  STUB.forEach(n=>{if(typeof globalThis[n]==='function')globalThis[n]=function(){};});
  let LOG=[];
  const HIDS=HEROES.map(h=>h[0]),HIX=Object.fromEntries(HIDS.map((id,i)=>[id,i])),GK=Object.keys(GENRES),IK=Object.keys(TRINKETS),LK=Object.keys(LEGENDS);
  const FK=Object.values(ENEMIES).map(r=>r[0]),FIX=Object.fromEntries(FK.map((k,i)=>[k,i]));
  function phase(){if(!S||S.over)return 'over';if(S.event){const e=S.event;if(!e.picked)return 'event';if(e.sub&&!e.subDone)return 'sub';return 'eventDone';}
    if(S.pending&&S.pending.length)return 'pend';return 'shop';}
  function itemOpts(ids){const out=[];(ids||[]).forEach(t=>{if(!TR[t])return;if(S.trinkets.includes(t)||S.trinkets.length<TRINKET_CAP)out.push(t);else S.trinkets.forEach(o=>out.push(t+'>'+o));});return out;}
  function pendChoices(p){if(p.kind==='legend'){if(!p.choices){p.choices=legendChoices(p.win?3:2);p.rare=p.win?(trinketChoices(3,true)[0]||null):null;}
      return p.choices.concat(p.rare?['t:'+p.rare]:[]);}
    if(!p.choices||p.choices.some(t=>!TR[t]||ilv(t)>=ITEM_MAX))p.choices=trinketChoices(p.level,false);return itemOpts(p.choices);}
  function legal(){const ph=phase(),A=[];
    if(ph==='event'){const e=S.event;e.opts.forEach(k=>{if(k!=='deal'||dealOK(e))A.push({t:'event',k});});return A;}
    if(ph==='sub'){const e=S.event,sb=e.sub;
      if(sb.kind==='choice'){CHOICES[e.picked].filter(c=>c.ok(e)).forEach(c=>A.push({t:'sub',v:c.id}));return A;}
      if(sb.kind==='cut'){sb.ids.forEach(g=>{A.push({t:'sub',v:g});if(S.gold>=cutCost(g))A.push({t:'sub',v:g+'+'});});if(S.lives>TUNE.cutFight)A.push({t:'sub',v:'fight'});return A;}
      if(sb.kind==='trinket'){itemOpts(sb.ids).forEach(v=>{if(!sb.price||S.gold>=sb.price)A.push({t:'sub',v});});A.push({t:'sub',v:null});return A;}
      (sb.ids||[]).forEach(v=>A.push({t:'sub',v}));A.push({t:'sub',v:null});return A;}
    if(ph==='pend'){pendChoices(S.pending[0]).forEach(v=>A.push({t:'pend',v}));A.push({t:'pend',v:null});return A;}
    if(ph!=='shop')return A;
    S.shop.forEach((o,i)=>{if(o&&canBuy(i).ok)A.push({t:'buy',i});});
    S.units.forEach(u=>A.push({t:'sell',uid:u.uid}));
    if((S.freeRerolls||0)>0||S.gold>=rerollCost())A.push({t:'reroll'});
    const tc=trainCost();if(tc!=null&&S.gold>=tc)A.push({t:'train'});
    A.push({t:'lock'});
    const cap=boardSize();
    S.units.forEach(u=>{const w=twoSlot(u.id)?2:1,onField=u.slot[0]!=='n';
      fieldSlots.concat(benchSlots).forEach(sl=>{if(sl===u.slot)return;const toField=sl[0]!=='n';
        if(toField&&!onField&&fieldCount()+w>cap)return;
        const was=u.slot;u.slot='x';const ok=slotOK(sl,u.id);u.slot=was;if(ok)A.push({t:'place',uid:u.uid,slot:sl});});});
    A.push({t:'fight'});return A;}
  function code(a,u){switch(a.t){case 'buy':{const o=S.shop[a.i];return 'b:'+o.id+':'+o.level;}case 'sell':return 's:'+u.id+':'+u.level;case 'reroll':return 'r';case 'train':return 't';
    case 'lock':return 'q';case 'place':return 'p:'+u.id+':'+a.slot;case 'event':return 'e:'+a.k;case 'sub':return 'c:'+(a.v||'-');
    case 'pend':return (S.pending[0].kind==='legend'?'l:':'i:')+(a.v||'-');}return a.t;}
  function settleEvents(){let g=0;while(phase()==='eventDone'&&g++<5)finishEvent();}
  function doStep(a){let info={};const u=a.uid!=null?S.units.find(x=>x.uid===a.uid):null;const c=a.t==='fight'?null:code(a,u);
    if(a.t==='buy')buy(a.i);else if(a.t==='sell')sell(a.uid);else if(a.t==='reroll')reroll();else if(a.t==='train')train();else if(a.t==='lock')S.locked=!S.locked;
    else if(a.t==='place'){if(u)u.slot=a.slot;}
    else if(a.t==='event')eventPick(a.k);else if(a.t==='sub')eventSub(a.v);else if(a.t==='pend')resolvePending(a.v);
    else if(a.t==='fight'){if(!fielded().length&&S.units.length)S.units[0].slot='f1';startBattle(true);let g=0;while(!B.done&&g++<30000)step(DT);
      const res=settle();info={win:!!res.win,boss:!!res.boss,round:S.round};advanceAfterFight(res);LOG.push({r:info.round,a:'f:'+(info.win?'win':'loss')});}
    if(c)LOG.push({r:S.round,a:c});
    settleEvents();return info;}
  function obs(){return {phase:phase(),round:S.round,act:(curRound()||{}).act||0,gold:S.gold,lives:S.lives,rank:S.rank,xp:S.xp||0,locked:!!S.locked,
    shop:S.shop.map(o=>o?{id:o.id,level:o.level}:null),units:S.units.map(u=>({uid:u.uid,id:u.id,level:u.level,slot:u.slot})),
    trinkets:S.trinkets.map(t=>t+':'+ilv(t)),legend:S.legend||null,event:S.event?{opts:S.event.opts,picked:S.event.picked||null,sub:S.event.sub?S.event.sub.kind:null}:null,
    pending:(S.pending||[]).map(p=>p.kind),enemy:S.enemy?(S.enemy.enc||[]).map(x=>x.key||x.id):null,over:!!S.over,result:S.result||null};}
  // fixed-length decision-state vector: scalars, shop / board / bench by character (level-weighted), genres, items, Legendary, next enemy
  const F=12+HIDS.length*3+GK.length+IK.length+LK.length+FK.length+1;
  function encode(){const x=new Float32Array(F);let o=0;const cr=curRound()||{};
    [S.round/36,(cr.act||0)/4,S.gold/50,S.lives/10,S.rank/9,(S.xp||0)/20,S.locked?1:0,(S.freeRerolls||0)/3,boardSize()/9,fielded().length/9,benched().length/5,cr.type==='boss'?1:0].forEach(v=>x[o++]=v);
    S.shop.forEach(sh=>{if(sh&&HIX[sh.id]!=null)x[o+HIX[sh.id]]+=sh.level;});o+=HIDS.length;
    S.units.forEach(u=>{if(HIX[u.id]!=null)x[o+(u.slot[0]==='n'?HIDS.length:0)+HIX[u.id]]+=u.level;});o+=HIDS.length*2;
    const cnt={};fielded().forEach(u=>{const g=HERO[u.id].genre;cnt[g]=(cnt[g]||0)+1;});GK.forEach((g,i)=>x[o+i]=(cnt[g]||0)/6);o+=GK.length;
    IK.forEach((t,i)=>x[o+i]=ilv(t)/3);o+=IK.length;if(S.legend&&LK.indexOf(S.legend)>=0)x[o+LK.indexOf(S.legend)]=1;o+=LK.length;
    ((S.enemy&&S.enemy.enc)||[]).forEach(e=>{x[o+(FIX[e.key]!=null?FIX[e.key]:FK.length)]+=1;});return x;}
  function reset(seed,lv){seeded=true;rngState=seed|0;__seedMath(__hseed('math',seed|0));UI.lv=lv|0;LOG=[];newRun(false);settleEvents();return obs();}
  function snap(){return JSON.stringify({S,rngState,seeded,math:__mathState(),lv:UI.lv,LOG});}
  function load(s){const o=JSON.parse(s);S=o.S;rngState=o.rngState;seeded=o.seeded;__seedMath(o.math);UI.lv=o.lv;B=null;LOG=o.LOG;}
  return {phase,legal,step:doStep,obs,encode,reset,snap,load,F,get log(){return LOG;}};})();`;

class TropebrawlEnv {
  constructor({ build, lv = 10, tune } = {}) {
    this.eng = new Engine({ build: path.resolve(build || path.join(__dirname, '../tropebrawl.html')), tune });
    this.eng.ev(PAGE); this.lv = lv; this.done = true; this.F = this.eng.ev('ENV.F');
    this.E = this.eng.ctx.ENV;
  }
  reset(seed) { const o = this.E.reset(seed, this.lv); this.done = o.over; return o; }
  legal() { return this.E.legal(); }
  step(a) {
    const info = this.E.step(a); const obs = this.E.obs(); this.done = obs.over;
    return { obs, reward: this.done ? (obs.result === 'win' ? 1 : 0) : 0, done: this.done, info };
  }
  obs() { return this.E.obs(); }
  encode() { return this.E.encode(); }
  snapshot() { return this.E.snap(); }
  restore(s) { this.E.load(s); this.done = this.E.obs().over; }
  get log() { return this.E.log; }
}
module.exports = { TropebrawlEnv };
