// Posts one small test run to the relay in the game's exact format, so a manual run of the workflow proves the whole
// path (relay reachable, chunk header, gzip, collector) end to end. Saved under runs/p_selftest/.
import zlib from 'zlib';
const TOPIC = process.env.TOPIC; const rid = 'st' + Date.now().toString(36);
const rec = { rid, v: 'selftest', lv: 0, at: new Date().toISOString(), r: [{ n: 1, p: 0, g: 5, lf: 10, rk: 1, a: ['b:riot:1'], f: { b: ['riot:1:f1'], n: [], g: 4, rk: 1, it: [], lg: null, en: 'test', w: 1 } }],
  res: 'win', round: 1, lives: 10, ms: 1000, end: new Date().toISOString(), pid: 'p_selftest', src: 'selftest' };
const data = zlib.gzipSync(Buffer.from(JSON.stringify(rec))).toString('base64');
const r = await fetch(`https://ntfy.sh/${TOPIC}`, { method: 'POST', body: `TB1|${rid}|f1|0|1|g|` + data });
console.log('posted test run', rid, 'status', r.status);
// the developer's Google Form (private Sheet backup): one row, same JSON the game sends
if (process.env.FORM_URL && process.env.FORM_FIELD) {
  const body = new URLSearchParams(); body.set(process.env.FORM_FIELD, JSON.stringify(rec));
  const f = await fetch(process.env.FORM_URL, { method: 'POST', body });
  console.log('posted test run to the form, status', f.status);
}
await new Promise(res => setTimeout(res, 3000));
