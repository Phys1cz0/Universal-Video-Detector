/* UVD ad-filter evidence engine. Only supported network-filter syntax is used as evidence. */
const UVD_FILTER_DB='uvdFilterListsDb';
const UVD_FILTER_STORE='lists';
const UVD_FILTER_META_KEY='uvdAdFilterMeta';
const UVD_FILTER_SCHEMA=1;
const UVD_FILTER_SOURCES=[
 {id:'easylist',name:'EasyList',url:'https://ublockorigin.github.io/uAssets/thirdparties/easylist.txt',home:'https://easylist.to/',license:'EasyList license: CC BY-SA 3.0 / GPL',role:'ad'},
 {id:'easyprivacy',name:'EasyPrivacy',url:'https://ublockorigin.github.io/uAssets/thirdparties/easyprivacy.txt',home:'https://easylist.to/',license:'EasyPrivacy license: CC BY-SA 3.0 / GPL',role:'privacy'},
 {id:'ublock-filters',name:'uBlock filters',url:'https://ublockorigin.github.io/uAssets/filters/filters.min.txt',home:'https://github.com/uBlockOrigin/uAssets',license:'uAssets license: GPL-3.0',role:'ad'}
];
const UVD_FILTER_DEFAULTS={enabled:true,strength:'medium',autoUpdate:true};
let uvdFilterMemory=new Map();
let uvdFilterMeta={};
let uvdFilterInitialized=false;
let uvdFilterUpdatePromise=null;

