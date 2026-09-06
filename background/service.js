const tabs = new Map();
const scanJobs = new Map();
const downloads = new Map();
const DETECTED_STORE='uvdDetectedVideosByPageIdentity';
const LEGACY_DETECTED_STORE='uvdDetectedVideosByPage';
const detectedPersistQueues=new Map();
const rawCandidatesByTab=new Map();
const uiProcessingReadyTabs=new Set();
const siteItems=new Map();
const siteAliases=new Map();
let coAppStateRevision=0;
let coAppStateJobs=[];
const UVD_VERSION='0.6.22';
const STORAGE_SCHEMA_VERSION=6;
// Runtime copy of detection tuning used by passive Network listeners without reading storage per request.
let runtimeDetectionTuning=UVDDetectionTuning.normalize({});

const DEFAULT_SETTINGS_SCHEMA={mode:'auto',dynamicWait:150,dynamicScrollAttempts:2,maxSeconds:15,restorePosition:true,downloadRoot:'',companionPath:'',ffmpegPath:'',folderNaming:'site_title',parallelDownloads:3,duplicateFileMode:'exist',notifyComplete:true,previewMode:'image',theme:'system',windowSize:'medium',textSize:'medium',adFilterEnabled:false,adFilterStrength:'medium',adFilterAutoUpdate:true,siteAccessMode:'all',whitelistSites:[],blacklistSites:[],sidebarFixed:false,...UVDDetectionTuning.DEFAULTS};
function migrateSettingsObject(value){
  // Normalize all persisted settings through the shared safe detection schema.
  const source=value&&typeof value==='object'?value:{};
  const out={...DEFAULT_SETTINGS_SCHEMA,...source};
  out.parallelDownloads=Math.max(1,Math.min(99,Number(out.parallelDownloads)||3));
  out.adFilterEnabled=source.adFilterEnabled === true;
  out.siteAccessMode=source.siteAccessMode==='whitelist'||source.siteAccessMode==='blacklist'?source.siteAccessMode:'all';
  out.whitelistSites=UVDDetectionTuning.normalizeSiteList(source.whitelistSites);out.blacklistSites=UVDDetectionTuning.normalizeSiteList(source.blacklistSites);out.sidebarFixed=out.sidebarFixed===true;out.adFilterStrength=['weak','medium','strong'].includes(out.adFilterStrength)?out.adFilterStrength:'medium';out.adFilterAutoUpdate=out.adFilterAutoUpdate!==false;
  out.dynamicWait=Math.max(0,Math.min(1500,Number(out.dynamicWait)||150));out.dynamicScrollAttempts=Math.max(2,Math.min(10,Number(out.dynamicScrollAttempts)||2));out.maxSeconds=Math.max(5,Math.min(300,Number(out.maxSeconds)||15));
  out.restorePosition=out.restorePosition!==false;out.notifyComplete=out.notifyComplete!==false;
  Object.assign(out,UVDDetectionTuning.normalize(out));
  runtimeDetectionTuning=UVDDetectionTuning.normalize(out);
  return out;
}

