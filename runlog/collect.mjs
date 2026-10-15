// Collects playtest runs from the relay topic into this folder (run from a checkout of the `runlog` branch).
// The topic is public and anonymous, so everything read here is untrusted input: strict header format, ids checked
// against a pattern, gzip output capped, records must look like a run, nothing is executed.
//   TOPIC=tropebrawl-runs-... node collect.mjs            (FEED=file.json to read a saved feed instead, for tests)
import fs from 'fs'; import zlib from 'zlib'; import path from 'path';
const TOPIC = process.env.TOPIC || ''; if (!/^[a-z0-9-]{20,64}$/.test(TOPIC)) throw new Error('bad TOPIC');
const st = fs.existsSync('state.json') ? JSON.parse(fs.readFileSync('state.json', 'utf8')) : {};
const since = /^[A-Za-z0-9]{6,20}$/.test(st.last || '') ? st.last : 'all';
const txt = process.env.FEED ? fs.readFileSync(process.env.FEED, 'utf8')
  : await (await fetch(`https://ntfy.sh/${TOPIC}/json?poll=1&since=${since}`)).text();
const msgs = txt.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
  .filter(m => m && m.event === 'message' && typeof m.message === 'string' && m.message.length < 4100);
const pend = st.pend || {}; let saved = 0, bad = 0;
const HEAD = /^TB1\|([a-z0-9]{4,24})\|([of]\d{1,3})\|(\d{1,2})\|(\d{1,2})\|([gj])\|/;
const score = x => (x.res && x.res !== 'open' ? 1000 : 0) + (Array.isArray(x.r) ? x.r.length : 0);
for (const m of msgs) {
  const h = HEAD.exec(m.message); if (!h) { bad++; continue; }
  const [head, rid, seq, i, n, enc] = h; if (+n < 1 || +n > 40 || +i >= +n) { bad++; continue; }
  const key = rid + '|' + seq; const p = pend[key] = pend[key] || { n: +n, enc, parts: {}, t: m.time };
  p.parts[i] = m.message.slice(head.length);
  if (Object.keys(p.parts).length < p.n) continue;
  const data = Array.from({ length: p.n }, (_, k) => p.parts[k] || '').join(''); delete pend[key];
  let rec;
  try { rec = JSON.parse(enc === 'g' ? zlib.gunzipSync(Buffer.from(data, 'base64'), { maxOutputLength: 2e6 }).toString('utf8') : data); }
  catch (e) { bad++; continue; }
  if (!rec || typeof rec !== 'object' || rec.rid !== rid || !Array.isArray(rec.r) || rec.r.length > 60) { bad++; continue; }
  const pid = /^p_[a-z0-9]{1,12}$/.test(rec.pid) ? rec.pid : 'p_unknown';
  const dir = path.join('runs', pid); fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, rid + '.json');
  if (fs.existsSync(f)) { try { if (score(JSON.parse(fs.readFileSync(f, 'utf8'))) > score(rec)) continue; } catch (e) {} }
  rec.recv = new Date(m.time * 1000).toISOString(); fs.writeFileSync(f, JSON.stringify(rec)); saved++;
}
const now = Date.now() / 1000; for (const k of Object.keys(pend)) if (now - pend[k].t > 86400) delete pend[k];
if (msgs.length) st.last = msgs[msgs.length - 1].id;
st.pend = pend; st.checked = new Date().toISOString(); fs.writeFileSync('state.json', JSON.stringify(st, null, 1));
console.log(`messages ${msgs.length}, runs saved ${saved}, rejected ${bad}, chunks waiting ${Object.keys(pend).length}`);