function uvdFilterNormalizeSettings(s){
 const x=s&&typeof s==='object'?s:{};
 return {enabled:x.adFilterEnabled!==false,strength:['weak','medium','strong'].includes(x.adFilterStrength)?x.adFilterStrength:'medium',autoUpdate:x.adFilterAutoUpdate!==false};
}
function uvdFilterDb(){return new Promise((resolve,reject)=>{const r=indexedDB.open(UVD_FILTER_DB,UVD_FILTER_SCHEMA);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains(UVD_FILTER_STORE))r.result.createObjectStore(UVD_FILTER_STORE,{keyPath:'id'});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error||new Error('Filter database open failed.'));});}
async function uvdFilterDbGet(id){const db=await uvdFilterDb();return new Promise((resolve,reject)=>{const tx=db.transaction(UVD_FILTER_STORE,'readonly');const r=tx.objectStore(UVD_FILTER_STORE).get(id);r.onsuccess=()=>resolve(r.result||null);r.onerror=()=>reject(r.error||new Error('Filter database read failed.'));});}
async function uvdFilterDbPut(value){const db=await uvdFilterDb();return new Promise((resolve,reject)=>{const tx=db.transaction(UVD_FILTER_STORE,'readwrite');tx.objectStore(UVD_FILTER_STORE).put(value);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error||new Error('Filter database write failed.'));});}
async function uvdFilterLoadMeta(){try{const r=await browser.storage.local.get(UVD_FILTER_META_KEY);uvdFilterMeta=r[UVD_FILTER_META_KEY]&&typeof r[UVD_FILTER_META_KEY]==='object'?r[UVD_FILTER_META_KEY]:{};}catch{uvdFilterMeta={};}}
async function uvdFilterSaveMeta(){await browser.storage.local.set({[UVD_FILTER_META_KEY]:uvdFilterMeta});}
function uvdFilterHeader(text,name){const get=(re)=>{const m=String(text||'').match(re);return m?String(m[1]).trim():''};return {title:get(/^!\s*Title:\s*(.+)$/im)||name,expires:get(/^!\s*Expires:\s*(\d+)\s*days?/im),lastModified:get(/^!\s*Last modified:\s*(.+)$/im),license:get(/^!\s*License:\s*(.+)$/im)};}
function uvdFilterDomainMatches(host,domains,negDomains){if(!domains.length&&!negDomains.length)return true;const h=String(host||'').toLowerCase().replace(/^www\./,'');if(negDomains.some(d=>h===d||h.endsWith('.'+d)))return false;if(!domains.length)return true;return domains.some(d=>h===d||h.endsWith('.'+d));}
function uvdFilterEscapeRegex(s){return String(s).replace(/[\\^$+?.()|[\]{}]/g,'\\$&');}
function uvdFilterPatternToRegex(pattern){let p=String(pattern||'').trim();if(!p)return null;let source='';for(let i=0;i<p.length;i++){const c=p[i];if(c==='*'){source+='.*';continue}if(c==='^'){source+='(?:[^A-Za-z0-9._%-]|$)';continue}if(c==='|'){if(i===0){source+='^';continue}if(i===p.length-1){source+='$';continue}source+='\\|';continue}source+=uvdFilterEscapeRegex(c);}try{return new RegExp(source,'i')}catch{return null}}
function uvdFilterParseLine(line,sourceId,lineNumber=0){
 let s=String(line||'').trim();if(!s||s.startsWith('!')||s.startsWith('[')||s.includes('##')||s.includes('#@#')||s.includes('#?#')||s.includes('##+js(')||s.startsWith('@@'))return null;
 let options='';const dollar=s.indexOf('$');if(dollar>=0){options=s.slice(dollar+1);s=s.slice(0,dollar)}
 if(!s||s.includes('#'))return null;
 let regex=null,hostAnchored=false,hostPattern='';
 if(s.length>2&&s.startsWith('/')&&s.endsWith('/')){try{regex=new RegExp(s.slice(1,-1),'i')}catch{return null}}
 const domainPos=options.split(',').map(x=>x.trim()).filter(Boolean);
 const domains=[],negDomains=[];let mediaOnly=false,unsupported=false,hasPositiveType=false;
 for(const op of domainPos){if(op==='media'){mediaOnly=true;hasPositiveType=true;continue}if(['script','image','stylesheet','font','object','object-subrequest','subdocument','document','xmlhttprequest','websocket','ping','csp','popup','popunder','generichide','elemhide','specifichide','inline-script','inline-font','redirect','removeparam','badfilter','important','3p','1p','3p-frame','1p-script'].includes(op)){if(['script','image','stylesheet','font','object','object-subrequest','subdocument','document','websocket','ping','csp','popup','popunder','inline-script','inline-font','generichide','elemhide','specifichide','redirect','removeparam'].includes(op))hasPositiveType=true;continue}if(op.startsWith('domain=')){for(const d of op.slice(7).split('|')){const x=d.trim().toLowerCase();if(x) x.startsWith('~')?negDomains.push(x.slice(1)):domains.push(x)}}else if(op.startsWith('denyallow=')){/* domain restriction unsupported for evidence; ignore the whole rule */unsupported=true}}
 if(unsupported||hasPositiveType&&!mediaOnly)return null;
 if(/^https?:\/\//i.test(s))hostAnchored=true;
 if(s.startsWith('||')){s=s.slice(2);hostAnchored=true;hostPattern=s.split(/[\/^]/,1)[0].toLowerCase()}
 else if(s.startsWith('|'))s=s.slice(1);
 if(s.endsWith('|'))s=s.slice(0,-1);
 if(!s)return null;
 if(!regex)regex=uvdFilterPatternToRegex(s);
 if(!regex)return null;
 return {sourceId,pattern:s,regex,domains,negDomains,mediaOnly,hostAnchored,hostPattern,lineNumber};
}
function uvdFilterCompile(sourceId,text){const rules=[];const lines=String(text||'').split(/\r?\n/);for(let i=0;i<lines.length;i++){const r=uvdFilterParseLine(lines[i],sourceId,i+1);if(r)rules.push(r)}return rules;}
function uvdFilterSerializeRules(rules){return rules.map(r=>({sourceId:r.sourceId,pattern:r.pattern,domains:r.domains,negDomains:r.negDomains,mediaOnly:r.mediaOnly,hostAnchored:r.hostAnchored,hostPattern:r.hostPattern||'',lineNumber:r.lineNumber||0}));}
function uvdFilterHydrateRules(raw){return (Array.isArray(raw)?raw:[]).map(r=>{const x=uvdFilterParseLine((r.hostAnchored?'||':'')+String(r.pattern||'')+(r.mediaOnly?'$media':''),String(r.sourceId||''));if(!x)return null; x.domains=Array.isArray(r.domains)?r.domains:[];x.negDomains=Array.isArray(r.negDomains)?r.negDomains:[];x.mediaOnly=!!r.mediaOnly;x.hostAnchored=!!r.hostAnchored;return x}).filter(Boolean)}
function uvdFilterRuleKey(r){return `${r.sourceId}|${r.pattern}|${r.mediaOnly?'m':''}|${r.domains.join('|')}|${r.negDomains.join('|')}`}
async function uvdFilterLoadAll(){uvdFilterMemory.clear();for(const src of UVD_FILTER_SOURCES){try{const rec=await uvdFilterDbGet(src.id);if(rec?.rules){const rules=uvdFilterHydrateRules(rec.rules);uvdFilterMemory.set(src.id,rules);if(!uvdFilterMeta[src.id])uvdFilterMeta[src.id]={id:src.id,name:src.name,status:'never_fetched',sourceUrl:src.url,homeUrl:src.home,license:src.license};}}catch(e){console.error('UVD filter load failed',src.id,e)}}await uvdFilterSaveMeta();}
function uvdFilterDue(src){const m=uvdFilterMeta[src.id]||{};if(!m.lastSuccessfulFetch)return true;const expires=Math.max(1,Number(m.expiresDays)||7);return Date.now()-Number(m.lastSuccessfulFetch)>expires*86400000;}
async function uvdFilterFetchOne(src){
 const old=await uvdFilterDbGet(src.id);const meta=uvdFilterMeta[src.id]||{id:src.id,name:src.name,status:'never_fetched',sourceUrl:src.url,homeUrl:src.home,license:src.license};
 const headers={};if(meta.etag)headers['If-None-Match']=meta.etag;if(meta.lastModifiedHttp)headers['If-Modified-Since']=meta.lastModifiedHttp;
 meta.status='updating';meta.failureReason='';uvdFilterMeta[src.id]=meta;await uvdFilterSaveMeta();
 try{
  const res=await fetch(src.url,{cache:'no-store',headers});
  if(res.status===304&&old?.rules){meta.status='ok';meta.lastSuccessfulFetch=meta.lastSuccessfulFetch||Date.now();meta.lastChecked=Date.now();await uvdFilterSaveMeta();return {ok:true,changed:false,sourceId:src.id};}
  if(!res.ok)throw new Error(`HTTP ${res.status}`);
  const text=await res.text();if(text.length<32)throw new Error('Filter list is unexpectedly short.');
  const parsed=uvdFilterCompile(src.id,text);if(!parsed.length)throw new Error('No supported network rules were parsed.');
  const header=uvdFilterHeader(text,src.name);const rawRules=uvdFilterSerializeRules(parsed);
  await uvdFilterDbPut({id:src.id,sourceId:src.id,rawText:text,rules:rawRules,updatedAt:Date.now(),contentHash:uvdFilterHash(text)});
  meta.status='ok';meta.lastSuccessfulFetch=Date.now();meta.lastChecked=Date.now();meta.lastModified=header.lastModified;meta.expiresDays=Math.max(1,Number(header.expires)||7);meta.etag=res.headers.get('ETag')||meta.etag||'';meta.lastModifiedHttp=res.headers.get('Last-Modified')||meta.lastModifiedHttp||'';meta.updateIdentifier=meta.etag||meta.lastModifiedHttp||meta.contentHash;meta.contentHash=uvdFilterHash(text);meta.ruleCount=parsed.length;meta.title=header.title||src.name;meta.license=src.license;meta.sourceUrl=src.url;meta.homeUrl=src.home;meta.failureReason='';
  uvdFilterMeta[src.id]=meta;await uvdFilterSaveMeta();uvdFilterMemory.set(src.id,parsed);return {ok:true,changed:true,sourceId:src.id};
 }catch(e){meta.status='failed';meta.lastChecked=Date.now();meta.failureReason=e?.message||String(e);meta.sourceUrl=src.url;meta.homeUrl=src.home;meta.license=src.license;uvdFilterMeta[src.id]=meta;await uvdFilterSaveMeta();if(old?.rules&&!uvdFilterMemory.has(src.id))uvdFilterMemory.set(src.id,uvdFilterHydrateRules(old.rules));console.error('UVD filter update failed',src.id,e);return {ok:false,sourceId:src.id,error:meta.failureReason};}
}
function uvdFilterHash(text){let h=2166136261;const s=String(text||'');for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return (h>>>0).toString(16).padStart(8,'0')}
async function updateAdFilterLists(force=false){if(uvdFilterUpdatePromise)return uvdFilterUpdatePromise;uvdFilterUpdatePromise=(async()=>{const results=[];for(const src of UVD_FILTER_SOURCES){if(force||uvdFilterDue(src))results.push(await uvdFilterFetchOne(src));else results.push({ok:true,changed:false,sourceId:src.id,skipped:true})}return results;})().finally(()=>{uvdFilterUpdatePromise=null});return uvdFilterUpdatePromise;}
function uvdFilterMatchRule(rule,url,ctx){try{const host=String(ctx.host||new URL(url).hostname).toLowerCase();if(!uvdFilterDomainMatches(host,rule.domains,rule.negDomains))return false;if(rule.mediaOnly&&!ctx.isMedia)return false;if(rule.hostAnchored&&rule.hostPattern){if(!(host===rule.hostPattern||host.endsWith('.'+rule.hostPattern)))return false}return rule.regex.test(url)}catch{return false}}
function classifyAdFilterItem(item){
 const url=String(item?.mediaUrl||'').trim();if(!url)return {confidence:'NORMAL',evidence:[]};
 const ctx={isMedia:true,host:(()=>{try{return new URL(url).hostname.toLowerCase()}catch{return ''}})()};const evidence=[];
 for(const src of UVD_FILTER_SOURCES){const rules=uvdFilterMemory.get(src.id)||[];let match=null;for(const rule of rules){if(uvdFilterMatchRule(rule,url,ctx)){match=rule;break}}if(match)evidence.push({listId:src.id,listName:src.name,ruleType:match.mediaOnly?'media':'network',rule:match.pattern,lineNumber:match.lineNumber||0,role:src.role});}
 const easy=!!evidence.find(e=>e.listId==='easylist'),ub=!!evidence.find(e=>e.listId==='ublock-filters'),privacy=!!evidence.find(e=>e.listId==='easyprivacy');let confidence='NORMAL';
 if(easy&&ub)confidence='HIGH';else if(easy||ub)confidence='MEDIUM';else if(privacy)confidence='LOW';
 return {confidence,evidence,checkedAt:Date.now()};
}
async function reclassifyAdFiltersForState(state){if(!state?.items)return false;let changed=false;for(const [k,item] of state.items){const before=JSON.stringify(item.adFilter||{});const next=classifyAdFilterItem(item);item.adFilter=next;state.items.set(k,item);if(before!==JSON.stringify(next))changed=true;}return changed;}
async function reclassifyAllAdFilters(){let changedTabs=[];for(const [tid,st] of tabs){if(await reclassifyAdFiltersForState(st)){st.lastChange=Date.now();persistDetected(tid);changedTabs.push(tid);}}for(const tid of changedTabs)browser.runtime.sendMessage({type:'detectedUpdate',tabId:tid,adFilterChanged:true}).catch(()=>{});return changedTabs;}
async function reclassifyAllAdFiltersIfNeeded(force=false){let changedTabs=[];for(const [tid,st] of tabs){let needs=force;for(const item of st.items.values()){if(!item?.adFilter?.checkedAt){needs=true;break}}if(needs&&await reclassifyAdFiltersForState(st)){st.lastChange=Date.now();persistDetected(tid);changedTabs.push(tid)}}for(const tid of changedTabs)browser.runtime.sendMessage({type:'detectedUpdate',tabId:tid,adFilterChanged:true}).catch(()=>{});return changedTabs;}
function adFilterDisplayAllowed(item,settings){const s=uvdFilterNormalizeSettings(settings);if(!s.enabled)return true;const c=String(item?.adFilter?.confidence||'NORMAL');if(s.strength==='weak')return c!=='HIGH';if(s.strength==='medium')return c!=='HIGH'&&c!=='MEDIUM';if(s.strength==='strong')return c==='NORMAL';return true;}
function getAdFilterStatus(){return {schema:UVD_FILTER_SCHEMA,sources:UVD_FILTER_SOURCES.map(src=>({...src,...(uvdFilterMeta[src.id]||{status:'never_fetched'})})),loaded:[...uvdFilterMemory.entries()].map(([id,r])=>({id,count:r.length}))};}
async function initializeAdFilter(){if(uvdFilterInitialized)return;uvdFilterInitialized=true;await uvdFilterLoadMeta();await uvdFilterLoadAll();}