async function migrateStorageSchema(){
 try{
  const r=await browser.storage.local.get(['uvdStorageSchemaVersion','uvdSettingsPersisted','uvdSettings','uvdDetectedVideosBySite','uvdDetectedVideosByPage','uvdDetectedVideosByPageIdentity']);
  const version=Number(r.uvdStorageSchemaVersion||0);
  const settings=migrateSettingsObject(r.uvdSettingsPersisted||r.uvdSettings||{});
  if(version<STORAGE_SCHEMA_VERSION){
   const sourceSets=[r['uvdDetectedVideosBySite'],r['uvdDetectedVideosByPage'],r['uvdDetectedVideosByPageIdentity']];
   const migrated={...((r[DETECTED_STORE]&&typeof r[DETECTED_STORE]==='object')?r[DETECTED_STORE]:{})};
   for(const source of sourceSets){
    if(!source||typeof source!=='object')continue;
    for(const list of Object.values(source)){
     if(!Array.isArray(list))continue;
     for(const raw of list){
      const item=migrateDetectedItem(raw);if(!item)continue;
      const pk=pageStoreKey(item.pageIdentity,item.pageUrl||item.landingPage||'');if(!pk)continue;
      const bucket=Array.isArray(migrated[pk])?migrated[pk]:[];
      const holder={items:new Map(),aliases:new Map()};
      for(const x of bucket){const k=findExistingKey(holder,x)||videoKey(x);holder.items.set(k,x);holder.aliases.set(videoKey(x),k);}
      const k=findExistingKey(holder,item)||videoKey(item);const old=holder.items.get(k);holder.items.set(k,{...(old||{}),...item});
      migrated[pk]=[...holder.items.values()];
     }
    }
   }
   const updates={uvdStorageSchemaVersion:STORAGE_SCHEMA_VERSION,uvdSettingsPersisted:settings};
   if(Object.keys(migrated).length)updates[DETECTED_STORE]=migrated;
   await browser.storage.local.set(updates);
  } else if(!r.uvdSettingsPersisted) await browser.storage.local.set({uvdSettingsPersisted:settings});
 }catch(e){console.error('UVD storage migration failed',e)}
}
function tabState(tabId){if(!tabs.has(tabId))tabs.set(tabId,{items:new Map(),aliases:new Map(),siteKey:'',pageKey:'',pageIdentity:null,lastPageUrl:'',pendingNavigation:false,lastChange:0,persistTimer:0});return tabs.get(tabId)}
function queueRawCandidates(tabId,items){if(!Array.isArray(items)||!items.length)return 0;const q=rawCandidatesByTab.get(tabId)||[];const seen=new Set(q.map(x=>`${x?.id??''}|${assetKey(mediaUrlOf(x))}|${x?.type||''}`));for(const item of items){if(!mediaUrlOf(item))continue;const k=`${item?.id??''}|${assetKey(mediaUrlOf(item))}|${item?.type||''}`;if(seen.has(k))continue;seen.add(k);q.push(item)}rawCandidatesByTab.set(tabId,q);return q.length}
async function finalizeRawCandidates(tabId){const raw=rawCandidatesByTab.get(tabId)||[];if(!raw.length)return 0;uiProcessingReadyTabs.add(tabId);rawCandidatesByTab.delete(tabId);return await addBatch(tabId,raw)}
function siteStoreKey(u){try{const x=new URL(u);return `${x.origin}`.toLowerCase()}catch{return String(u||'').split(/[?#]/)[0].toLowerCase()}}
function pageStoreKey(pageIdentity,pageUrl){
 const p=pageIdentity&&typeof pageIdentity==='object'?pageIdentity:{};
 const vals=[p.structuredId,p.structuredIdentifier,p.microdataItemId].map(x=>String(x||'').trim()).filter(Boolean);
 if(vals.length)return 'pid:'+hashText(vals.join('|').toLowerCase());
 const structured=[p.structuredMainEntityOfPage,p.canonicalUrl,p.ogUrl].map(x=>String(x||'').trim()).filter(Boolean);
 if(structured.length>=2)return 'pmeta:'+hashText(structured.map(assetKey).sort().join('|').toLowerCase());
 const url=String(pageUrl||p.pageUrl||'').trim();
 const title=cleanText(p.pageTitle||'');
 if(url&&title)return 'weak-ptitle:'+hashText(pathOnly(url)+'|'+title);
 if(structured.length)return 'pmeta:'+hashText(structured.map(assetKey).sort().join('|').toLowerCase());
 return '';
}
function pathOnly(u){try{const x=new URL(u);x.hash='';x.search='';return `${x.origin}${x.pathname}`.replace(/\/{2,}/g,'/').toLowerCase()}catch{return String(u||'').split(/[?#]/)[0].toLowerCase()}}
function hashText(text){let h=2166136261;const s=String(text||'');for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return (h>>>0).toString(16).padStart(8,'0')}
function mediaUrlOf(item){return String(item?.mediaUrl||item?.url||'').trim()} // mediaUrl is canonical; url remains legacy input compatibility
function identityUrlOf(item){
  if(item?.identityUrl)return String(item.identityUrl);
  const u=mediaUrlOf(item); if(!u)return '';
  try{const x=new URL(u);x.hash='';for(const k of [...x.searchParams.keys()])if(/^(token|sig|signature|expires|exp|auth|key|timestamp|t|tag)$/i.test(k))x.searchParams.delete(k);return x.href}catch{return u.replace(/#.*$/,'')}
}
function unwrapUrlCandidates(value,depth=0,out=new Set()){
  if(depth>4||!value||typeof value!=='string')return out;
  let s=value.replace(/\\\//g,'/');
  for(let i=0;i<4;i++){try{const d=decodeURIComponent(s);if(d===s)break;s=d}catch{break}}
  const add=v=>{try{const u=new URL(v,location.href);if(/^https?:$/i.test(u.protocol))out.add(u.href)}catch{}};
  try{const u=new URL(s,location.href);for(const v of u.searchParams.values())if(/^https?:/i.test(v))unwrapUrlCandidates(v,depth+1,out);const hash=u.hash.replace(/^#/,'');for(const part of hash.split('&')){const eq=part.indexOf('=');if(eq>=0){const v=part.slice(eq+1);try{if(/^https?:/i.test(decodeURIComponent(v)))unwrapUrlCandidates(v,depth+1,out)}catch{}}}}catch{}
  for(const m of s.matchAll(/https?:\/\/[^\s"'<>\\\]}),]+/gi))add(m[0]);
  return out;
}
function isVideoMediaUrl(u){return !!u&&/(?:video\.twimg\.com|\.(?:mp4|webm|mov|m4v|m3u8|mpd)(?:[?#]|$))/i.test(u)}
function mediaType(u){return /\.m3u8(?:[?#]|$)/i.test(u)?'hls':/\.mpd(?:[?#]|$)/i.test(u)?'dash':'direct'}
function filenameFromMediaUrl(u){try{const x=new URL(String(u||''));let n='';for(const k of ['filename','file','name','download','downloadName']){const v=x.searchParams.get(k);if(v){try{n=decodeURIComponent(v)}catch{n=v}if(n.trim())break}}if(!n)n=decodeURIComponent((x.pathname||'').split('/').pop()||'').trim();n=n.replace(/^['\"]|['\"]$/g,'').trim();if(!n||n==='.'||n==='..'||n.length>240)return '';if(/^(?:playlist|master|index|manifest)(?:[-_.][^/]*)?\.(?:m3u8|mpd)$/i.test(n))return '';return n}catch{return ''}}
function isGeneratedVideoName(v){return /^(?:Video|HLS|DASH)(?:\s*[-_]\s*|\s+)(?:url_|video_|[0-9a-f]{8,}|\d+).*/i.test(String(v||'').trim()) || /^(direct|video|hls|dash)$/i.test(String(v||'').trim())}
function stableItemId(identityUrl,id){
  const u=String(identityUrl||'').trim();
  const tw=u.match(/video\.twimg\.com\/(?:ext_tw_video|amplify_video)\/(\d+)/i);if(tw)return `twimg_${tw[1]}`;
  // Never derive the primary identity from a generic `id` alone. Some sites
  // reuse the same page/card id for multiple videos. The media identity URL
  // is the stable fallback; explicit itemId supplied by the detector is kept.
  if(u){let h=2166136261;for(let i=0;i<u.length;i++){h^=u.charCodeAt(i);h=Math.imul(h,16777619)}return `url_${(h>>>0).toString(16).padStart(8,'0')}`;}
  if(id!=null&&String(id).trim())return `id:${String(id).trim()}`;
  return `url_unknown`;
}
function buildDetectedItem(item){
  const raw=mediaUrlOf(item);if(!raw)return null;
  const candidates=unwrapUrlCandidates(raw);candidates.add(raw);let mediaUrl=null;
  for(const u of candidates){if(isVideoMediaUrl(u)){mediaUrl=u;break}}
  // A detected item may legitimately use a signed/proxied/extensionless media URL.
  // Do not silently drop such an item merely because the URL does not expose a
  // conventional video extension. The detector already classified it; CoApp is
  // responsible for the actual download method.
  if(!mediaUrl){
    const declared=String(item?.type||'').toLowerCase();
    if(/^https?:\/\//i.test(raw) && ['direct','mp4','webm','mov','m4v','hls','dash','video'].includes(declared)) mediaUrl=raw;
  }
  if(!mediaUrl)return null;
  const identityUrl=identityUrlOf({mediaUrl});
  let suppliedFilename=String(item?.filename||'').trim();
  if(/^(?:playlist|master|index|manifest)(?:[-_.][^/]*)?\.(?:m3u8|mpd)$/i.test(suppliedFilename))suppliedFilename='';
  const derivedFilename=suppliedFilename || filenameFromMediaUrl(mediaUrl);
  const inheritedPageTitle=String(item?.pageTitle||item?.pageIdentity?.pageTitle||'').trim();const out={...item,pageTitle:inheritedPageTitle,itemId:item?.itemId||stableItemId(identityUrl,item?.id),mediaUrl,identityUrl,filename:derivedFilename,videoIdentity:item?.videoIdentity||{mediaUrl:identityUrl,path:pathKey(identityUrl),filename:derivedFilename,thumbnail:item?.thumbnail||'',pageItemIdentity:String(item?.pageItemIdentity||'')},type:(String(item?.type||'').toLowerCase()==='hls'||String(item?.type||'').toLowerCase()==='dash')?String(item.type).toLowerCase():mediaType(mediaUrl),originUrl:item?.originUrl||item?.pageUrl||item?.landingPage||''};delete out.url;
  if(out.pageItemIdentity){out.videoIdentity={...(out.videoIdentity||{}),pageItemIdentity:String(out.pageItemIdentity)};}
  if(!out.name||isGeneratedVideoName(out.name)||/^(?:playlist|master|index|manifest)(?:[-_.][^/]*)?\.(?:m3u8|mpd)$/i.test(String(out.name).trim())){const tw=identityUrl.match(/video\.twimg\.com\/(?:ext_tw_video|amplify_video)\/(\d+)/i);out.name=inheritedPageTitle || derivedFilename || (tw?`Video - ${tw[1]}`:`Video - ${out.itemId}`);}
  return out;
}
function persistDetected(tabId){try{const st=tabState(tabId);if(!st.pageKey)return;const siteKey=st.pageKey;clearTimeout(st.persistTimer);st.persistTimer=setTimeout(()=>{const previous=detectedPersistQueues.get(siteKey)||Promise.resolve();const snapshot=[...st.items.values()].map(migrateDetectedItem).filter(Boolean);const next=previous.catch(()=>{}).then(async()=>{const r=await browser.storage.local.get(DETECTED_STORE);const all=r[DETECTED_STORE]||{};const stored=Array.isArray(all[siteKey])?all[siteKey]:[];const merged=new Map();for(const x of stored){const m=migrateDetectedItem(x);if(m)merged.set(videoKey(m),m)}for(const x of snapshot){const k=findExistingKey({items:merged,aliases:new Map()},x)||videoKey(x);const old=merged.get(k);merged.set(k,{...(old||{}),...x})}all[siteKey]=[...merged.values()];await browser.storage.local.set({[DETECTED_STORE]:all})});detectedPersistQueues.set(siteKey,next.finally(()=>{if(detectedPersistQueues.get(siteKey)===next)detectedPersistQueues.delete(siteKey)}))},180)}catch{}}
function migrateDetectedItem(item){return buildDetectedItem(item)}
async function hydrateDetected(tabId,pageUrl,pageIdentity){
 const st=tabState(tabId);
 const pi=pageIdentity&&typeof pageIdentity==='object'?pageIdentity:{};
 let sk=pageStoreKey(pi,pageUrl||'');
 const currentUrl=String(pageUrl||pi.pageUrl||'');
 // Popup reopening can occur before the content script has supplied page identity.
 // In that case do not invent a new page identity; recover an existing persisted
 // bucket only when one of its stored items has the exact current page URL.
 let preloaded=null;
 if(!sk&&currentUrl){
  try{
   const r=await browser.storage.local.get([DETECTED_STORE]);
   const all=r[DETECTED_STORE]&&typeof r[DETECTED_STORE]==='object'?r[DETECTED_STORE]:{};
   const matches=[];
   for(const [candidateKey,list] of Object.entries(all)){
    if(!Array.isArray(list))continue;
    const exact=list.some(x=>assetKey(String(x?.pageUrl||x?.landingPage||''))===assetKey(currentUrl));
    if(exact)matches.push([candidateKey,list]);
   }
   if(matches.length===1){sk=matches[0][0];preloaded=matches[0][1];}
  }catch{}
 }
 if(!sk)return st;
 if(st.pageKey===sk&&st.lastPageUrl===currentUrl)return st;
 st.pageKey=sk;st.siteKey=siteStoreKey(currentUrl);st.pageIdentity=pi;st.lastPageUrl=currentUrl;st.pendingNavigation=false;
 st.items=siteItems.get(sk)||new Map();st.aliases=siteAliases.get(sk)||new Map();siteItems.set(sk,st.items);siteAliases.set(sk,st.aliases);
 try{
  const r=await browser.storage.local.get([DETECTED_STORE,LEGACY_DETECTED_STORE]);
  const all=r[DETECTED_STORE]||{};let arr=Array.isArray(all[sk])?all[sk]:(Array.isArray(preloaded)?preloaded:[]);
  if(!arr.length){
   const legacySite=r['uvdDetectedVideosBySite']||{};
   const legacyPage=r['uvdDetectedVideosByPage']||{};
   const legacyEntries=Object.entries(legacySite).filter(([k])=>siteStoreKey(k)===st.siteKey||k.startsWith(st.siteKey+'/'));
   for(const [,list] of legacyEntries)if(Array.isArray(list))for(const x of list){
    const xk=pageStoreKey(x?.pageIdentity,x?.pageUrl||x?.landingPage||'');
    if(xk===sk)arr.push(x);
   }
   for(const [,list] of Object.entries(legacyPage))if(Array.isArray(list))for(const x of list){
    const xk=pageStoreKey(x?.pageIdentity,x?.pageUrl||x?.landingPage||'');
    if(xk===sk)arr.push(x);
   }
  }
  for(const x of arr){
   const xk=pageStoreKey(x?.pageIdentity,x?.pageUrl||x?.landingPage||'');
   if(xk===sk)addToState(st,x);
  }
  if(arr.length)persistDetected(tabId);
 }catch{}
 return st;
}
function addToState(st,item){const incoming=buildDetectedItem(item);if(!incoming)return false;let k=findExistingKey(st,incoming);if(!k)k=videoKey(incoming);const old=st.items.get(k);const m={...(old||{}),...incoming,firstSeen:old?.firstSeen||Date.now(),lastSeen:Date.now()};if(old){m.name=mergeText(old.name,incoming.name);if(/^(?:playlist|master|index|manifest)(?:[-_.][^\/\s]*)?\.(?:m3u8|mpd)$/i.test(String(m.name||''))){const pt=String(incoming.pageTitle||incoming.pageIdentity?.pageTitle||'').trim();if(pt)m.name=pt;}for(const f of ['filename','thumbnail','fileSize','duration','id','landingPage','pageTitle','originUrl','pageIdentity','videoIdentity'])if(!m[f]&&old[f])m[f]=old[f];const oldTrusted=String(old.source||'')==='twiigle-ranking-item';const incomingTrusted=String(incoming.source||'')==='twiigle-ranking-item';if(oldTrusted&&!incomingTrusted&&old.ranking){m.ranking=old.ranking;m.pageItemIdentity=old.pageItemIdentity||m.pageItemIdentity;} }if(old && String(incoming.source||'').startsWith('twiigle') && String(old.source||'').startsWith('twiigle')){
 const ir=Number(String(incoming.ranking||'').match(/\d+/)?.[0]||0),or=Number(String(old.ranking||'').match(/\d+/)?.[0]||0);
 if(ir&&(!or||ir<or)){m.ranking=incoming.ranking;m.pageItemIdentity=incoming.pageItemIdentity;m.name=incoming.name;}
 else if(or){m.ranking=old.ranking;m.pageItemIdentity=old.pageItemIdentity;m.name=old.name;}
}
if(incoming.type==='hls'){m.qualities=Array.isArray(old?.qualities)?[...old.qualities]:[];const q=qualityFromUrl(incoming.mediaUrl);if(q&&!m.qualities.some(x=>assetKey(x.mediaUrl||x.url)===assetKey(incoming.mediaUrl)))m.qualities.push({height:q,mediaUrl:incoming.mediaUrl});if(!q)m.masterUrl=incoming.mediaUrl;if(old?.type==='hls'){const oq=qualityFromUrl(old.mediaUrl);if(oq===0&&q>0)m.mediaUrl=old.mediaUrl;else if(oq>0&&q>oq)m.mediaUrl=incoming.mediaUrl}}if(m.masterUrl)m.mediaUrl=m.masterUrl;m.identityUrl=identityUrlOf(m);m.itemId=String(m.itemId||'').trim()||stableItemId(m.identityUrl,m.id);if(m.qualities?.length)m.qualities.sort((a,b)=>b.height-a.height);m.adFilter=classifyAdFilterItem(m);st.items.set(k,m);st.aliases.set(videoKey(incoming),k);if(incoming.id!=null&&!st.aliases.has(`id:${String(incoming.id)}`))st.aliases.set(`id:${String(incoming.id)}`,k);const uuid=extractUuid(incoming.mediaUrl);if(uuid)st.aliases.set(`uuid:${uuid}`,k);st.lastChange=Date.now();return true}
function normalize(u){try{const x=new URL(u);x.hash='';return x.href}catch{return String(u||'')}}
function assetKey(u){try{const x=new URL(u);x.hash='';for(const k of [...x.searchParams.keys()])if(/^(token|sig|signature|expires|exp|auth|timestamp)$/i.test(k))x.searchParams.delete(k);const pairs=[...x.searchParams.entries()].sort((a,b)=>a[0].localeCompare(b[0])||a[1].localeCompare(b[1]));x.search='';for(const [k,v] of pairs)x.searchParams.append(k,v);return x.href}catch{return String(u||'')}}
function pathKey(u){try{const x=new URL(u);return `${x.origin}${x.pathname}`.replace(/\/{2,}/g,'/').toLowerCase()}catch{return String(u||'').split(/[?#]/)[0].toLowerCase()}}
function extractUuid(u){const m=String(u||'').match(/([0-9a-f]{8}-[0-9a-f-]{20,})/i);return m?m[1].toLowerCase():null}
function cleanText(s){return String(s||'').replace(/\s+/g,' ').trim().toLowerCase()}
function videoKey(i){
 const vi=i?.videoIdentity||{};const idu=identityUrlOf(i),u=extractUuid(idu);
 // itemId/stableId values produced from a media URL are not sufficient to
 // distinguish an HLS/DASH rendition from the same video's other renditions.
 // Keep explicit site-level IDs useful, but prefer canonical media identity
 // for the primary key so URL variants can be corroborated and merged later.
 const explicit=String(vi.stableId||'').trim();const item=String(i?.itemId||'').trim();const canonical=assetKey(String(vi.mediaUrl||idu||'')).toLowerCase();
 if(u)return `uuid:${u}`;
 if(canonical)return `media:${hashText(canonical)}`;
 if(explicit)return `item:${hashText(explicit)}`;
 if(item)return `item:${hashText(item)}`;
 return `media:${hashText(idu||'unknown')}`;
}
function videoEvidenceScore(a,b){
 if(!a||!b)return 0;
 const av=a.videoIdentity||{},bv=b.videoIdentity||{};
 const pageItemA=String(av.pageItemIdentity||a.pageItemIdentity||'').trim();
 const pageItemB=String(bv.pageItemIdentity||b.pageItemIdentity||'').trim();
 if(pageItemA&&pageItemB&&cleanText(pageItemA)!==cleanText(pageItemB))return 0;
 const samePageItem=!!pageItemA&&!!pageItemB&&cleanText(pageItemA)===cleanText(pageItemB);
 const eq=(k)=>{const x=String(av[k]||'').trim(),y=String(bv[k]||'').trim();return !!x&&!!y&&assetKey(x)===assetKey(y)};
 const thumb=eq('thumbnail'), file=eq('filename');
 const dur=Number(a.duration)||0, durB=Number(b.duration)||0;
 const sameDuration=dur>0&&durB>0&&Math.abs(dur-durB)<0.75;
 const sameType=String(a.type||'').toLowerCase()===String(b.type||'').toLowerCase();
 // Different media URLs can be the same video when a site exposes multiple
 // HLS/DASH renditions. Never merge on page identity alone: require at least
 // two independent video-level signals.
 if(samePageItem && thumb && (sameDuration||file))return 92;
 if(samePageItem && file && sameDuration)return 90;
 if(samePageItem && thumb && sameType && (a.thumbnail||b.thumbnail))return 88;
 if(thumb && file && sameDuration)return 86;
 if(thumb && sameDuration && sameType)return 85;
 if(file && sameDuration && sameType)return 84;
 return 0;
}
function qualityFromUrl(u){const m=String(u||'').match(/\/(\d{3,4})p(?:\/|$)/i);return m?Number(m[1]):0}
function pageIdentityScore(a,b){
 const ai=a?.pageIdentity||{},bi=b?.pageIdentity||{};
 for(const k of ['structuredId','structuredIdentifier','microdataItemId']){
  const x=String(ai[k]||'').trim(),y=String(bi[k]||'').trim();
  if(x&&y&&cleanText(x)===cleanText(y))return 100;
 }
 let score=0,matched=0;
 for(const k of ['structuredMainEntityOfPage','canonicalUrl','ogUrl']){
  const x=String(ai[k]||'').trim(),y=String(bi[k]||'').trim();
  if(!x||!y)continue;
  matched++;
  if(assetKey(x)===assetKey(y))score+=k==='structuredMainEntityOfPage'?55:(k==='canonicalUrl'?45:40);
 }
 return matched>=2&&score>=70?score:0;
}
function identityScore(a,b){
 if(!a||!b)return 0;
 const av=a.videoIdentity||{},bv=b.videoIdentity||{};
 const pageA=String(av.pageItemIdentity||a.pageItemIdentity||'').trim(),pageB=String(bv.pageItemIdentity||b.pageItemIdentity||'').trim();
 if(pageA&&pageB&&cleanText(pageA)!==cleanText(pageB))return 0;
 const stableA=String(av.stableId||'').trim(),stableB=String(bv.stableId||'').trim();
 if(stableA&&stableB&&stableA===stableB)return 100;
 const uuidA=String(av.uuid||extractUuid(identityUrlOf(a))||'').trim(),uuidB=String(bv.uuid||extractUuid(identityUrlOf(b))||'').trim();
 if(uuidA&&uuidB&&uuidA.toLowerCase()===uuidB.toLowerCase())return 96;
 const mediaEqual=assetKey(mediaUrlOf(a))&&assetKey(mediaUrlOf(a))===assetKey(mediaUrlOf(b));
 if(mediaEqual)return 95;
 return videoEvidenceScore(a,b);
}

function findExistingKey(st,item){
 const n=videoKey(item);
 if(st.items.has(n))return n;
 if(st.aliases.has(n))return st.aliases.get(n);
 let best=null,bs=0;
 for(const[k,o]of st.items){const sc=identityScore(o,item);if(sc>bs){bs=sc;best=k}}
 return bs>=84?best:null;
}
function mergeText(o,n){o=String(o||'').trim();n=String(n||'').trim();if(!n)return o;if(!o)return n;if(/^(?:playlist|master|index|manifest)(?:[-_.][^\/\s]*)?\.(?:m3u8|mpd)$/i.test(o))return n;if(/^No\.\d+(?:\s*\-\s*.+)?$/i.test(n)&&!/^No\.\d+(?:\s*\-\s*.+)?$/i.test(o))return n;if(/^(video|hls|dash)(\s+video|\s*動画)?$/i.test(o))return n;if(/^(video|hls|dash)(\s+video|\s*動画)?$/i.test(n))return o;if(/^Video\s*\-\s*url_[0-9a-f]+$/i.test(o)&&/\.(?:mp4|webm|mov|m4v)$/i.test(n))return n;return o}
function itemSignature(i){if(!i)return '';const q=Array.isArray(i.qualities)?i.qualities.map(x=>({height:x?.height||0,mediaUrl:assetKey(x?.mediaUrl||x?.url||'')})).sort((a,b)=>a.height-b.height):[];return JSON.stringify({itemId:i.itemId||'',identityUrl:assetKey(identityUrlOf(i)),mediaUrl:assetKey(mediaUrlOf(i)),type:i.type||'',id:i.id==null?'':String(i.id),pageItemIdentity:i.pageItemIdentity||i.videoIdentity?.pageItemIdentity||'',name:i.name||'',filename:i.filename||'',thumbnail:assetKey(i.thumbnail||''),duration:i.duration||0,landingPage:assetKey(i.landingPage||''),pageTitle:i.pageTitle||'',masterUrl:assetKey(i.masterUrl||''),qualities:q,adConfidence:i.adFilter?.confidence||'NORMAL'})}

function enrichByMetadata(tabId,meta){if(!meta||(!meta.name&&!meta.thumbnail))return;const st=tabState(tabId),t=meta.thumbnail?assetKey(meta.thumbnail):'';for(const[k,i]of st.items){if(t&&i.thumbnail&&assetKey(i.thumbnail)===t){if(meta.name)i.name=mergeText(i.name,meta.name);i.lastSeen=Date.now();st.items.set(k,i)}}st.lastChange=Date.now()}
function markDetected(tabId){const j=scanJobs.get(tabId);if(!j||j.kind!=='active')return;j.lastChange=Date.now();clearTimeout(j.quietTimer);if(!j.hold)j.quietTimer=setTimeout(()=>finishScan(tabId),2200)}
function beginScan(tabId,hold=false){let j=scanJobs.get(tabId);if(!j)j={};Object.assign(j,{started:Date.now(),lastChange:Date.now(),done:false,hold:!!hold,kind:'active'});clearTimeout(j.quietTimer);clearTimeout(j.maxTimer);if(!j.hold)j.quietTimer=setTimeout(()=>finishScan(tabId),3000);j.maxTimer=setTimeout(()=>finishScan(tabId),45000);scanJobs.set(tabId,j)}
function finishScan(tabId){const j=scanJobs.get(tabId);if(!j||j.hold)return;clearTimeout(j.quietTimer);clearTimeout(j.maxTimer);j.done=true;j.finished=Date.now();browser.runtime.sendMessage({type:'scanFinished',tabId,finished:j.finished}).catch(()=>{});setTimeout(()=>{if(scanJobs.get(tabId)===j)scanJobs.delete(tabId)},30000)}
function scanState(tabId){const j=scanJobs.get(tabId);return j&&j.kind==='active'?{busy:!j.done,started:j.started,finished:j.finished||null}:{busy:false}}
function historyKey(item){return `${videoKey(item)}|${assetKey(mediaUrlOf(item))}`}
async function loadHistory(){try{const r=await browser.storage.local.get('uvdDownloadHistory');return r.uvdDownloadHistory||{}}catch{return{}}}
async function saveHistory(h){await browser.storage.local.set({uvdDownloadHistory:h})}
// Native Messaging has no AbortSignal support. Bound each request so a dead or
// stuck CoApp cannot leave the UI indefinitely waiting for a response.
const NATIVE_MESSAGE_TIMEOUT_MS=5000;
async function sendCompanion(message){
  try{
    const responsePromise=browser.runtime.sendNativeMessage('universal_video_detector_companion',message);
    const timeoutPromise=new Promise(resolve=>setTimeout(()=>resolve({ok:false,companionError:true,error:'Native Messaging応答がタイムアウトしました。'}),NATIVE_MESSAGE_TIMEOUT_MS));
    const r=await Promise.race([responsePromise,timeoutPromise]);
    return r&&typeof r==='object'?{...r,companionError:!!r.companionError}:{ok:false,companionError:true,error:'Native Messagingから有効な応答を受け取れませんでした。'};
  }catch(e){
    const msg=e&&e.message?e.message:String(e);
    return{ok:false,companionError:true,error:msg};
  }
}
async function openNative(action,payload){return sendCompanion({action,...payload})}
function siteInfoFromItem(item){try{const u=new URL(item?.landingPage||item?.pageUrl||mediaUrlOf(item)||'');return{host:u.hostname||'unknown-site',origin:u.origin,title:item?.pageTitle||''}}catch{return{host:'unknown-site',origin:'',title:item?.pageTitle||''}}}
async function getDownloadSettings(){try{const r=await browser.storage.local.get('uvdSettingsPersisted');if(r.uvdSettingsPersisted&&typeof r.uvdSettingsPersisted==='object')return r.uvdSettingsPersisted;const sr=await browser.storage.sync.get('uvdSettingsPersisted');return sr.uvdSettingsPersisted&&typeof sr.uvdSettingsPersisted==='object'?sr.uvdSettingsPersisted:{}}catch{return{}}}
const requestHeadersByUrl=new Map();
const cookieCacheByOrigin=new Map();
const MAX_REQUEST_HEADERS=256;
function shouldRememberHeaders(url){const u=String(url||'');return /(?:video\.twimg\.com|\.(?:m3u8|mpd|mp4|webm|mov|m4v)(?:[?#]|$)|(?:^|\/)api(?:\/|$)|graphql|\.json(?:[?#]|$))/i.test(u);}
function rememberHeaders(url,headers){if(!shouldRememberHeaders(url)||!Array.isArray(headers))return;const keep={};for(const h of headers){if(!h?.name)continue;if(/^(referer|origin|user-agent|authorization|cookie)$/i.test(h.name))keep[h.name]=h.value||''}if(Object.keys(keep).length){const key=assetKey(url);requestHeadersByUrl.set(key,{headers:keep,at:Date.now()});if(requestHeadersByUrl.size>MAX_REQUEST_HEADERS){const first=requestHeadersByUrl.keys().next().value;if(first)requestHeadersByUrl.delete(first);}}}
async function cookiesFor(url){try{if(!url||!/^https?:/i.test(url))return '';const u=new URL(url);const key=u.origin.toLowerCase();const cached=cookieCacheByOrigin.get(key);if(cached&&Date.now()-cached.at<30000)return cached.value;const cs=await browser.cookies.getAll({url});const value=cs.map(c=>`${c.name}=${c.value}`).join('; ');cookieCacheByOrigin.set(key,{value,at:Date.now()});return value}catch{return ''}}
async function enrichDetectedItem(item){
 if(!mediaUrlOf(item))return item;
 const x={...item};
 const pageUrl=x.pageUrl||x.landingPage||'';
 x.pageUrl=pageUrl;
 x.referer=x.referer||pageUrl;
 x.userAgent=x.userAgent||navigator.userAgent;
 const h=requestHeadersByUrl.get(assetKey(mediaUrlOf(x)));
 if(h&&Date.now()-h.at<120000)x.headers={...(x.headers||{}),...h.headers};
 if(!x.cookie)x.cookie=await cookiesFor(x.pageUrl||mediaUrlOf(x));
 return x;
}
async function add(tabId,item,notify=true){if(!mediaUrlOf(item))return false;const st=tabState(tabId);const t=await browser.tabs.get(tabId).catch(()=>null);const currentUrl=String(t?.url||'');const pageUrl=item?.pageUrl||item?.landingPage||currentUrl||'';if(currentUrl&&pageUrl&&assetKey(currentUrl)!==assetKey(pageUrl))return false;const pageIdentity=item?.pageIdentity&&typeof item.pageIdentity==='object'?item.pageIdentity:{pageUrl,pageTitle:item?.pageTitle||''};const pkey=pageStoreKey(pageIdentity,pageUrl);if(pkey&&st.pageKey!==pkey)await hydrateDetected(tabId,pageUrl,item?.pageIdentity&&typeof item.pageIdentity==='object'?item.pageIdentity:null);if(!st.pageKey){st.siteKey=siteStoreKey(pageUrl);st.lastPageUrl=pageUrl}const enriched=await enrichDetectedItem(item);const had=findExistingKey(st,enriched);const beforeItem=had?itemSignature(st.items.get(had)):'';const ok=addToState(st,enriched);const afterKey=findExistingKey(st,enriched);const afterItem=afterKey?itemSignature(st.items.get(afterKey)):'';const changed=!had||beforeItem!==afterItem;if(ok&&changed){persistDetected(tabId);markDetected(tabId);if(notify)browser.runtime.sendMessage({type:'detectedUpdate',tabId,item:enriched}).catch(()=>{})}return changed}
async function addBatch(tabId,items){
 if(!Array.isArray(items)||!items.length)return 0;
 let changed=0;
 for(let i=0;i<items.length;i++){
  const item=items[i]; if(!mediaUrlOf(item))continue;
  const enriched=await enrichDetectedItem(item);
  const t=await browser.tabs.get(tabId).catch(()=>null);
  const currentUrl=String(t?.url||'');
  const pageUrl=enriched?.pageUrl||enriched?.landingPage||currentUrl||'';
  if(currentUrl&&pageUrl&&assetKey(currentUrl)!==assetKey(pageUrl))continue;
  const pageInfo=enriched?.pageIdentity&&typeof enriched.pageIdentity==='object' ? {...enriched.pageIdentity} : {};
  if(!pageInfo.pageUrl)pageInfo.pageUrl=pageUrl;
  if(!pageInfo.pageTitle && enriched?.pageTitle)pageInfo.pageTitle=enriched.pageTitle;
  const pkey=pageStoreKey(pageInfo,pageUrl);
  if(!pkey)continue;
  enriched.pageIdentity=pageInfo;
  const st=tabState(tabId); if(st.pageKey!==pkey)await hydrateDetected(tabId,pageUrl,pageInfo);
  const active=tabState(tabId); const had=findExistingKey(active,enriched);
  const beforeItem=had?itemSignature(active.items.get(had)):'';
  addToState(active,enriched); const afterKey=findExistingKey(active,enriched);
  const afterItem=afterKey?itemSignature(active.items.get(afterKey)):'';
  if(!had||beforeItem!==afterItem)changed++;
  if((i+1)%40===0)await new Promise(r=>setTimeout(r,0));
 }
 if(changed){persistDetected(tabId);markDetected(tabId);browser.runtime.sendMessage({type:'detectedUpdate',tabId,count:changed}).catch(()=>{});}
 return changed;
}
function prepareDownloadItems(items,pageUrl,userAgent){return (items||[]).map(x=>{const normalized=buildDetectedItem(x);if(!normalized)return null;const item={...normalized};item.pageUrl=item.pageUrl||pageUrl||'';item.referer=item.referer||pageUrl||'';item.userAgent=item.userAgent||userAgent||navigator.userAgent;return item}).filter(Boolean)}
async function doDownload(msg){
 const cfg=msg.settings||await getDownloadSettings();
 if(!cfg.downloadRoot)return{ok:false,needsSettings:true,results:[]};
 const rawItems=Array.isArray(msg.items)?msg.items:((msg.item&&typeof msg.item==='object')?[msg.item]:[]); const items=rawItems.map(x=>buildDetectedItem(x)).filter(Boolean);
 if(!items.length)return{ok:false,error:'No download items were supplied.'};
 // Firefox only forwards the request. CoApp is the sole authority for duplicate
 // checks, job creation, status transitions and completion.
 return sendCompanion({action:'download',rootDirectory:cfg.downloadRoot,site:msg.site||siteInfoFromItem(items[0]),ffmpegPath:cfg.ffmpegPath||'',folderNaming:cfg.folderNaming||'site_title',duplicateFileMode:cfg.duplicateFileMode||'exist',parallelDownloads:Math.max(1,Math.min(99,Number(cfg.parallelDownloads)||3)),items,batchId:msg.batchId||''});
}
async function queueOrAddPassiveCandidate(tabId,item){
  // Network listeners are passive too: before the UI gate they only feed rawCandidates.
  if(runtimeDetectionTuning.networkDetection===false)return;
  if(!uiProcessingReadyTabs.has(tabId)){ queueRawCandidates(tabId,[item]); return; }
  await add(tabId,item);
}
function classifyWebRequestUrl(url) {
  // URL-based Network candidate classification; no response body is read here.
  const lowerUrl = String(url || '').toLowerCase();
  if (/\.m3u8(?:[?#]|$)/i.test(lowerUrl)) return 'hls';
  if (/\.mpd(?:[?#]|$)/i.test(lowerUrl)) return 'dash';
  if (/\.(?:mp4|webm|mov|m4v)(?:[?#]|$)/i.test(lowerUrl)) return 'direct';
  return null;
}

function classifyResponseContentType(headers) {
  // Content-Type is a second passive Network signal for extensionless media URLs.
  let contentType = '';
  for (const header of headers || []) {
    if (String(header.name || '').toLowerCase() === 'content-type') {
      contentType = String(header.value || '');
      break;
    }
  }
  const value = contentType.toLowerCase().split(';', 1)[0].trim();
  if (value === 'application/vnd.apple.mpegurl' || value === 'application/x-mpegurl' || value === 'audio/mpegurl') return 'hls';
  if (value === 'application/dash+xml') return 'dash';
  if (value === 'video/mp4' || value === 'video/webm' || value === 'video/quicktime' || value === 'video/x-m4v') return 'direct';
  return null;
}

async function passiveSiteAllowed(tabId, url){
  if(tabId==null||tabId<0)return false;
  const cfg=await getDownloadSettings();
  return UVDDetectionTuning.isSiteAllowed(url,cfg);
}

browser.webRequest.onBeforeRequest.addListener(details => {
  // WebRequest remains passive and obeys the UI/rawCandidates gate.
  if (details.tabId == null || details.tabId < 0) return;
  const type = classifyWebRequestUrl(details.url);
  if (!type) return;
  passiveSiteAllowed(details.tabId, details.url).then(allowed => { if(allowed) return queueOrAddPassiveCandidate(details.tabId, {mediaUrl:details.url, type, source:'webRequest'}); }).catch(() => {});
}, {urls:['<all_urls>']});

try {
  browser.webRequest.onHeadersReceived.addListener(details => {
    // Content-Type detection complements URL detection without reading response bodies.
    if (details.tabId == null || details.tabId < 0) return;
    const type = classifyResponseContentType(details.responseHeaders);
    if (!type) return;
    passiveSiteAllowed(details.tabId, details.url).then(allowed => { if(allowed) return queueOrAddPassiveCandidate(details.tabId, {mediaUrl:details.url, type, source:'responseHeaders'}); }).catch(() => {});
  }, {urls:['<all_urls>']}, ['responseHeaders']);
} catch (error) {
  // Firefox versions that reject the optional response-header listener must not break other detection routes.
  console.warn('UVD responseHeaders listener unavailable', error);
}
try{browser.webRequest.onBeforeSendHeaders.addListener(d=>{rememberHeaders(d.url,d.requestHeaders||[])},{urls:['<all_urls>']},['requestHeaders'])}catch(e){}
async function getBundledCoAppVersion(){try{const r=await fetch(browser.runtime.getURL('companion/coapp-version.json'),{cache:'no-store'});if(!r.ok)return '';const j=await r.json();return String(j.coAppVersion||'')}catch{return ''}}
function compareVersions(a,b){const normalize=v=>{const p=String(v||'0').trim().split('.').map(x=>Number.parseInt(x,10)||0);return p.length===2?[0,p[0],p[1]]:p};const pa=normalize(a),pb=normalize(b);for(let i=0;i<Math.max(pa.length,pb.length);i++){const x=pa[i]||0,y=pb[i]||0;if(x!==y)return x-y}return 0}
async function getCoAppUpdateLock(){
 try{
  const r=await browser.storage.local.get('uvdCoAppUpdateLock');
  const lock=r.uvdCoAppUpdateLock;
  if(!lock||lock.active!==true)return null;
  const started=Number(lock.startedAt)||0;
  // A stale lock must not permanently disable normal operation after an interrupted update.
  if(started>0&&Date.now()-started>10*60*1000){
   await browser.storage.local.remove('uvdCoAppUpdateLock');
   return null;
  }
  return lock;
 }catch{return null}
}
async function setCoAppUpdateLock(targetVersion){
 const lock={active:true,targetVersion:String(targetVersion||''),startedAt:Date.now()};
 await browser.storage.local.set({uvdCoAppUpdateLock:lock});
 return lock;
}
async function clearCoAppUpdateLock(){try{await browser.storage.local.remove('uvdCoAppUpdateLock')}catch{}}
async function checkCoAppUpdateState(){
 try{
  const ext=browser.runtime.getManifest().version;
  const desired=await getBundledCoAppVersion();
  const lock=await getCoAppUpdateLock();
  const r=await sendCompanion({action:'ping',extensionVersion:ext});
  const cv=r?.version||'';
  const reached=!!r?.ok&&!!desired&&!!cv&&compareVersions(cv,desired)>=0;
  if(reached&&lock)await clearCoAppUpdateLock();
  const activeLock=reached?null:await getCoAppUpdateLock();
  const available=!!desired&&!!cv&&compareVersions(cv,desired)<0;
  const state={checkedAt:Date.now(),extensionVersion:ext,desiredCoAppVersion:desired,coAppVersion:cv,available,connected:!!r?.ok,error:r?.error||'',updating:!!activeLock,updateTargetVersion:activeLock?.targetVersion||''};
  await browser.storage.local.set({uvdCoAppUpdateState:state});
  return state;
 }catch(e){
  const ext=browser.runtime.getManifest().version;
  const desired=await getBundledCoAppVersion();
  const lock=await getCoAppUpdateLock();
  const state={checkedAt:Date.now(),extensionVersion:ext,desiredCoAppVersion:desired,coAppVersion:'',available:false,connected:false,error:String(e),updating:!!lock,updateTargetVersion:lock?.targetVersion||''};
  await browser.storage.local.set({uvdCoAppUpdateState:state});
  return state;
 }}
async function coAppUpdating(){return !!(await getCoAppUpdateLock());}

// CoApp update checks are initiated by the UI startup synchronization. They do not trigger page acquisition.

async function updateCoAppFromExtension(msg){
 try{
  const ext=browser.runtime.getManifest().version;
  const desired=await getBundledCoAppVersion();
  if(!desired)return{ok:false,error:'Bundled CoApp version metadata is missing.'};
  const existingLock=await getCoAppUpdateLock();
  if(existingLock)return{ok:true,updated:false,updating:true,targetVersion:existingLock.targetVersion||desired,message:'CoApp update is already in progress.'};
  const state=await checkCoAppUpdateState();
  if(state?.connected&&state.coAppVersion&&compareVersions(state.coAppVersion,desired)>=0)return{ok:true,updated:false,version:state.coAppVersion,message:'CoApp update is not required.'};
  const sourceUrl=browser.runtime.getURL('companion/uvd_companion.cs');
  const uninstallerUrl=browser.runtime.getURL('companion/uninstaller.cs');
  const companionSource=await (await fetch(sourceUrl,{cache:'no-store'})).text();
  const uninstallerSource=await (await fetch(uninstallerUrl,{cache:'no-store'})).text();
  if(!companionSource.includes('class Program')||!uninstallerSource.includes('class'))return{ok:false,error:'Update source validation failed.'};
  const r=await sendCompanion({action:'update_from_extension',extensionVersion:ext,coAppVersion:desired,companionSource,uninstallerSource});
  if(r?.ok){
   await setCoAppUpdateLock(desired);
   await browser.storage.local.set({uvdCoAppUpdateState:{checkedAt:Date.now(),extensionVersion:ext,desiredCoAppVersion:desired,coAppVersion:state?.coAppVersion||'',available:false,connected:true,updating:true}});
  }
  return r;
 }catch(e){return{ok:false,error:e?.message||String(e)}}
}
function isFormalUvdVersion(value){return /^\d+\.\d+\.\d+$/.test(String(value||'').trim())}
function compareFormalUvdVersions(a,b){const pa=String(a||'').trim().split('.').map(Number),pb=String(b||'').trim().split('.').map(Number);if(pa.length!==3||pb.length!==3)return null;for(let i=0;i<3;i++){if(pa[i]!==pb[i])return pa[i]-pb[i]}return 0}
async function checkUvdUpdateManifest(url){
 const endpoint=String(url||'').trim();
 if(!endpoint)return{ok:false,configured:false,error:'Update manifest URL is not configured.'};
 if(!/^https?:$/i.test(new URL(endpoint).protocol))return{ok:false,error:'Update manifest URL must use HTTP or HTTPS.'};
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),8000);
 try{
  const response=await fetch(endpoint,{cache:'no-store',signal:controller.signal});
  if(!response.ok)throw new Error(`HTTP ${response.status}`);
  const data=await response.json();
  const version=String(data?.version||'').trim();
  if(!isFormalUvdVersion(version))throw new Error(`Invalid update version: ${version||'missing'}`);
  const urlValue=String(data?.url||'').trim();
  if(!/^https?:$/i.test(new URL(urlValue).protocol))throw new Error('Update package URL must use HTTP or HTTPS.');
  const sha256=String(data?.sha256||'').trim().toLowerCase();
  if(!/^[a-f0-9]{64}$/.test(sha256))throw new Error('Invalid SHA-256 value in update manifest.');
  if(typeof data?.required!=='boolean')throw new Error('Update manifest required must be boolean.');
  const current=String(browser.runtime.getManifest().version||'').trim();
  if(!isFormalUvdVersion(current))throw new Error(`Invalid current UVD version: ${current||'missing'}`);
  const comparison=compareFormalUvdVersions(version,current);
  const state={ok:true,checkedAt:Date.now(),currentVersion:current,version,url:urlValue,sha256,required:data.required,updateAvailable:comparison>0};
  await browser.storage.local.set({uvdUpdateCheckState:state});
  return state;
 }catch(e){const state={ok:false,checkedAt:Date.now(),currentVersion:String(browser.runtime.getManifest().version||''),error:e?.name==='AbortError'?'Update manifest request timed out.':(e?.message||String(e))};await browser.storage.local.set({uvdUpdateCheckState:state});return state}
 finally{clearTimeout(timer)}
}
let backgroundUiReady=false;
async function startPostUiInitialization(){if(backgroundUiReady)return;backgroundUiReady=true;await migrateStorageSchema().catch(e=>console.error('UVD storage initialization failed',e));try{await initializeAdFilter();const cfg=uvdFilterNormalizeSettings(await getDownloadSettings());let results=[];if(cfg.enabled&&cfg.autoUpdate)results=await updateAdFilterLists(false);const listsChanged=Array.isArray(results)&&results.some(x=>x?.changed);await reclassifyAllAdFiltersIfNeeded(listsChanged);}catch(e){console.error('UVD ad-filter initialization failed',e)}}
browser.runtime.onMessage.addListener(async(msg,sender)=>{const tid=sender.tab?.id??msg.tabId;
 if(msg.type==='uiProcessingReady'&&tid==null){if(msg.tabId!=null)uiProcessingReadyTabs.add(msg.tabId);return{ok:true}}
 const listenerOnly=sender.tab?.id!=null&&['detectorReady','detected','detectedBatch','metadata'].includes(msg.type);
 const updating=listenerOnly?false:await coAppUpdating();
 if(updating){
  const allowed=['checkCoAppUpdate','getCoAppUpdateState','updateCoApp','companionPing','state','listInternal','list','detectorReady','detected','detectedBatch','metadata','scanStart','scanDone','scanFinished','rescanStart'];
  if(!allowed.includes(msg.type)){return{ok:false,updating:true,targetVersion:updating.targetVersion||'',error:'CoApp is updating. Please wait until the update is verified.'};}
 }if(msg.type==='detectorReady'&&tid!=null){const st=tabState(tid);st.pageIdentity=msg.pageIdentity||st.pageIdentity;st.lastPageUrl=String(msg.url||st.lastPageUrl||'');return{ok:true,rawOnly:true}}if(msg.type==='detected'&&tid!=null){const item={...(msg.item||{}),pageUrl:msg.item?.pageUrl||sender.tab?.url||''};if(!uiProcessingReadyTabs.has(tid))return{ok:true,rawOnly:true,count:queueRawCandidates(tid,[item])};await add(tid,item);return{ok:true}}if(msg.type==='detectedBatch'&&tid!=null){const batch=(Array.isArray(msg.items)?msg.items:[]).map(item=>({...item,pageUrl:item?.pageUrl||sender.tab?.url||''}));if(!uiProcessingReadyTabs.has(tid))return{ok:true,rawOnly:true,count:queueRawCandidates(tid,batch)};return{ok:true,changed:await addBatch(tid,batch)}}if(msg.type==='finalizeRawCandidates'&&tid!=null){return{ok:true,changed:await finalizeRawCandidates(tid)}}if(msg.type==='postUiInitialization'&&tid==null){await startPostUiInitialization();return{ok:true}}if(msg.type==='metadata'&&tid!=null){if(!uiProcessingReadyTabs.has(tid)){const q=rawCandidatesByTab.get(tid)||[];const meta=msg.item||{};for(const item of q){if(meta.thumbnail&&item.thumbnail&&assetKey(meta.thumbnail)===assetKey(item.thumbnail)){if(meta.name)item.name=mergeText(item.name,meta.name)}}return{ok:true,rawOnly:true}}enrichByMetadata(tid,msg.item);return{ok:true}}if(msg.type==='scanStart'&&tid!=null){const t=await browser.tabs.get(tid).catch(()=>null);await hydrateDetected(tid,t?.url||'');beginScan(tid,!!msg.hold);return{ok:true}}if(msg.type==='scanDone'&&tid!=null){const j=scanJobs.get(tid);if(j){j.hold=false;markDetected(tid)}return{ok:true}}if(msg.type==='scanFinished'&&tid!=null){const j=scanJobs.get(tid);if(j){j.hold=false;j.done=true;j.finished=msg.finished||Date.now();clearTimeout(j.quietTimer);clearTimeout(j.maxTimer);browser.runtime.sendMessage({type:'scanFinished',tabId:tid,finished:j.finished}).catch(()=>{})}return{ok:true}}if(msg.type==='rescanStart'&&tid!=null){const t=await browser.tabs.get(tid).catch(()=>null);await hydrateDetected(tid,t?.url||'');beginScan(tid,true);return{ok:true}}if(msg.type==='state')return scanState(msg.tabId);if(msg.type==='detectionDiagnostics'){const tid=msg.tabId;if(tid==null)return{ok:false};const st=tabState(tid);return{ok:true,rawCandidates:(rawCandidatesByTab.get(tid)||[]).length,internalItems:st.items.size,ready:uiProcessingReadyTabs.has(tid),pageIdentity:st.pageIdentity||null};}if(msg.type==='listInternal'){const tid=msg.tabId;if(tid==null)return[];const t=await browser.tabs.get(tid).catch(()=>null);const current=String(t?.url||msg.pageUrl||'');if(!current)return[];const st=tabState(tid);const previous=String(st.lastPageUrl||'');if(previous&&assetKey(current)!==assetKey(previous)){return[];}if(st.pageKey!==pageStoreKey(st.pageIdentity||{},current)||st.pendingNavigation){await hydrateDetected(tid,current);}const ready=tabState(tid);if(ready.pendingNavigation)return[];const out=[...ready.items.values()];const tw=out.some(x=>String(x?.source||'').startsWith('twiigle'));if(tw)out.sort((a,b)=>{const ar=Number(String(a?.ranking||'').match(/\d+/)?.[0]||0),br=Number(String(b?.ranking||'').match(/\d+/)?.[0]||0);if(ar&&br&&ar!==br)return ar-br;if(ar&&!br)return -1;if(br&&!ar)return 1;return(a.firstSeen||0)-(b.firstSeen||0)});else out.sort((a,b)=>(a.firstSeen||0)-(b.firstSeen||0));return out;}if(msg.type==='list'){const t=await browser.tabs.get(msg.tabId).catch(()=>null);const st=await hydrateDetected(msg.tabId,t?.url||'');const out=[...st.items.values()];const tw=out.some(x=>String(x?.source||'').startsWith('twiigle'));if(tw)out.sort((a,b)=>{const ar=Number(String(a?.ranking||'').match(/\d+/)?.[0]||0),br=Number(String(b?.ranking||'').match(/\d+/)?.[0]||0);if(ar&&br&&ar!==br)return ar-br;if(ar&&!br)return -1;if(br&&!ar)return 1;return(a.firstSeen||0)-(b.firstSeen||0)});else out.sort((a,b)=>(a.firstSeen||0)-(b.firstSeen||0));return out;}if(msg.type==='clear'){return{ok:true,displayOnly:true,internalListPreserved:true}}if(msg.type==='checkExistingDownloads')return sendCompanion({action:'check_existing_downloads',rootDirectory:msg.rootDirectory||msg.settings?.downloadRoot||'',folderNaming:msg.settings?.folderNaming||'site_title',items:Array.isArray(msg.items)?msg.items:[],site:msg.site||null});if(msg.type==='downloadBatch')return doDownload(msg);if(msg.type==='downloadOne')return doDownload({...msg,items:[msg.item]});if(msg.type==='history'){
 const r=await sendCompanion({action:'get_full_state'});if(r?.ok){const rev=Number(r.stateRevision)||0;if(rev>=coAppStateRevision){coAppStateRevision=rev;coAppStateJobs=Array.isArray(r.jobs)?r.jobs:[];}}
 const terminal=coAppStateJobs.filter(j=>['completed','exist','failed','cancelled'].includes(j?.status));
 return msg.item?(terminal.find(j=>(msg.item.itemId!=null&&j.itemId!=null&&String(msg.item.itemId)===String(j.itemId))||(mediaUrlOf(msg.item)&&j.mediaUrl&&assetKey(mediaUrlOf(msg.item))===assetKey(j.mediaUrl)))||null):terminal;
 }if(msg.type==='downloads'){
 const r=await sendCompanion({action:'get_full_state'});
 if(!r?.ok)return coAppStateJobs;
 const rev=Number(r.stateRevision)||0;
 if(rev>=coAppStateRevision)coAppStateRevision=rev;
 coAppStateJobs=Array.isArray(r.jobs)?r.jobs:[];
 return coAppStateJobs;
}if(msg.type==='getAdFilterStatus'){await initializeAdFilter();return getAdFilterStatus()}if(msg.type==='updateAdFilterLists'){const cfg=uvdFilterNormalizeSettings(await getDownloadSettings());if(!cfg.enabled)return{ok:true,disabled:true,results:[],status:getAdFilterStatus()};const results=await updateAdFilterLists(true);await reclassifyAllAdFilters();return{ok:results.every(x=>x.ok),results,status:getAdFilterStatus()}}if(msg.type==='saveSettings'){try{const cfg=migrateSettingsObject(msg.settings);await browser.storage.local.set({uvdSettingsPersisted:cfg,uvdStorageSchemaVersion:STORAGE_SCHEMA_VERSION});try{await browser.storage.sync.set({uvdSettingsPersisted:cfg})}catch{}if(globalThis.uvdFilterSettingsChanged)await globalThis.uvdFilterSettingsChanged(cfg);return{ok:true}}catch(e){return{ok:false,error:e?.message||String(e)}}}if(msg.type==='cancelDownloads')return sendCompanion({action:'cancel_downloads',jobIds:Array.isArray(msg.jobIds)?msg.jobIds:[]});if(msg.type==='clearHistory'){return sendCompanion({action:'clear_history'})}if(msg.type==='clearLogs'){return sendCompanion({action:'clear_logs'})}if(msg.type==='chooseFolder'){const r=await sendCompanion({action:'choose_folder'});if(r?.ok&&r.path){const cfg=await getDownloadSettings();cfg.downloadRoot=String(r.path);await browser.storage.local.set({uvdSettingsPersisted:migrateSettingsObject(cfg),uvdStorageSchemaVersion:STORAGE_SCHEMA_VERSION});try{await browser.storage.sync.set({uvdSettingsPersisted:migrateSettingsObject(cfg)})}catch{} }return r;}if(msg.type==='checkUvdUpdate')return checkUvdUpdateManifest(msg.url||globalThis.UVD_UPDATE_CONFIG?.manifestUrl);if(msg.type==='checkCoAppUpdate')return checkCoAppUpdateState();if(msg.type==='updateCoApp')return updateCoAppFromExtension(msg);if(msg.type==='getCoAppUpdateState')return checkCoAppUpdateState();if(msg.type==='installCompanion')return sendCompanion({action:'install_companion',rootDirectory:msg.rootDirectory});if(msg.type==='openFolder')return openNative('open_folder',{jobId:msg.jobId||'',path:msg.path||''});if(msg.type==='playFile'){
 const identity={jobId:String(msg.jobId||''),itemId:String(msg.itemId||''),mediaUrl:String(msg.mediaUrl||''),identityUrl:String(msg.identityUrl||'')};
 const resolved=await openNative('resolve_playback',identity);
 if(!resolved?.ok)return {...(resolved||{}),stage:'background_playback_resolve'};
 if(resolved.exists!==true)return {ok:false,exists:false,stage:'background_playback_resolve',error:'再生対象ファイルが存在しません。'};
 const r=await openNative('play_file',{jobId:String(resolved.jobId||identity.jobId||''),path:String(resolved.jobPath||''),itemId:identity.itemId,mediaUrl:identity.mediaUrl,identityUrl:identity.identityUrl});
 return {...r,exists:true,jobPath:resolved.jobPath||'',stage:'background_native_response'};
}if(msg.type==='companionPing'){const r=await sendCompanion({action:'ping',ffmpegPath:(msg.settings||{}).ffmpegPath||''});if(r?.ok){r.path=r.path||r.companionPath||'';r.registered=true;if(r.path){try{const cfg=migrateSettingsObject(await getDownloadSettings());cfg.companionPath=String(r.path);await browser.storage.local.set({uvdSettingsPersisted:cfg,uvdStorageSchemaVersion:STORAGE_SCHEMA_VERSION});try{await browser.storage.sync.set({uvdSettingsPersisted:cfg})}catch{}}catch(e){console.error('UVD companion path persistence failed',e)}}}else{r.registered=false;r.path=(msg.settings||{}).companionPath||''}return r}});
globalThis.uvdFilterSettingsChanged=async cfg=>{const s=uvdFilterNormalizeSettings(cfg);if(!s.enabled)return;await initializeAdFilter();let changed=false;if(s.autoUpdate){const results=await updateAdFilterLists(false);changed=results.some(x=>x.changed)}const missing=[];for(const st of tabs.values())for(const item of st.items.values())if(!item.adFilter||!item.adFilter.confidence)missing.push(item);if(changed||missing.length)await reclassifyAllAdFilters();};
setInterval(async()=>{if(!backgroundUiReady)return;try{const cfg=uvdFilterNormalizeSettings(await getDownloadSettings());if(cfg.enabled&&cfg.autoUpdate){await initializeAdFilter();if(Object.values(uvdFilterMeta||{}).some(m=>m.status==='failed')||Object.keys(uvdFilterMeta||{}).length===0)await updateAdFilterLists(false);else if(Object.values(uvdFilterMeta||{}).some(m=>m.lastSuccessfulFetch&&!m.expiresDays?true:uvdFilterDue(UVD_FILTER_SOURCES.find(x=>x.id===m.id)||UVD_FILTER_SOURCES[0])))await updateAdFilterLists(false);}}catch(e){console.error('UVD ad-filter scheduled update failed',e)}},6*60*60*1000);
browser.tabs.onUpdated.addListener((id,changeInfo,tab)=>{
  const url=changeInfo?.url||tab?.url||'';
  // Navigation never clears the internal list. Hydrate the new site's list early so
  // the popup cannot temporarily display the previous page's table contents.
  if(changeInfo.status==='loading' && url){
    const st=tabState(id);
    st.pendingNavigation=true;
    st.lastPageUrl=String(url);
    st.pageKey='';
    st.pageIdentity=null;
    // Pre-UI navigation is listener-only; do not hydrate the internal list.
  }
  if(changeInfo.status==='complete'){
    browser.tabs.sendMessage(id,{type:'pageReady'}).catch(()=>{});
  }
});
browser.tabs.onRemoved.addListener(id=>{const st=tabs.get(id);tabs.delete(id);scanJobs.delete(id);rawCandidatesByTab.delete(id);uiProcessingReadyTabs.delete(id);if(st?.persistTimer)clearTimeout(st.persistTimer)});
