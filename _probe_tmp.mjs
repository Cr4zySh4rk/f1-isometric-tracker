import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
const _ls=new Map();
globalThis.localStorage={getItem:k=>_ls.has(k)?_ls.get(k):null,setItem:(k,v)=>_ls.set(k,String(v)),removeItem:k=>_ls.delete(k),clear:()=>_ls.clear()};
globalThis.__OF1_QUEUE_OPTS={perSec:1000,perMin:60000};
const CACHE='/tmp/of1cache'; fs.mkdirSync(CACHE,{recursive:true});
const realFetch=globalThis.fetch; const nt=[];
async function thr(){for(;;){const n=Date.now();while(nt.length&&n-nt[0]>60000)nt.shift();const ls=nt.filter(t=>n-t<1000).length;if(nt.length<30&&ls<3){nt.push(n);return;}await new Promise(r=>setTimeout(r,150));}}
globalThis.fetch=async(u,o)=>{const k=crypto.createHash('sha1').update(String(u)).digest('hex');const f=path.join(CACHE,k+'.json');const m=f+'.status';if(fs.existsSync(f)){const b=fs.readFileSync(f,'utf8');const s=fs.existsSync(m)?parseInt(fs.readFileSync(m,'utf8'),10):200;return new Response(b,{status:s});}await thr();const res=await realFetch(u,o);const t=await res.text();if(res.status===200||res.status===404){fs.writeFileSync(f,t);fs.writeFileSync(m,String(res.status));}return new Response(t,{status:res.status});};
const { SessionStore }=await import('./src/data/sessionStore.js');
const { buildTrack }=await import('./src/track/trackBuilder.js');
const { ProviderManager }=await import('./src/data/providers/manager.js');
const { OpenF1Provider }=await import('./src/data/providers/openf1Provider.js');
const { JolpicaProvider }=await import('./src/data/providers/jolpicaProvider.js');
const providers=new ProviderManager({primary:new OpenF1Provider(),fallback:new JolpicaProvider()});
const sess=await providers.getSessions({year:2026});
for(const key of [11326,11315,11334]){
  const s=sess.find(x=>x.session_key===key);
  if(!s){console.log(key,'NOT FOUND');continue;}
  const store=new SessionStore(s,providers); await store.load();
  const track=await buildTrack(store,providers);
  const lenM=track.meta.totalLen/track.meta.scale;
  const scRows=(store.raceControl||[]).filter(m=>/safety car/i.test(m.message||''));
  console.log(`key=${key} circuit="${s.circuit_short_name}" drivers=${store.drivers.length} synthetic=${!!track.meta.synthetic} totalLen=${track.meta.totalLen.toFixed(1)} scale=${track.meta.scale.toExponential(3)} derivedLenM=${lenM.toFixed(0)} scMsgs=${scRows.length} firstSC="${scRows[0]?.message||''}"@${scRows[0]?.date||''}`);
}
