import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
const T = JSON.parse(readFileSync('tickets_final.json','utf8'));
function sel(l){
  const spec=l.spec||''; const num=s=>String(s).split(':').pop();
  const key=`${l.sportId}_${l.event}_${l.mkt}${spec?'?'+spec:''}_${l.oid}`;
  const baseTopic=`${num(l.sportId)}^${num(l.catId)}^${l.tourId}^${l.event}`;
  return { home:l.home, away:l.away, gameId:l.gameId, eventId:l.event, estimateStartTime:l.start, sportId:l.sportId, sportName:l.sport.toLowerCase(),
    categoryId:l.catId, categoryName:l.cat, tournamentId:l.tourId, tournamentName:l.tour,
    outcomeInfo:{id:l.oid, odds:l.odds.toFixed(2), probability:String(l.p), voidProbability:'0E-10', isActive:1, desc:l.pick, showOdds:true, statusDesc:''},
    marketInfo:{id:`${l.mkt}${spec?'?'+spec:''}`, ...(spec?{specifier:spec}:{}), product:l.product??3, desc:l.mdesc, status:0, marketId:l.mkt},
    topic:`${baseTopic}^~^${l.mkt}^${spec||'~'}`, baseTopic, key, isFinish:false, isInterrupted:false };
}
const snip={}, built={};
for (const [tag,t] of Object.entries(T)) {
  const sels=t.legs.slice().sort((a,b)=>a.start-b.start).map(sel); const keys=sels.map(s=>s.key); built[tag]=[sels,keys];
  snip[tag]=`localStorage.setItem('betslips',${JSON.stringify(JSON.stringify(sels))});localStorage.setItem('betslipsSelections',${JSON.stringify(JSON.stringify({single:keys,multiple:keys,system:keys,simbet:[]}))});location.reload();`;
}
writeFileSync('snippets.json', JSON.stringify(snip));
console.log('snippet sizes:', Object.entries(snip).map(([k,v])=>k+'='+v.length).join(' '));
if (process.argv[2]==='check') {
  const { chromium } = createRequire(import.meta.url)('/opt/node-tools/node_modules/playwright');
  const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
  const browser = await chromium.launch({ headless:true, proxy:{server:process.env.HTTPS_PROXY}, timeout:40000 });
  const res={};
  await Promise.all(Object.entries(built).map(async ([tag,[sels,keys]]) => {
    const ctx=await browser.newContext({userAgent:UA,viewport:{width:1500,height:1300}}); const page=await ctx.newPage();
    try {
      await page.goto('https://www.sportybet.com/ng/',{waitUntil:'domcontentloaded',timeout:60000}); await page.waitForTimeout(4000);
      await page.evaluate(code=>{ const f=code.replace('location.reload();',''); (0,eval)(f); }, snip[tag]);
      await page.reload({waitUntil:'domcontentloaded'}); await page.waitForTimeout(12000);
      for (const el of await page.$$('input')) { const ph=(await el.getAttribute('placeholder'))||''; if (await el.isVisible() && /min\. 10/.test(ph)) { await el.click(); await el.fill('500'); break; } }
      await page.waitForTimeout(3500);
      const panel=await page.evaluate(()=>{const all=[...document.querySelectorAll('div')].filter(d=>/Total Stake/.test(d.innerText||'')&&/Potential Win/.test(d.innerText||''));all.sort((a,b)=>a.innerText.length-b.innerText.length);return all[0]?all[0].innerText.split('\n').map(s=>s.trim()).filter(Boolean).join(' | '):'NO PANEL';});
      const n=await page.evaluate(()=>JSON.parse(localStorage.getItem('betslips')||'[]').length);
      res[tag]={n,expected:sels.length,panel:panel.slice(-150)};
    } catch(e){ res[tag]={error:e.message.split('\n')[0]}; }
    await ctx.close();
  }));
  await browser.close();
  for (const tag of Object.keys(res)) console.log(tag, JSON.stringify(res[tag]), '| model payout', Math.round(T[tag].payout).toLocaleString());
}
