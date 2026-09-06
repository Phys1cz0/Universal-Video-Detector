const UVD_VERSION='0.6.22';
const POPUP_STORAGE_SCHEMA_VERSION=6;
// Detection presets are stored independently from download/appearance settings.
const DETECTION_PRESET_STORAGE_KEY='uvdDetectionPresets';
// Detection preset fields intentionally exclude download, CoApp, filter, and appearance settings.
const DETECTION_CONFIG_FIELDS=['mode','dynamicWait','dynamicScrollAttempts','maxSeconds','restorePosition',...Object.keys(UVDDetectionTuning.DEFAULTS)];
let pendingUiAction='',coAppUpdateState=null,coAppUpdating=false,coAppUpdateTarget='',coAppStartupReady=false,coAppStateRevision=0,tabId,currentBatchId='',internalItems=[],displayItems=[],items=[],selected=new Set(),busy=false,batchBusy=false,displayCleared=false,downloadingKeys=new Set(),skipNoticeKeys=new Set(),skipNoticeTimers=new Map(),renderScheduled=false,renderScheduleTimer=0,settings={mode:'auto',dynamicWait:150,dynamicScrollAttempts:2,maxSeconds:15,restorePosition:true,downloadRoot:'',companionPath:'',ffmpegPath:'',folderNaming:'site_title',parallelDownloads:3,duplicateFileMode:'exist',notifyComplete:true,previewMode:'image',theme:'system',windowSize:'medium',textSize:'medium',adFilterEnabled:false,adFilterStrength:'medium',adFilterAutoUpdate:true,sidebarFixed:false,siteAccessMode:'all',whitelistSites:[],blacklistSites:[],...UVDDetectionTuning.DEFAULTS};
const DEFAULT_SETTINGS={mode:'auto',dynamicWait:150,dynamicScrollAttempts:2,maxSeconds:15,restorePosition:true,downloadRoot:'',companionPath:'',ffmpegPath:'',folderNaming:'site_title',parallelDownloads:3,duplicateFileMode:'exist',notifyComplete:true,previewMode:'image',theme:'system',windowSize:'medium',textSize:'medium',adFilterEnabled:false,adFilterStrength:'medium',adFilterAutoUpdate:true,sidebarFixed:false,siteAccessMode:'all',whitelistSites:[],blacklistSites:[],...UVDDetectionTuning.DEFAULTS};
const $=id=>document.getElementById(id);const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function getBundledCoAppVersion(){try{const r=await fetch(browser.runtime.getURL('companion/coapp-version.json'),{cache:'no-store'});if(!r.ok)return '';const j=await r.json();return String(j.coAppVersion||'').trim()}catch{return ''}}
let coAppCheckPromise=null;
async function refreshCoAppUpdateState(){
 if(coAppCheckPromise)return coAppCheckPromise;
 coAppCheckPromise=(async()=>{
  try{
   const r=await Promise.race([browser.runtime.sendMessage({type:'checkCoAppUpdate'}),sleep(5000).then(()=>({ok:false,connected:false,error:'CoApp更新状態の確認がタイムアウトしました。'}))]);
   if(r&&typeof r==='object'){
    coAppUpdateState=r;
    coAppUpdating=!!r.updating;
    coAppUpdateTarget=String(r.updateTargetVersion||r.desiredCoAppVersion||'');
    applyButtonState();
    return r;
   }
   return null;
  }catch(e){
   const state={checkedAt:Date.now(),extensionVersion:browser.runtime.getManifest().version,desiredCoAppVersion:await getBundledCoAppVersion(),coAppVersion:'',available:false,connected:false,error:e?.message||String(e)};
   coAppUpdateState=state;
   return state;
  }finally{coAppCheckPromise=null;}
 })();
 return coAppCheckPromise;
}
function mergeStoredSettings(primary,backup){
 const p=primary&&typeof primary==='object'?primary:{};const b=backup&&typeof backup==='object'?backup:{};return {...DEFAULT_SETTINGS,...b,...p};
}
async function loadSettings(persist=false){
 try{
  const r=await browser.storage.local.get(['uvdSettingsPersisted','uvdSettings']);
  let saved=r.uvdSettingsPersisted&&typeof r.uvdSettingsPersisted==='object'?r.uvdSettingsPersisted:null;
  if(!saved){
   try{const sr=await browser.storage.sync.get('uvdSettingsPersisted');saved=sr.uvdSettingsPersisted&&typeof sr.uvdSettingsPersisted==='object'?sr.uvdSettingsPersisted:null}catch{}
  }
  const legacy=r.uvdSettings&&typeof r.uvdSettings==='object'?r.uvdSettings:{};
  settings={...DEFAULT_SETTINGS,...legacy,...(saved||{})};
  settings.whitelistSites=UVDDetectionTuning.normalizeSiteList(settings.whitelistSites);settings.blacklistSites=UVDDetectionTuning.normalizeSiteList(settings.blacklistSites);
  settings.parallelDownloads=Math.max(1,Math.min(99,Number(settings.parallelDownloads)||3));
  // Startup must not block popup painting on storage writes. The background
  // migration owns schema persistence; the popup persists only after an
  // explicit settings change.
  if(persist){
   await browser.storage.local.set({uvdSettingsPersisted:settings,uvdStorageSchemaVersion:POPUP_STORAGE_SCHEMA_VERSION});
   try{await browser.storage.sync.set({uvdSettingsPersisted:settings})}catch{}
  }
 }catch(e){
  settings={...DEFAULT_SETTINGS};
 }
 for(const id of ['mode','dynamicWait','dynamicScrollAttempts','maxSeconds','folderNaming','parallelDownloads','duplicateFileMode','downloadRoot','companionPath','ffmpegPath','previewMode','theme','windowSize','textSize','adFilterStrength','detectionPreset','analysisMaxResponseMB','analysisMaxDepth','analysisMaxNodes','analysisTimeBudgetMs','maxMutationNodes','streamAnalysis','extensionlessDetection','domDetection','networkDetection','jsonDetection','urlCandidateDetection','siteAccessMode','whitelistSites','blacklistSites'])if($(id))$(id).value=Array.isArray(settings[id])?settings[id].join('\n'):(settings[id]??'');
 for(const id of ['detectionPreset','analysisMaxResponseMB','analysisMaxDepth','analysisMaxNodes','analysisTimeBudgetMs','maxMutationNodes'])if($(id))$(id).value=settings[id]??UVDDetectionTuning.DEFAULTS[id]??'';for(const id of ['streamAnalysis','extensionlessDetection','domDetection','networkDetection','jsonDetection','urlCandidateDetection'])if($(id))$(id).checked=settings[id]!==false;
 if($('restorePosition'))$('restorePosition').checked=settings.restorePosition!==false;if($('sidebarFixed'))$('sidebarFixed').checked=settings.sidebarFixed===true;
 if($('notifyComplete'))$('notifyComplete').checked=settings.notifyComplete!==false;if($('adFilterEnabled'))$('adFilterEnabled').checked=settings.adFilterEnabled!==false;if($('adFilterAutoUpdate'))$('adFilterAutoUpdate').checked=settings.adFilterAutoUpdate!==false;
 applyAppearance();
}
async function applySidebarPreference(){
 // sidebarAction.open()/close() requires a user activation in Firefox. This
 // helper is intentionally limited to best-effort close during initialization;
 // opening is performed synchronously in the checkbox change handler below.
 const enabled=settings.sidebarFixed===true;
 if(!enabled)return;
}
async function saveSettings(){
 const next={...settings,
  downloadRoot:$('downloadRoot').value.trim(),mode:$('mode').value,dynamicWait:+$('dynamicWait').value||150,
  dynamicScrollAttempts:Math.max(2,Math.min(10,+$('dynamicScrollAttempts').value||2)),maxSeconds:+$('maxSeconds').value||15,
  folderNaming:$('folderNaming').value,duplicateFileMode:$('duplicateFileMode').value,
  parallelDownloads:Math.max(1,Math.min(99,+$('parallelDownloads').value||3)),companionPath:$('companionPath').value.trim(),
  ffmpegPath:$('ffmpegPath').value.trim(),restorePosition:$('restorePosition').checked,notifyComplete:$('notifyComplete').checked,
  previewMode:$('previewMode').value,theme:$('theme').value,windowSize:$('windowSize').value,textSize:$('textSize').value,adFilterEnabled:$('adFilterEnabled').checked,adFilterStrength:$('adFilterStrength').value,adFilterAutoUpdate:$('adFilterAutoUpdate').checked,sidebarFixed:$('sidebarFixed').checked,siteAccessMode:$('siteAccessMode')?.value||'all',whitelistSites:String($('whitelistSites')?.value||'').split(/\r?\n|,/).map(x=>x.trim()).filter(Boolean),blacklistSites:String($('blacklistSites')?.value||'').split(/\r?\n|,/).map(x=>x.trim()).filter(Boolean),...UVDDetectionTuning.normalize({analysisPreset:$('detectionPreset')?.value||settings.analysisPreset,analysisMaxResponseMB:+$('analysisMaxResponseMB')?.value||20,analysisMaxDepth:+$('analysisMaxDepth')?.value||15,analysisMaxNodes:+$('analysisMaxNodes')?.value||1000,analysisTimeBudgetMs:+$('analysisTimeBudgetMs')?.value||5,maxMutationNodes:+$('maxMutationNodes')?.value||128,streamAnalysis:$('streamAnalysis')?.checked,extensionlessDetection:$('extensionlessDetection')?.checked,domDetection:$('domDetection')?.checked,networkDetection:$('networkDetection')?.checked,jsonDetection:$('jsonDetection')?.checked,urlCandidateDetection:$('urlCandidateDetection')?.checked})};
 settings=next;
 // Apply the visual/interactive filter state immediately. Do not wait for
 // Native Messaging/storage persistence, because the checkbox change itself
 // must be reflected in the open popup at once.
 applyAdFilterUiState();
 applyButtonState();
 try{
  const r=await browser.storage.local.get('uvdSettingsRevision');
  const rev=Number(r.uvdSettingsRevision||0)+1;
  const saved=await browser.runtime.sendMessage({type:'saveSettings',settings:next});
  if(!saved?.ok)throw new Error(saved?.error||'Background settings save failed.');
  await browser.storage.local.set({uvdSettingsRevision:rev});
 }catch(e){
  console.error('UVD settings save failed',e);
 }
 applyAppearance();
 if(items.length&&!displayCleared)await render(false);
 try{await refreshDetectionDiagnostics()}catch{}
}

async function loadDetectionPresets(){
 // Load user-named presets from Firefox local storage; no external file is required for normal use.
 try{const r=await browser.storage.local.get(DETECTION_PRESET_STORAGE_KEY);return r[DETECTION_PRESET_STORAGE_KEY]&&typeof r[DETECTION_PRESET_STORAGE_KEY]==='object'?r[DETECTION_PRESET_STORAGE_KEY]:{};}catch{return {}}
}
function refreshDetectionPresetSelect(presets){
 const select=$('customPresetSelect');if(!select)return;const current=select.value;select.replaceChildren();const emptyOption=document.createElement('option');emptyOption.value='';emptyOption.textContent='未選択';select.appendChild(emptyOption);
 for(const name of Object.keys(presets).sort((a,b)=>a.localeCompare(b,'ja'))) {const option=document.createElement('option');option.value=name;option.textContent=name;select.appendChild(option);}
 if(Object.prototype.hasOwnProperty.call(presets,current))select.value=current;
}
async function applyDetectionPreset(name){
 const current={...settings};const next=UVDDetectionTuning.applyPreset(name,current);settings={...settings,...next};
 for(const id of ['detectionPreset','analysisMaxResponseMB','analysisMaxDepth','analysisMaxNodes','analysisTimeBudgetMs','maxMutationNodes'])if($(id))$(id).value=settings[id];for(const id of ['streamAnalysis','extensionlessDetection','domDetection','networkDetection','jsonDetection','urlCandidateDetection'])if($(id))$(id).checked=settings[id]!==false;
 await saveSettings();
}
async function saveNamedDetectionPreset(){
 const name=String($('customPresetName')?.value||'').trim();if(!name){alert('設定名を入力してください。');return;}
 const presets=await loadDetectionPresets();presets[name]=Object.fromEntries(DETECTION_CONFIG_FIELDS.map(key=>[key,settings[key]]));await browser.storage.local.set({[DETECTION_PRESET_STORAGE_KEY]:presets});refreshDetectionPresetSelect(presets);if($('customPresetSelect'))$('customPresetSelect').value=name;
}
async function renameDetectionPreset(){
 const select=$('customPresetSelect'),oldName=String(select?.value||''),newName=String($('customPresetName')?.value||'').trim();if(!oldName||!newName){alert('変更元と新しい設定名を指定してください。');return;}const presets=await loadDetectionPresets();if(!presets[oldName]){alert('指定した設定がありません。');return;}if(oldName!==newName&&presets[newName]){alert('その設定名は既に存在します。');return;}presets[newName]=presets[oldName];delete presets[oldName];await browser.storage.local.set({[DETECTION_PRESET_STORAGE_KEY]:presets});refreshDetectionPresetSelect(presets);select.value=newName;$('customPresetName').value=newName;
}
async function deleteDetectionPreset(){
 const name=String($('customPresetSelect')?.value||'');if(!name)return;const presets=await loadDetectionPresets();if(!presets[name])return;delete presets[name];await browser.storage.local.set({[DETECTION_PRESET_STORAGE_KEY]:presets});refreshDetectionPresetSelect(presets);$('customPresetName').value='';
}
async function exportDetectionPreset(){
 const presets=await loadDetectionPresets();const payload={schema:1,exportedAt:new Date().toISOString(),presets};const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='uvd-detection-presets.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function importDetectionPresetFile(file){
 try{const text=await file.text(),payload=JSON.parse(text),incoming=payload?.presets;if(!incoming||typeof incoming!=='object')throw new Error('presetsがありません。');const existing=await loadDetectionPresets();for(const [name,value] of Object.entries(incoming)){if(typeof name==='string'&&value&&typeof value==='object')existing[name]=Object.fromEntries(DETECTION_CONFIG_FIELDS.map(key=>[key,UVDDetectionTuning.normalize(value)[key] ?? value[key]]));}await browser.storage.local.set({[DETECTION_PRESET_STORAGE_KEY]:existing});refreshDetectionPresetSelect(existing);}catch(e){alert('設定ファイルを読み込めませんでした。\n'+(e?.message||String(e)));}
}
async function refreshDetectionDiagnostics(){
 if(!$('detectionDiagnostics')||tabId==null)return;try{const r=await browser.runtime.sendMessage({type:'detectionDiagnostics',tabId});if(r?.ok)$('detectionDiagnostics').textContent=`診断: DOM batch ${r.domBatches||0} / DOM候補 ${r.domCandidates||0} / 内部 ${r.internalItems||0} / raw ${r.rawCandidates||0} / ${r.ready?'UI確定済み':'UIゲート前'}`;}catch{}
}

async function refreshAdFilterPanel(){try{const r=await browser.runtime.sendMessage({type:'getAdFilterStatus'});if(!r?.sources)return;for(const src of r.sources){const box=$(src.id+'Status');if(!box)continue;const st=src.status||'never_fetched';box.textContent=st==='ok'?`正常${src.ruleCount?` / ${src.ruleCount.toLocaleString()}ルール`:''}`:st==='updating'?'更新中…':st==='failed'?`更新失敗: ${src.failureReason||'不明'}`:'未取得';}const meta=$('adFilterUpdatedAt');if(meta){const times=r.sources.map(x=>Number(x.lastSuccessfulFetch)||0).filter(Boolean);meta.textContent=times.length?`最終成功更新: ${new Date(Math.max(...times)).toLocaleString('ja-JP')}`:'最終成功更新: まだありません';}applyAdFilterUiState();}catch(e){console.error('UVD ad-filter status failed',e);applyAdFilterUiState()}}
async function updateAdFilterListsFromUi(){
 const b=$('adFilterUpdateNow');
 if(!settings.adFilterEnabled){applyAdFilterUiState();return}
 if(b)b.disabled=true;
 let updateResponse=null;
 try{
  updateResponse=await browser.runtime.sendMessage({type:'updateAdFilterLists'});
  if(updateResponse?.disabled){alert('広告フィルターがOFFのため、更新を実行しませんでした。');return}
  if(!updateResponse?.ok){
   const failed=(Array.isArray(updateResponse?.results)?updateResponse.results.filter(x=>!x?.ok).map(x=>{const src=(updateResponse?.status?.sources||[]).find(s=>s.id===x.sourceId);return `${src?.name||x.sourceId}: ${x.error||src?.failureReason||'不明'}`}).join('\n'):'');
   alert(`フィルターリストの更新に失敗しました。\n${failed||'原因を取得できませんでした。'}\n\n前回の有効なリストは保持されています。`);
  }
 }catch(e){
  alert(`フィルターリストの更新に失敗しました。\n原因: ${e?.message||String(e)}`);
  console.error(e);
 }finally{
  // The filter update result and the popup rendering are separate concerns.
  // Never turn a successful filter update into a failure because video-table
  // rendering failed.
  await refreshAdFilterPanel();
  if(updateResponse?.ok&&items.length&&!displayCleared){
   try{setInternalItems(await list());await render(false);}catch(e){console.error('UVD video list refresh after filter update failed',e);}
  }
  applyAdFilterUiState();
  applyButtonState();
 }
}

function applyAppearance(){const size=settings.windowSize||'medium';const width=size==='small'?'500px':size==='large'?'760px':'600px';document.body.classList.remove('dark','light','size-small','size-medium','size-large','text-small','text-medium','text-large');const theme=settings.theme||'system';if(theme==='dark')document.body.classList.add('dark');else if(theme==='light')document.body.classList.add('light');else if(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)document.body.classList.add('dark');document.body.classList.add('size-'+size,'text-'+(settings.textSize||'medium'));document.documentElement.style.width=width;document.documentElement.style.height='600px';document.documentElement.style.minHeight='600px';document.documentElement.style.maxHeight='600px';document.body.style.width=width;document.body.style.height='600px';document.body.style.minHeight='600px';document.body.style.maxHeight='600px';}
async function active(){return(await browser.tabs.query({active:true,currentWindow:true}))[0]}
async function list(){
 if(coAppUpdating)return items.slice();
 let t=null;
 try{if(tabId!=null)t=await browser.tabs.get(tabId)}catch{}
 if(!t){try{t=await active();if(t?.id!=null)tabId=t.id}catch{}}
 const pageUrl=t?.url||'';
 if(!pageUrl)return[];
 try{
  const r=await browser.runtime.sendMessage({type:'listInternal',pageUrl,tabId});
  return Array.isArray(r)?r:[];
 }catch{}
 return[];
}async function state(){return tabId==null?{busy:false}:await browser.runtime.sendMessage({type:'state',tabId})}
function setBusy(v){busy=!!v;applyButtonState()}
function adFilterDisplayAllowed(item,cfg){
 const enabled=cfg?.adFilterEnabled!==false;
 if(!enabled)return true;
 const strength=['weak','medium','strong'].includes(cfg?.adFilterStrength)?cfg.adFilterStrength:'medium';
 const confidence=String(item?.adFilter?.confidence||'NORMAL');
 if(strength==='weak')return confidence!=='HIGH';
 if(strength==='medium')return confidence!=='HIGH'&&confidence!=='MEDIUM';
 if(strength==='strong')return confidence==='NORMAL';
 return true;
}
function getVisibleVideoItems(){displayItems=internalItems.filter(x=>adFilterDisplayAllowed(x,settings));return displayItems}
function setInternalItems(next){internalItems=Array.isArray(next)?next:[];items=internalItems;getVisibleVideoItems();}
function applyAdFilterUiState(){const enabled=!!settings.adFilterEnabled;const group=$('adFilterGroup');if(group)group.classList.toggle('ad-filter-disabled',!enabled);for(const id of ['adFilterStrength','adFilterAutoUpdate','adFilterUpdateNow']){const el=$(id);if(el)el.disabled=!enabled;}for(const id of ['easylistStatus','easyprivacyStatus','ublock-filtersStatus','adFilterUpdatedAt']){const el=$(id);if(el)el.setAttribute('aria-disabled',enabled?'false':'true');}}
function applyButtonState(){const locked=coAppUpdating;const visibleCount=getVisibleVideoItems().length;if($('batchCancel'))$('batchCancel').disabled=locked||!batchBusy;$('refresh').disabled=locked||busy;$('refresh').textContent=locked?'CoApp更新中…':(busy?'検出中…':'更新');$('batch').disabled=locked||batchBusy||visibleCount===0;$('batch').textContent=locked?'CoApp更新中…':(batchBusy?'一括ダウンロード（処理中）':'一括ダウンロード');$('clear').disabled=locked;$('selectedDownload').disabled=locked||!selected.size;const updateBtn=$('updateCoApp');if(updateBtn)updateBtn.disabled=locked||batchBusy;document.querySelectorAll('.tab').forEach(b=>{b.disabled=locked&&b.dataset.tab!=='settings'});if(locked&&document.querySelector('.tab.active')?.dataset.tab!=='settings')switchTab('settings');document.querySelectorAll('#list .openFolder,#list .playFile,#downloadList .downloadOpenFolder,#downloadList .downloadPlay,#downloadList .cancelDownload').forEach(b=>b.disabled=locked);applyAdFilterUiState();}
function siteKey(t){try{const u=new URL(t?.url||'');return `${u.origin}${u.pathname}`.toLowerCase()}catch{return String(t?.url||'').toLowerCase()}}
async function sendRescanWhenReady(t,settings){if(!t?.id)return false;const deadline=Date.now()+Math.max(10000,Math.min(30000,(Number(settings.maxSeconds)||45)*1000));while(Date.now()<deadline){try{const r=await browser.tabs.sendMessage(t.id,{type:'rescan',settings});if(r?.ok)return true}catch{}await sleep(250)}return false}
async function refresh(scan=true){
 if(coAppUpdating){$('statusText').textContent=`CoApp更新中… ${coAppUpdateTarget?`(${coAppUpdateTarget})`:''}`;applyButtonState();return false;}
 displayCleared=false;
 const t=await active();
 tabId=t?.id;
 if(!t?.id)return;
 // The Update button always restores the complete internal list first. The
 // visible list is never used as the source of truth.
 // UI reads the authoritative internal list; identity and duplicate decisions are not made here.
 setInternalItems(await list());
 await syncDownloadState();
 await syncExistingFiles();
 await render(false);
 if(!scan)return;
 setBusy(true);
 $('statusText').textContent='検出中…';
 let started=false;
 try{started=await sendRescanWhenReady(t,settings)}catch{}
 if(!started){setBusy(false);$('statusText').textContent='ページの読み込み完了を待っています';await render(false);return}
 const end=Date.now()+Math.max(16000,settings.maxSeconds*1000);
 let lastSig='';
 while(Date.now()<end){
  setInternalItems(await list());
  const sig=internalItems.map(x=>`${x.id??''}|${x.itemId??''}|${x.mediaUrl??''}|${x.identityUrl??''}|${x.thumbnail??''}|${x.name??''}`).join('\n');
  if(sig!==lastSig){render(true);lastSig=sig}else $('count').textContent=`(${items.length})`;
  const st=await state();
  if(!st.busy)break;
  await sleep(250);
 }
 setInternalItems(await list());
 await syncDownloadState();
 await syncExistingFiles();
 setBusy(false);
 await render(false);
}
function key(x){return x?.key||(x?.itemId?String(x.itemId):`url:${x?.identityUrl||x?.mediaUrl||''}`)}
function showTransientSkip(k){
 skipNoticeKeys.add(k);
 clearTimeout(skipNoticeTimers.get(k));
 const timer=setTimeout(()=>{skipNoticeKeys.delete(k);skipNoticeTimers.delete(k);render(false).catch(()=>{})},1800);
 skipNoticeTimers.set(k,timer);
}
let liveDownloads=[];
const playBusyKeys=new Set();
function downloadAssetKey(u){try{const x=new URL(String(u||''));x.hash='';for(const k of [...x.searchParams.keys()])if(/^(token|sig|signature|expires|exp|auth|timestamp)$/i.test(k))x.searchParams.delete(k);const pairs=[...x.searchParams.entries()].sort((a,b)=>a[0].localeCompare(b[0])||a[1].localeCompare(b[1]));x.search='';for(const [k,v] of pairs)x.searchParams.append(k,v);return x.href}catch{return String(u||'').replace(/#.*$/,'')}}
function liveForItem(x){
 const id=x?.itemId!=null?String(x.itemId):'';
 const u=downloadAssetKey(x?.mediaUrl||'');
 const iu=downloadAssetKey(x?.identityUrl||'');
 const matches=liveDownloads.filter(j=>(id&&j?.itemId!=null&&String(j.itemId)===id)||(u&&downloadAssetKey(j?.mediaUrl||'')===u)||(iu&&downloadAssetKey(j?.identityUrl||'')===iu));
 matches.sort((a,b)=>(Number(b?.updatedAt)||0)-(Number(a?.updatedAt)||0)||(Number(b?.createdAt)||0)-(Number(a?.createdAt)||0));
 return matches[0]||null;
}
function toggle(k){selected.has(k)?selected.delete(k):selected.add(k);updateSelectionStyles()}
async function history(){return(await browser.runtime.sendMessage({type:'history'}))||{}}
async function getBatchState(batchId=''){try{const jobs=await browser.runtime.sendMessage({type:'downloads'});if(!Array.isArray(jobs)||!batchId)return null;const list=jobs.filter(j=>j?.batchId&&String(j.batchId)===String(batchId));if(!list.length)return null;const active=list.some(j=>['queued','starting','downloading'].includes(j.status));const processed=list.filter(j=>['completed','exist','failed','cancelled','missing'].includes(j.status)).length;const startedAt=Math.min(...list.map(j=>Number(j.createdAt)||Date.now()));return {batchId:String(batchId),items:list,total:list.length,processed,active,startedAt}}catch{return null}}
async function setBatchState(id){currentBatchId=String(id||'');batchBusy=!!currentBatchId;applyButtonState();return true}
async function clearBatchState(){currentBatchId='';batchBusy=false;applyButtonState();$('downloadProgress').textContent=''}
function batchItemKey(x){return key(x)}
async function updateBatchProgress(){const st=await getBatchState(currentBatchId);if(!st){batchBusy=false;applyButtonState();$('downloadProgress').textContent='';return false}batchBusy=!!st.active;applyButtonState();const total=Number(st.total)||0,processed=Number(st.processed)||0;const progressBox=$('downloadProgress');progressBox.replaceChildren();const count=document.createElement('span');count.className='batch-count';count.textContent=`${processed}/${total}`;const bar=document.createElement('div');bar.className='batch-progress';const percent=total?Math.round(processed*100/total):0;bar.setAttribute('role','progressbar');bar.setAttribute('aria-valuemin','0');bar.setAttribute('aria-valuemax','100');bar.setAttribute('aria-valuenow',String(percent));const fill=document.createElement('div');fill.style.width=`${percent}%`;bar.appendChild(fill);progressBox.append(count,bar);return true}
function esc(s){return String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function createDownloadStatusNode(kind, progress, playBusy, oldPlay=null) {
 const fragment=document.createDocumentFragment();
 if(kind==='active'){
  const state=document.createElement('div');state.className='download-state';
  const bar=document.createElement('div');bar.className='progress';const fill=document.createElement('div');fill.style.width=`${progress}%`;bar.appendChild(fill);
  const actions=document.createElement('div');actions.className='download-actions';const percent=document.createElement('span');percent.textContent=`${progress}%`;const cancel=document.createElement('button');cancel.className='cancelDownload';cancel.type='button';cancel.textContent='キャンセル';actions.append(percent,cancel);state.append(bar,actions);fragment.appendChild(state);
 }else if(kind==='done'||kind==='duplicate'){
  const done=document.createElement('div');done.className='done';done.textContent=kind==='duplicate'?'ダウンロードスキップ（既存ファイル）':'ダウンロード済み';fragment.appendChild(done);
  const actions=document.createElement('div');actions.className='actions';const folder=document.createElement('button');folder.className='openFolder';folder.textContent='ダウンロード先フォルダを開く';const play=oldPlay||document.createElement('button');play.className='playFile';play.type='button';play.dataset.uvdAction='playFile';play.textContent='動画を再生';if(playBusy){play.disabled=true;play.textContent='再生要求中…';}actions.append(folder,play);fragment.appendChild(actions);
 }else if(kind==='missing'){const error=document.createElement('div');error.className='error';error.textContent='ダウンロード済みファイルが見つかりません。再ダウンロードできます。';fragment.appendChild(error);const actions=document.createElement('div');actions.className='actions';const button=document.createElement('button');button.className='downloadOne';button.textContent='ダウンロード';actions.appendChild(button);fragment.appendChild(actions);
 }else if(kind==='failed'||kind==='cancelled'){const error=document.createElement('div');error.className='error';error.textContent=kind==='cancelled'?'キャンセルしました':'ダウンロードに失敗しました';fragment.appendChild(error);const actions=document.createElement('div');actions.className='actions';const button=document.createElement('button');button.className='downloadOne';button.textContent='ダウンロード';actions.appendChild(button);fragment.appendChild(actions);
 }else{const actions=document.createElement('div');actions.className='actions';const button=document.createElement('button');button.className='downloadOne';button.textContent='ダウンロード';actions.appendChild(button);fragment.appendChild(actions);}
 return fragment;
}
let renderGeneration=0;
async function render(scanning=false){
 const generation=++renderGeneration;
 if(displayCleared){$('count').textContent='(0)';$('statusText').textContent='動画リソースがまだ検出されていません';$('downloadProgress').textContent=batchBusy?'0/0':'';$('list').replaceChildren();selected.clear();applyButtonState();return}
 const visibleItems=items.filter(x=>adFilterDisplayAllowed(x,settings));
 $('count').textContent=`(${visibleItems.length}${visibleItems.length!==items.length?`/${items.length}`:''})`;
 $('statusText').textContent=scanning?'検出中…':items.length?`${visibleItems.length}件表示 / ${items.length}件検出`:'動画リソースがまだ検出されていません';
 applyButtonState();
 selected=new Set([...selected].filter(k=>visibleItems.some(x=>key(x)===k)));
 const existing=new Map([...$('list').querySelectorAll('.row')].map(r=>[r.dataset.key,r]));
 const seen=new Set();
 const snapshot=visibleItems.slice();
 const chunkSize=12;
 for(let offset=0;offset<snapshot.length;offset+=chunkSize){
  if(generation!==renderGeneration)return;
  const limit=Math.min(offset+chunkSize,snapshot.length);
  for(let i=offset;i<limit;i++){
   const x=snapshot[i],k=key(x);seen.add(k);const live=liveForItem(x);
   const terminal=!!live&&(live.status==='completed'||live.status==='exist');
   const active=!terminal&&live&&['queued','starting','downloading'].includes(live.status);
   const completed=live?.status==='completed',duplicate=live?.status==='exist';
   const playBusy=playBusyKeys.has(k);
   if(duplicate&&!skipNoticeKeys.has(k)&&!skipNoticeTimers.has(k)&&typeof showTransientSkip==='function')showTransientSkip(k);
   const showSkipNotice=duplicate&&skipNoticeKeys.has(k),locked=active||completed||duplicate||downloadingKeys.has(k);
   let d=existing.get(k),el,cb,thumb,meta;
   if(!d){
    d=document.createElement('div');d.className='row';d.style.contentVisibility='auto';d.style.containIntrinsicSize='110px';d.dataset.key=k;
    el=document.createElement('div');el.className='item';
    const check=document.createElement('div');check.className='check';
    cb=document.createElement('input');cb.type='checkbox';cb.setAttribute('aria-label','選択');check.appendChild(cb);
    thumb=document.createElement('div');thumb.className='thumb';
    meta=document.createElement('div');meta.className='meta';
    el.append(check,thumb,meta);d.appendChild(el);$('list').appendChild(d);
   }else{el=d.querySelector('.item');cb=d.querySelector('input');thumb=d.querySelector('.thumb');meta=d.querySelector('.meta');}
   if(!el||!cb||!thumb||!meta)continue;
   el.dataset.locked=locked?'1':'0';
   cb.disabled=locked;cb.checked=!locked&&selected.has(k);
   el.classList.toggle('selected',selected.has(k));
   // Never replace/detach the thumbnail node during a normal list refresh.
   // syncDownloadState() refreshes this view frequently; replacing the thumb
   // caused pointerenter/leave churn and preview blinking.
   const thumbImage=thumb.querySelector('img');
   if(settings.previewMode==='none'){
    if(thumbImage)thumbImage.remove();
   }else if(x.thumbnail){
    let img=thumbImage;
    if(!img){img=document.createElement('img');thumb.insertBefore(img,thumb.firstChild)}
    const src=String(x.thumbnail);if(img.getAttribute('src')!==src)img.src=src;
   }else if(thumbImage)thumbImage.remove();
   if(settings.previewMode!=='none'&&!x.thumbnail&&!thumb.querySelector('video'))thumb.dataset.uvdPlaceholder='1';
   const progress=active&&live?Math.max(0,Math.min(100,Number(live.progress)||0)):0;
   const path=live?.path||'';const folder=live?.folder||'';
   let statusKind='default';
   if(active)statusKind='active';
   else if(duplicate)statusKind='duplicate';
   else if(completed)statusKind='done';
   else if(live?.status==='missing')statusKind='missing';
   else if(live?.status==='failed')statusKind='failed';
   else if(live?.status==='cancelled')statusKind='cancelled';
   else if(downloadingKeys.has(k))statusKind='active';
   const oldPlay=statusEl.querySelector('.playFile');
   statusEl.replaceChildren();
   const statusNode=createDownloadStatusNode(statusKind,progress,playBusy,oldPlay);
   statusEl.appendChild(statusNode);
   const currentPlay=statusEl.querySelector('.playFile');
   if(currentPlay){
    const sourcePlay=oldPlay||currentPlay;
    currentPlay.dataset.uvdAction='playFile';
    currentPlay.dataset.uvdPath=path||'';
    currentPlay.dataset.uvdJobId=live?.jobId||live?.id||'';
    if(sourcePlay!==currentPlay&&sourcePlay.dataset.uvdBusy==='1'){currentPlay.dataset.uvdBusy='1';currentPlay.disabled=true;currentPlay.textContent='再生要求中…';}
   }
   el.onclick=e=>{if(e.target.closest('button')||e.target.closest('input')||cb.disabled)return;toggle(k)};
   el.onkeydown=e=>{if((e.key==='Enter'||e.key===' ')&&!e.target.closest('button')&&!e.target.closest('input')&&!cb.disabled){e.preventDefault();toggle(k)}};
   cb.onchange=e=>{e.stopPropagation();if(cb.disabled)return;e.target.checked?selected.add(k):selected.delete(k);updateSelectionStyles()};
   d.querySelector('.downloadOne')?.addEventListener('click',e=>{e.stopPropagation();downloadItems([x],false)});
   d.querySelector('.cancelDownload')?.addEventListener('click',e=>{e.stopPropagation();cancelDownloadForItem(x)});
   d.querySelector('.openFolder')?.addEventListener('click',e=>{e.stopPropagation();nativeAction('openFolder',folder||path,live?.jobId||live?.id||'')});
   const playBtn=d.querySelector('.playFile');if(playBtn){playBtn.dataset.uvdAction='playFile';playBtn.dataset.uvdPath=path||'';playBtn.dataset.uvdJobId=live?.jobId||live?.id||'';}
   setupThumbPreview(thumb,x);
  }
  if(generation!==renderGeneration)return;
  await new Promise(resolve=>requestAnimationFrame(resolve));
 }
 if(generation!==renderGeneration)return;
 for(const [k,d] of existing)if(!seen.has(k))d.remove();
 updateSelectionStyles();
}
const PREVIEW_LOG_KEY='uvdPreviewLogs';
const PREVIEW_LOG_LIMIT=300;
const ERROR_LOG_KEY='uvdErrorLogs';
const ERROR_LOG_LIMIT=500;
const PREVIEW_ROOT_MARGIN='100px 0px';
const previewObserver=new IntersectionObserver(entries=>{for(const entry of entries){const thumb=entry.target;if(entry.isIntersecting){prepareThumbPreview(thumb,thumb.__uvdPreviewItem,false)}else if(!thumb.matches(':hover')){const v=thumb.querySelector('video');if(v){try{v.pause()}catch{};v.dataset.uvdPrepared='1'}}}}, {root:null,rootMargin:'100px 0px',threshold:0.01});
const previewLogQueue=[];
let previewLogFlushTimer=0;
function previewItemKey(x){return String(x?.itemId||x?.id||x?.mediaUrl||x?.identityUrl||'').trim()}
function previewLog(event,x,extra={}){
 const rec={ts:Date.now(),event,key:previewItemKey(x),name:String(x?.name||''),type:String(x?.type||''),url:String(x?.mediaUrl||''),...extra};
 console.debug('[UVD preview]',rec);
 previewLogQueue.push(rec);
 if(previewLogQueue.length>20)previewLogQueue.splice(0,previewLogQueue.length-20);
 if(!previewLogFlushTimer)previewLogFlushTimer=setTimeout(flushPreviewLogs,50);
}
async function flushPreviewLogs(){previewLogFlushTimer=0;if(!previewLogQueue.length)return;const batch=previewLogQueue.splice(0);try{const r=await browser.storage.local.get(PREVIEW_LOG_KEY);const logs=Array.isArray(r[PREVIEW_LOG_KEY])?r[PREVIEW_LOG_KEY]:[];logs.push(...batch);if(logs.length>PREVIEW_LOG_LIMIT)logs.splice(0,logs.length-PREVIEW_LOG_LIMIT);await browser.storage.local.set({[PREVIEW_LOG_KEY]:logs})}catch(e){console.error('UVD preview log persistence failed',e)}}
async function getPreviewLogs(){try{const r=await browser.storage.local.get(PREVIEW_LOG_KEY);return Array.isArray(r[PREVIEW_LOG_KEY])?r[PREVIEW_LOG_KEY]:[]}catch(e){console.error('UVD preview log read failed',e);return[]}}
async function clearPreviewLogs(){try{await browser.storage.local.remove([PREVIEW_LOG_KEY,ERROR_LOG_KEY]);return true}catch(e){console.error('UVD preview log clear failed',e);return false}}
function isPreviewableVideo(x){if(!x?.mediaUrl)return false;const type=String(x.type||'').toLowerCase();if(['hls','dash'].includes(type))return false;try{const u=new URL(x.mediaUrl);if(!['http:','https:','blob:'].includes(u.protocol))return false}catch{return false}return true}
function previewErrorInfo(v){const e=v?.error;return {mediaErrorCode:e?.code??null,mediaErrorMessage:e?.message||'',networkState:v?.networkState??null,readyState:v?.readyState??null,currentSrc:String(v?.currentSrc||''),paused:!!v?.paused}}
function showPreviewVideo(thumb,v){if(!v||!thumb)return;v.classList.add('uvd-preview-ready');v.style.opacity='1';const img=thumb.querySelector('img');if(img)img.style.opacity='0'}
function hidePreviewVideo(thumb,v){if(!v||!thumb)return;v.style.opacity='0';const img=thumb.querySelector('img');if(img)img.style.opacity='1'}
function prepareThumbPreview(thumb,x,forHover=false){
 if(!thumb||!isPreviewableVideo(x)||settings.previewMode!=='video')return null;
 let v=thumb.querySelector('video');
 if(!v){
  v=document.createElement('video');v.className='uvd-preview-video';v.muted=true;v.defaultMuted=true;v.autoplay=false;v.loop=true;v.playsInline=true;v.preload=forHover?'auto':'metadata';v.controls=false;v.disablePictureInPicture=true;v.setAttribute('aria-hidden','true');v.style.opacity='0';v.dataset.uvdPreviewUrl=String(x.mediaUrl);thumb.appendChild(v);
  const log=(event,extra={})=>previewLog(event,x,extra);
  v.addEventListener('loadstart',()=>log('LOADSTART',{readyState:v.readyState,networkState:v.networkState}),{once:false});
  v.addEventListener('loadedmetadata',()=>log('LOADED_METADATA',{duration:Number.isFinite(v.duration)?v.duration:null,readyState:v.readyState,networkState:v.networkState}),{once:false});
  v.addEventListener('loadeddata',()=>log('LOADED_DATA',{readyState:v.readyState,networkState:v.networkState}),{once:false});
  v.addEventListener('canplay',()=>log('CANPLAY',{readyState:v.readyState,networkState:v.networkState}),{once:false});
  v.addEventListener('playing',()=>log('PLAYING',{currentTime:v.currentTime,readyState:v.readyState}),{once:false});
  v.addEventListener('pause',()=>log('PAUSE',{currentTime:v.currentTime}),{once:false});
  v.addEventListener('stalled',()=>log('STALLED',previewErrorInfo(v)),{once:false});
  v.addEventListener('waiting',()=>log('WAITING',previewErrorInfo(v)),{once:false});
  v.addEventListener('suspend',()=>log('SUSPEND',previewErrorInfo(v)),{once:false});
  v.addEventListener('error',()=>{const info=previewErrorInfo(v);log('ERROR',info);v.dataset.uvdPreviewError=JSON.stringify(info);hidePreviewVideo(thumb,v)},{once:false});
  v.addEventListener('abort',()=>log('ABORT',previewErrorInfo(v)),{once:false});
 }
 const url=String(x.mediaUrl);
 if(v.dataset.uvdPreviewUrl!==url){v.dataset.uvdPreviewUrl=url;v.src=url;logPreviewSrcSet(x,url)}
 if(forHover)v.preload='auto';
 return v;
}
function logPreviewSrcSet(x,url){previewLog('SRC_SET',x,{url})}
async function playThumbPreview(thumb,x){
 if(settings.previewMode!=='video'||!isPreviewableVideo(x))return;
 const v=prepareThumbPreview(thumb,x,true);if(!v)return;
 previewLog('HOVER_ENTER',x,{readyState:v.readyState,networkState:v.networkState,currentSrc:String(v.currentSrc||'')});
 try{if(v.readyState===0)v.load();}catch(e){previewLog('LOAD_CALL_ERROR',x,{error:e?.message||String(e)})}
 try{if(v.readyState>=2){v.currentTime=0;showPreviewVideo(thumb,v)}const p=v.play();if(p&&typeof p.then==='function')await p;showPreviewVideo(thumb,v);previewLog('PLAY_RESOLVED',x,{readyState:v.readyState,currentTime:v.currentTime})}
 catch(e){const info=previewErrorInfo(v);previewLog('PLAY_REJECTED',x,{error:e?.message||String(e),name:e?.name||'',...info});hidePreviewVideo(thumb,v)}
}
function setupThumbPreview(thumb,x){
 if(!thumb)return;
 const previewable=settings.previewMode==='video'&&isPreviewableVideo(x);
 thumb.__uvdPreviewItem=x;
 if(!previewable){
  clearTimeout(thumb.__uvdHoverTimer);
  thumb.dataset.uvdHover='0';
  try{previewObserver.unobserve(thumb)}catch{}
  const oldVideo=thumb.querySelector('video');
  if(oldVideo){try{oldVideo.pause()}catch{};oldVideo.remove()}
  thumb.onmouseenter=null;
  thumb.onmouseleave=null;
  return;
 }
 // Do not create/load a video element during list rendering. The preview
 // resource is prepared only when the item enters the viewport or is hovered.
 try{previewObserver.observe(thumb)}catch(e){previewLog('OBSERVER_ERROR',x,{error:e?.message||String(e)})}
 if(thumb.dataset.uvdPreviewHandlers==='1')return;
 thumb.dataset.uvdPreviewHandlers='1';
 thumb.onmouseenter=()=>{if(thumb.dataset.uvdHover==='1')return;thumb.dataset.uvdHover='1';previewLog('HOVER_SCHEDULED',thumb.__uvdPreviewItem);clearTimeout(thumb.__uvdHoverTimer);thumb.__uvdHoverTimer=setTimeout(()=>{if(thumb.dataset.uvdHover==='1')playThumbPreview(thumb,thumb.__uvdPreviewItem)},120)};
 thumb.onmouseleave=()=>{thumb.dataset.uvdHover='0';clearTimeout(thumb.__uvdHoverTimer);const current=thumb.__uvdPreviewItem;const v=thumb.querySelector('video');if(v){try{v.pause();v.currentTime=0}catch(e){previewLog('RESET_ERROR',current,{error:e?.message||String(e)})}hidePreviewVideo(thumb,v);previewLog('HOVER_LEAVE',current,{readyState:v.readyState,networkState:v.networkState})}};
}
async function refreshPreviewLogPanel(){const box=$('previewLogOutput');if(!box)return;try{const r=await browser.storage.local.get(ERROR_LOG_KEY);const logs=Array.isArray(r[ERROR_LOG_KEY])?r[ERROR_LOG_KEY].slice(-ERROR_LOG_LIMIT):[];box.value=logs.map(x=>`${new Date(x.ts).toISOString()} [${x.source||'-'}] ${x.context||'-'}\n${x.message||'-'}\nURL: ${x.pageUrl||'-'}\n${x.filename?`FILE: ${x.filename}:${x.line||0}:${x.column||0}`:''}`).join('\n\n')||'エラーログはありません。';box.scrollTop=box.scrollHeight;if($('previewLogStatus'))$('previewLogStatus').textContent=`エラーログ: ${logs.length}件 / 最大${ERROR_LOG_LIMIT}件`;}catch(e){box.value=`エラーログの読み込みに失敗しました: ${e?.message||String(e)}`;if($('previewLogStatus'))$('previewLogStatus').textContent='エラーログ: 読み込み失敗';}}

async function chooseRoot(){
 try{
  const r=await browser.runtime.sendMessage({type:'chooseFolder'});
  if(r?.ok&&r.path){
   const path=String(r.path);
   const el=$('downloadRoot');
   if(el){el.value=path;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}
   settings.downloadRoot=path;
   await saveSettings();
   return;
  }
  alert('保存先フォルダーを選択できませんでした.\n'+(r?.error||'原因不明'));
 }catch(e){alert('保存先フォルダーを選択できませんでした.\n'+(e?.message||e))}
}
async function nativeAction(type,path,jobId='',button=null,extra={}){
  const label=type==='openFolder'?'フォルダーを開けませんでした。':'動画を再生できませんでした。';
  const target=String(path||'').trim();
  const isPlay=type==='playFile';
  const originalText=isPlay&&button?button.textContent:'再生';
  if(isPlay&&button){
    if(button.dataset.uvdBusy==='1')return {ok:false,duplicateRequest:true};
    button.dataset.uvdBusy='1';button.disabled=true;
    button.replaceChildren();const spinner=document.createElement('span');spinner.className='uvd-button-spinner';spinner.setAttribute('aria-hidden','true');const label=document.createElement('span');label.textContent='再生要求中…';button.append(spinner,label);
  }
  try{
    // The request itself is the single in-flight operation. Do not race it with a UI timeout:
    // a timeout would release the busy state while Native Messaging could still be executing.
    const r=await browser.runtime.sendMessage({type,jobId:String(jobId||''),path:target,itemId:extra.itemId||'',mediaUrl:extra.mediaUrl||'',identityUrl:extra.identityUrl||''});
    if(!r?.ok)throw new Error(r?.error||'CoAppが再生要求を処理できませんでした。');
    if(isPlay&&!r?.playbackConfirmed)throw new Error('CoAppから再生確認を受け取れませんでした。');
    if(type==='openFolder'&&!r?.ok)throw new Error(r?.error||'CoAppがフォルダーを開けませんでした。');
    return r;
  }catch(e){
    alert(label+'\n'+(e?.message||String(e)));
    throw e;
  }finally{
    if(isPlay&&button){
      button.dataset.uvdBusy='0';button.disabled=false;button.textContent=originalText||'動画を再生';
    }
  }
}

function updateSelectionStyles(){for(const d of $('list').querySelectorAll('.row')){const k=d.dataset.key,sel=selected.has(k);d.querySelector('.item')?.classList.toggle('selected',sel);const cb=d.querySelector('input');if(cb){cb.checked=sel;if(d.querySelector('.item')?.dataset.locked==='1')cb.disabled=true}}applyButtonState()}
async function cancelDownloadForItem(item){const j=liveForItem(item);if(!j?.id)return;const r=await browser.runtime.sendMessage({type:'cancelDownloads',jobIds:[j.id]});if(!r?.ok)alert('キャンセル要求を送信できませんでした。');else await syncDownloadState()}
async function cancelBatch(){const st=await getBatchState(currentBatchId);if(!st?.active)return;const ids=st.items.filter(j=>['queued','starting','downloading'].includes(j.status)).map(j=>j.id);if(ids.length)await browser.runtime.sendMessage({type:'cancelDownloads',jobIds:ids});await syncDownloadState();await updateBatchProgress();await render(false)}
async function prepareDownloadItems(list){
 const source=Array.isArray(list)?list:[];
 const pageUrl=source.find(x=>x?.pageUrl)?.pageUrl||source.find(x=>x?.landingPage)?.landingPage||'';
 const pageTitle=source.find(x=>x?.pageTitle)?.pageTitle||'';
 // Download-time preparation must not re-read or re-parse the active page.
 // All page/video information comes from the persistent internal detection list.
 return source.map(x=>({...x,pageUrl:x.pageUrl||pageUrl,referer:x.referer||x.pageUrl||pageUrl,userAgent:x.userAgent||navigator.userAgent,pageTitle:x.pageTitle||pageTitle}));
}
async function syncExistingFiles(){
  try{
    if(!internalItems.length||!settings.downloadRoot)return;
    const prepared=await prepareDownloadItems(internalItems);
    const site=(()=>{try{const u=new URL(prepared[0]?.pageUrl||'');return{host:u.hostname||'unknown-site',origin:u.origin,title:prepared[0]?.pageTitle||''}}catch{return{host:'unknown-site',origin:'',title:prepared[0]?.pageTitle||''}}})();
    // The request asks CoApp to reconcile real files. UI does not manufacture
    // `exist` jobs; the authoritative state is read back from CoApp afterwards.
    const r=await browser.runtime.sendMessage({type:'checkExistingDownloads',items:prepared,site,settings,rootDirectory:settings.downloadRoot});
    if(!r?.ok)return;
    await syncDownloadState();
  }catch(e){console.error('UVD existing-file check failed',e)}
}

async function downloadItems(list,isBatch=false){
  if(!Array.isArray(list)||!list.length)return;
  if(isBatch&&batchBusy)return;
  if(!String(settings.downloadRoot||'').trim()){
    alert('保存先フォルダーが指定されていません。設定タブで保存先フォルダーを指定してください。');
    switchTab('settings');
    setTimeout(()=>{$('downloadRoot')?.focus();$('downloadRoot')?.select();},0);
    return;
  }
  try{
    const prepared=await prepareDownloadItems(list);
    if(!prepared.length)return;
    const site=(()=>{try{const u=new URL(prepared[0]?.pageUrl||'');return{host:u.hostname||'unknown-site',origin:u.origin,title:prepared[0]?.pageTitle||''}}catch{return{host:'unknown-site',origin:'',title:prepared[0]?.pageTitle||''}}})();
    const requestBatchId=isBatch?crypto.randomUUID():'';
    if(isBatch)await setBatchState(requestBatchId);
    const request={
      type:(isBatch||prepared.length>1)?'downloadBatch':'downloadOne',
      items:prepared,
      item:(isBatch||prepared.length>1)?undefined:prepared[0],
      settings,
      pageUrl:prepared[0]?.pageUrl||'',
      site,
      batchId:requestBatchId
    };
    // UI is transport/presentation only. Do not filter, normalize, deduplicate,
    // timeout, cancel, or decide download state here. CoApp is authoritative.
    const r=await browser.runtime.sendMessage(request);
    if(!r?.ok){
      if(isBatch)await clearBatchState();
      alert(r?.needsSettings?'保存先フォルダーを設定してください。':`ダウンロード要求に失敗しました。\n${r?.error||'原因不明'}`);
      return;
    }
    await syncDownloadState();
    await syncExistingFiles();
    if(isBatch)await updateBatchProgress();
    await render(false);
  }catch(e){
    if(isBatch)await clearBatchState();
    console.error('UVD download request failed',e);
    alert(`ダウンロード要求に失敗しました。\n${e?.message||String(e)}`);
  }
}

function showCoAppUpdateState(r){
 const box=$('coAppUpdateStatus'),btn=$('updateCoApp');if(!box||!btn)return;
 if(!r?.connected){box.textContent='CoApp更新確認: 接続できません';btn.disabled=true;return}
 const updateRequired=!!r.available&&compareVersions(r.coAppVersion||'0',r.desiredCoAppVersion||'0')<0;if(updateRequired){box.textContent=`更新あり: CoApp ${r.coAppVersion} → ${r.desiredCoAppVersion}`;btn.disabled=!!coAppUpdating||batchBusy||pendingUiAction==='startupCoAppUpdate';return}
 box.textContent=`CoApp ${r.coAppVersion||'不明'} / 必要なCoApp ${r.desiredCoAppVersion||'不明'}（更新不要）`;btn.disabled=true;
}
function normalizeComparableVersion(value){const parts=String(value||'0').trim().split('.').map(x=>Number.parseInt(x,10)||0);return parts.length===2?[0,parts[0],parts[1]]:parts}
function compareVersions(a,b){const pa=normalizeComparableVersion(a),pb=normalizeComparableVersion(b);for(let i=0;i<Math.max(pa.length,pb.length);i++){const x=pa[i]||0,y=pb[i]||0;if(x!==y)return x-y}return 0}
async function verifyCoAppUpdate(targetVersion){
  // Native Messaging must be allowed to drop the old host and launch a fresh process.
  // Do not treat the first stale ping as update failure. Poll through the full restart window.
  let lastState=coAppUpdateState;
  for(let i=0;i<30;i++){
    await sleep(1000);
    const state=await refreshCoAppUpdateState(false);
    lastState=state||lastState;
    if(state?.connected&&compareVersions(state.coAppVersion||'0',targetVersion||'0')>=0)return state;
  }
  return lastState;
}
async function reconnectCoAppAfterUpdate(targetVersion){
  // A successful updater response is not itself the Native Messaging
  // connection proof. Re-open the connection explicitly through the background
  // ping and require the target version in that fresh response.
  const r=await browser.runtime.sendMessage({type:'companionPing'});
  if(!r?.ok)throw new Error(r?.error||'更新後のCoApp接続に失敗しました。');
  const version=String(r.version||'');
  if(!version||compareVersions(version,targetVersion||'0')<0)throw new Error(`更新後のCoAppバージョン確認に失敗しました。現在: ${version||'不明'} / 必要: ${targetVersion}`);
  const state=await refreshCoAppUpdateState(false);
  if(!state?.connected||compareVersions(state.coAppVersion||'0',targetVersion||'0')<0)throw new Error('更新後のCoApp接続状態を確認できませんでした。');
  return state;
}
async function updateCoApp(startupGate=false){
 if(!startupGate)await syncDownloadState();
 coAppUpdating=true;
  const btn=$('updateCoApp'),dialogOk=$('uvdDialogOk');if(btn)btn.disabled=true;if(dialogOk)dialogOk.disabled=true;applyButtonState();
 try{
  const target=coAppUpdateState?.desiredCoAppVersion||await getBundledCoAppVersion();
  const current=String(coAppUpdateState?.coAppVersion||'').trim();
  if(/^\d+\.\d+$/.test(current)&&compareVersions(current,target)<0){
   coAppUpdating=false;coAppUpdateTarget='';applyButtonState();
   const message=`現在のCoApp (${current}) は旧形式のバージョンです。\n\nこの旧バイナリ自身には新しいバージョン比較・更新処理がないため、拡張機能からの自動更新では置換できません。\ncompanion\\setup-coapp.ps1 を実行し、現在のCoAppと同じインストール先を更新してください。\n\nセットアップ完了後にFirefoxを再起動すると、${target}として認識されます。`;
   if($('coAppUpdateStatus'))$('coAppUpdateStatus').textContent='旧形式CoAppのため再セットアップが必要です';
   alert(message);
   return;
  }
  const r=await browser.runtime.sendMessage({type:'updateCoApp'});
  if(r?.ok){
   coAppUpdating=true;coAppUpdateTarget=target;switchTab('settings');applyButtonState();
   if($('coAppUpdateStatus'))$('coAppUpdateStatus').textContent='CoApp更新を開始しました。更新完了を確認しています。';
   const verified=await verifyCoAppUpdate(target);
   if(verified?.connected&&compareVersions(verified.coAppVersion||'0',target||'0')>=0){
    coAppUpdateState={...(verified||{}),available:false,updating:false,updateTargetVersion:''};
    coAppUpdating=false;coAppUpdateTarget='';
    if($('coAppUpdateStatus'))$('coAppUpdateStatus').textContent=`CoApp ${verified.coAppVersion} / 必要なCoApp ${target}（更新不要）`;
   }else{
    showCoAppUpdateState(verified||coAppUpdateState);
    alert('CoAppの更新完了を確認できませんでした。\n現在のCoApp: '+(verified?.coAppVersion||'不明')+'\n必要なCoApp: '+target+'\nFirefoxを完全終了して再起動した後、再度確認してください。');
   }
  }else{coAppUpdating=false;applyButtonState();alert('CoAppの更新を開始できませんでした。\n'+(r?.error||'原因不明'));await refreshCoAppUpdateState(false);}
 }catch(e){coAppUpdating=false;coAppUpdateTarget='';applyButtonState();alert('CoAppの更新を開始できませんでした。\n'+e.message);await refreshCoAppUpdateState(false)}
 finally{
  const state=await refreshCoAppUpdateState(false);
  if(state?.connected&&state.desiredCoAppVersion&&state.coAppVersion&&compareVersions(state.coAppVersion,state.desiredCoAppVersion)>=0){coAppUpdating=false;coAppUpdateTarget='';}
  applyButtonState();
  showCoAppUpdateState(state||coAppUpdateState);
 }
}
async function install(){
 try{
  const r=await browser.runtime.sendMessage({type:'companionPing',settings});
  const box=$('companionStatus');
  if(r?.ok){
   if(r.path){settings.companionPath=r.path;if($('companionPath'))$('companionPath').value=r.path}
   const desired=String(coAppUpdateState?.desiredCoAppVersion||await getBundledCoAppVersion()).trim();
   const current=String(r.version||'').trim();
   const available=!!desired&&!!current&&compareVersions(current,desired)<0;
   coAppUpdateState={...(coAppUpdateState||{}),checkedAt:Date.now(),extensionVersion:browser.runtime.getManifest().version,desiredCoAppVersion:desired,coAppVersion:current,available,connected:true,error:'',updating:false,updateTargetVersion:''};
   coAppUpdating=false;coAppUpdateTarget='';
   showCompanionStatus(r);
   showCoAppUpdateState(coAppUpdateState);
   applyButtonState();
   pendingUiAction='connectionCheck';
   showUiDialog('接続確認','コンパニオンは登録済みで、Native Messaging接続も成功しました。');
  }else{
   if(box)box.textContent='Native Messaging 未接続: '+(r?.error||'原因不明');
   alert('Native Messagingに接続できません。\n\n'+(r?.error||'エラー内容を取得できませんでした')+'\n\nsetup-coapp.ps1で登録した後、Firefoxを完全終了して再起動してください。');
  }
 }catch(e){
  if($('companionStatus'))$('companionStatus').textContent='Native Messaging 未接続: '+e;
  alert('コンパニオンへ接続できません。\n'+e);
 }
}
function setUvdUpdateStatus(text){const el=$('uvdUpdateStatus');if(el)el.textContent=text}
function isFormalUvdVersion(value){return /^\d+\.\d+\.\d+$/.test(String(value||'').trim())}
function compareFormalUvdVersions(a,b){const pa=String(a||'').trim().split('.').map(Number),pb=String(b||'').trim().split('.').map(Number);if(pa.length!==3||pb.length!==3)return null;for(let i=0;i<3;i++){if(pa[i]!==pb[i])return pa[i]-pb[i]}return 0}
async function checkUvdUpdate(showDialog=false){
 try{
  const url=String(globalThis.UVD_UPDATE_CONFIG?.manifestUrl||'').trim();
  const current=String(browser.runtime.getManifest().version||'').trim();
  if(!isFormalUvdVersion(current))throw new Error(`現在のUVDバージョンが正式形式ではありません: ${current||'不明'}`);
  if(!url){setUvdUpdateStatus(`更新情報取得先が未設定（現在 ${current}）`);return{ok:false,configured:false,currentVersion:current,error:'Update manifest URL is not configured.'};}
  setUvdUpdateStatus('更新情報を確認しています…');
  const r=await browser.runtime.sendMessage({type:'checkUvdUpdate',url});
  if(!r?.ok)throw new Error(r?.error||'更新情報を取得できませんでした。');
  if(r.updateAvailable){
   const required=r.required===true?' / 必須更新':'';
   setUvdUpdateStatus(`新しいUVD ${r.version}があります${required}（現在 ${current}）`);
   if(showDialog)showUiDialog('UVD更新があります',`現在のUVDは ${current} です。最新版は ${r.version} です。\n\nUpdate Phase 1では更新情報の取得のみ行います。自動取得・更新は次のPhaseで実装します。`);
  }else setUvdUpdateStatus(`UVDは最新版です（${current}）`);
  return r;
 }catch(e){
  const message=e?.message||String(e);setUvdUpdateStatus(`更新情報確認失敗: ${message}`);return{ok:false,error:message};
 }
}
function showUiDialog(title,message){const modal=$('uvdDialog');if(!modal)return;const titleEl=$('uvdDialogTitle'),messageEl=$('uvdDialogMessage');if(titleEl)titleEl.textContent=title||'';if(messageEl)messageEl.textContent=message||'';modal.hidden=false;requestAnimationFrame(()=>$('uvdDialogOk')?.focus())}
function closeUiDialog(){const modal=$('uvdDialog');if(modal)modal.hidden=true;pendingUiAction=''}
async function confirmUiDialog(){
 const action=pendingUiAction;
 if(!action)return;
 if(action==='startupCoAppUpdate'){
  const ok=$('uvdDialogOk');if(ok)ok.disabled=true;
  pendingUiAction='';closeUiDialog();
  try{await updateCoApp(true)}finally{if(globalThis.__uvdStartupCoAppResolve){const r=globalThis.__uvdStartupCoAppResolve;globalThis.__uvdStartupCoAppResolve=null;r(true)}}
 }else{
  pendingUiAction='';
  if(action==='connectionCheck'){
   closeUiDialog();
   return;
  }
  closeUiDialog();
  if(action==='rescan')await refresh(true);else if(action==='coAppUpdate')await updateCoApp();
 }
}
function showCompanionStatus(r){const box=$('companionStatus');if(!box)return;const ext=browser.runtime.getManifest().version;const cv=r?.version||'';if(r?.ok){box.textContent=cv&&coAppUpdateState?.available?`CoApp接続済み: ${cv} / 必要なCoApp: ${coAppUpdateState.desiredCoAppVersion}（CoApp更新が必要）`:`CoApp接続済み: ${cv||'不明'} / UVD: ${ext}`}else box.textContent='CoApp未接続: '+(r?.error||'原因不明')}
function formatCompletedAt(ts){const d=new Date(Number(ts)||Date.now());const pad=n=>String(n).padStart(2,'0');return `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`}
async function deleteHistory(){if(batchBusy)return;if(!confirm('ダウンロード履歴を削除しますか？'))return;const r=await browser.runtime.sendMessage({type:'clearHistory'});if(r?.ok)await renderDownloads()}
async function deleteLogs(){if(batchBusy)return;if(!confirm('CoAppのログを削除しますか？'))return;const r=await browser.runtime.sendMessage({type:'clearLogs'});alert(r?.ok?'ログを削除しました。':'ログを削除できませんでした。')}
async function deleteHistoryLogs(){if(batchBusy)return;if(!confirm('ダウンロード履歴とCoAppのログを削除しますか？'))return;const r=await browser.runtime.sendMessage({type:'clearHistory'});const l=await browser.runtime.sendMessage({type:'clearLogs'});if(r?.ok&&l?.ok)await renderDownloads();else alert('削除できない項目がありました。')}
async function renderDownloads(){
 const j=await browser.runtime.sendMessage({type:'downloads'});
 const box=$('downloadList');box.replaceChildren();
 if(!j?.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='ダウンロードはありません';box.appendChild(empty);return;}
 for(const x of [...j].sort((a,b)=>(Number(b.completedAt)||0)-(Number(a.completedAt)||0))){
  const d=document.createElement('div');d.className='download-row';
  const top=document.createElement('div');top.className='top';const name=document.createElement('b');name.textContent=String(x.name||x.mediaUrl||'動画');const status=document.createElement('span');status.textContent=String(x.status||'待機中');top.append(name,status);d.appendChild(top);
  const path=document.createElement('div');path.className='muted';path.textContent=String(x.path||'');d.appendChild(path);
  if(x.error){const error=document.createElement('div');error.className='error';error.textContent=String(x.error);d.appendChild(error);}
  if(x.status==='completed'||x.status==='exist'){const done=document.createElement('div');done.className='done';done.textContent=x.status==='completed'?`${formatCompletedAt(x.completedAt)} に完了`:`${formatCompletedAt(x.completedAt)} に重複のためスキップ`;d.appendChild(done);}
  else if(x.status==='missing'||x.status==='failed'){const error=document.createElement('div');error.className='error';error.textContent=x.status==='missing'?'保存済みファイルが見つかりません':'失敗';d.appendChild(error);}
  else {const progress=document.createElement('div');progress.className='progress';const fill=document.createElement('div');const value=Math.max(0,Math.min(100,Number(x.progress)||0));fill.style.width=`${value}%`;progress.appendChild(fill);d.appendChild(progress);}
  if((x.status==='completed'||x.status==='exist')&&x.path){const actions=document.createElement('div');actions.className='actions';const open=document.createElement('button');open.className='downloadOpenFolder';open.type='button';open.textContent='ダウンロード先フォルダを開く';const play=document.createElement('button');play.className='downloadPlay';play.type='button';play.dataset.uvdAction='playFile';play.textContent='動画を再生';actions.append(open,play);d.appendChild(actions);open.addEventListener('click',e=>{e.stopPropagation();nativeAction('openFolder',x.folder||x.path,x.jobId||x.id||'')});play.dataset.uvdPath=x.path||'';play.dataset.uvdJobId=x.jobId||x.id||'';}
  box.appendChild(d);
 }
}

let lastDownloadSignature='';
async function syncDownloadState(){if(coAppUpdating)return;try{const r=await browser.runtime.sendMessage({type:'downloads'});if(!Array.isArray(r))return;liveDownloads=r;const activeBatch=!!currentBatchId&&r.some(x=>String(x?.batchId||'')===String(currentBatchId)&&['queued','starting','downloading'].includes(x.status));if(activeBatch!==batchBusy){batchBusy=activeBatch;applyButtonState();} const liveActive=new Set();for(const x of r){if(!['queued','starting','downloading'].includes(x?.status))continue;for(const item of items){const sameId=item?.itemId!=null&&x?.itemId!=null&&String(item.itemId)===String(x.itemId);const sameUrl=item?.mediaUrl&&x?.mediaUrl&&downloadAssetKey(item.mediaUrl)===downloadAssetKey(x.mediaUrl);const sameIdentity=item?.identityUrl&&x?.identityUrl&&downloadAssetKey(item.identityUrl)===downloadAssetKey(x.identityUrl);if(sameId||sameUrl||sameIdentity)liveActive.add(key(item));}}if(downloadingKeys.size){for(const k of [...downloadingKeys])if(!liveActive.has(k)){const x=items.find(v=>key(v)===k);if(!x)continue;const j=liveForItem(x);if(!j||['completed','exist','failed','cancelled'].includes(j.status))downloadingKeys.delete(k);}}const sig=JSON.stringify(r.map(x=>[x.id,x.itemId,x.mediaUrl,x.status,x.progress,x.path,x.error]));if(sig!==lastDownloadSignature){lastDownloadSignature=sig;if(items.length&&!displayCleared)await render(false);else await renderDownloads()}}catch{}}
function switchTab(name){if(coAppUpdating&&name!=='settings')name='settings';document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));$(`${name==='videos'?'videos':name==='downloads'?'downloads':'settings'}Panel`).classList.add('active');$('videoTools').style.display=name==='videos'?'flex':'none';if(name==='downloads')renderDownloads()}
document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>switchTab(b.dataset.tab));
function bindPlayDelegation(root){
 if(!root||root.dataset.uvdPlayBound==='1')return;root.dataset.uvdPlayBound='1';
 root.addEventListener('click',e=>{const b=e.target?.closest?.('button[data-uvd-action="playFile"]');if(!b||!root.contains(b))return;e.preventDefault();e.stopPropagation();const row=b.closest('.row,.download-row');const k=row?.dataset?.key||b.dataset.uvdJobId||b.dataset.uvdPath||'';if(!k||playBusyKeys.has(k))return;playBusyKeys.add(k);b.dataset.uvdBusy='1';b.disabled=true;b.replaceChildren();const spinner=document.createElement('span');spinner.className='uvd-button-spinner';spinner.setAttribute('aria-hidden','true');const label=document.createElement('span');label.textContent='再生要求中…';b.append(spinner,label);const item=items.find(v=>key(v)===k);const jobId=String(b.dataset.uvdJobId||'');const path=String(b.dataset.uvdPath||'');Promise.resolve(nativeAction('playFile',path,jobId,b,{itemId:item?.itemId||'',mediaUrl:item?.mediaUrl||'',identityUrl:item?.identityUrl||''})).catch(()=>{}).finally(()=>{playBusyKeys.delete(k);if(b.isConnected){b.dataset.uvdBusy='0';b.disabled=false;b.textContent='動画を再生';}});});
}

bindPlayDelegation($('list'));bindPlayDelegation($('downloadList'));
$('refresh').onclick=async()=>{if(busy||coAppUpdating)return;await refresh(true);};
$('selectedDownload').onclick=async()=>{const chosen=items.filter(x=>selected.has(key(x)));await downloadItems(chosen,false)};
$('batch').onclick=async()=>{const target=getVisibleVideoItems();if(!target.length||batchBusy)return;await downloadItems(target,true)};
$('batchCancel').onclick=async()=>{if(batchBusy)await cancelBatch()};
$('clear').onclick=async()=>{selected.clear();displayCleared=true;await browser.runtime.sendMessage({type:'clear',tabId});await render(false)};
$('chooseRoot').onclick=chooseRoot;$('installCompanion').onclick=install;$('uvdDialogOk').onclick=confirmUiDialog;$('uvdDialog')?.addEventListener('click',e=>{if(e.target?.dataset?.uvdDialogClose==='1')closeUiDialog()});$('checkCoAppUpdate').onclick=()=>refreshCoAppUpdateState(false);$('updateCoApp').onclick=updateCoApp;$('checkUvdUpdate')?.addEventListener('click',()=>checkUvdUpdate(true));$('deleteHistory').onclick=deleteHistory;$('deleteLogs').onclick=deleteLogs;$('deleteHistoryLogs').onclick=deleteHistoryLogs;
for(const id of ['siteAccessMode','whitelistSites','blacklistSites','folderNaming','parallelDownloads','duplicateFileMode','mode','dynamicWait','dynamicScrollAttempts','maxSeconds','restorePosition','downloadRoot','ffmpegPath','notifyComplete','previewMode','theme','windowSize','textSize','adFilterEnabled','adFilterStrength','adFilterAutoUpdate','detectionPreset','analysisMaxResponseMB','analysisMaxDepth','analysisMaxNodes','analysisTimeBudgetMs','maxMutationNodes','streamAnalysis','extensionlessDetection','domDetection','networkDetection','jsonDetection','urlCandidateDetection','siteAccessMode','whitelistSites','blacklistSites'])if($(id)){$(id).addEventListener('change',saveSettings);if(['downloadRoot','ffmpegPath'].includes(id))$(id).addEventListener('blur',saveSettings)}
if($('sidebarFixed'))$('sidebarFixed').addEventListener('change',e=>{
 const enabled=!!e.currentTarget.checked;
 settings.sidebarFixed=enabled;
 try{
  // Must be invoked before any await/promise continuation so Firefox retains
  // the user activation required by sidebarAction.open()/close().
  if(enabled&&browser.sidebarAction?.open){
   const p=browser.sidebarAction.open();
   if(p?.catch)p.catch(err=>console.error('UVD sidebar open failed',err));
  }else if(!enabled&&browser.sidebarAction?.close){
   const p=browser.sidebarAction.close();
   if(p?.catch)p.catch(err=>console.error('UVD sidebar close failed',err));
  }
 }catch(err){console.error('UVD sidebar action failed',err)}
 const persist=saveSettings();
 if(enabled){
  // The action popup must not remain alongside the sidebar. Do this after the
  // synchronous open call; persistence has already been started above.
  setTimeout(()=>{try{window.close();}catch{}},0);
 }
})
$('refreshPreviewLogs')?.addEventListener('click',refreshPreviewLogPanel);$('copyPreviewLogs')?.addEventListener('click',async()=>{await UVDDiagnostics.flush();const logs=(await browser.storage.local.get(ERROR_LOG_KEY))[ERROR_LOG_KEY];const text=(Array.isArray(logs)?logs:[]).map(x=>`${new Date(x.ts).toISOString()} [${x.source||'-'}] ${x.context||'-'}\n${x.message||'-'}\nURL: ${x.pageUrl||'-'}\n${x.filename?`FILE: ${x.filename}:${x.line||0}:${x.column||0}`:''}`).join('\n\n');try{await navigator.clipboard.writeText(text);alert('エラーログをコピーしました。')}catch(e){console.error('UVD error log copy failed',e);alert('エラーログをコピーできませんでした。')}});$('clearPreviewLogs')?.addEventListener('click',async()=>{if(await clearPreviewLogs())await refreshPreviewLogPanel()});
$('detectionPreset')?.addEventListener('change',()=>applyDetectionPreset($('detectionPreset').value));$('saveDetectionPreset')?.addEventListener('click',saveNamedDetectionPreset);$('renameDetectionPreset')?.addEventListener('click',renameDetectionPreset);$('deleteDetectionPreset')?.addEventListener('click',deleteDetectionPreset);$('customPresetSelect')?.addEventListener('change',async()=>{const name=$('customPresetSelect').value;if(!name)return;const presets=await loadDetectionPresets();const value=presets[name];if(!value)return;settings={...settings,...UVDDetectionTuning.normalize(value)};for(const id of ['mode','dynamicWait','dynamicScrollAttempts','maxSeconds','detectionPreset','analysisMaxResponseMB','analysisMaxDepth','analysisMaxNodes','analysisTimeBudgetMs','maxMutationNodes'])if($(id))$(id).value=settings[id];for(const id of ['streamAnalysis','extensionlessDetection','domDetection','networkDetection','jsonDetection','urlCandidateDetection'])if($(id))$(id).checked=settings[id]!==false;await saveSettings();$('customPresetName').value=name;});$('exportDetectionPreset')?.addEventListener('click',exportDetectionPreset);$('importDetectionPreset')?.addEventListener('click',()=>$('importDetectionPresetFile')?.click());$('importDetectionPresetFile')?.addEventListener('change',e=>{const file=e.target.files?.[0];if(file)importDetectionPresetFile(file);e.target.value='';});
$('toggleDetectionAdvanced')?.addEventListener('click',()=>{const box=$('detectionAdvanced');if(!box)return;const hidden=box.hidden;box.hidden=!hidden;$('toggleDetectionAdvanced').textContent=hidden?'詳細設定を隠す':'詳細設定を表示';});
$('adFilterUpdateNow')?.addEventListener('click',updateAdFilterListsFromUi);

function scheduleDetectedRender(){
 if(!coAppStartupReady)return;
 if(renderScheduled)return;
 renderScheduled=true;
 clearTimeout(renderScheduleTimer);
 renderScheduleTimer=setTimeout(async()=>{
  renderScheduled=false;
  const t=await active();
  if(t?.id!==tabId||displayCleared)return;
  setInternalItems(await list());
  await render(false);
 },80);
}

if(globalThis.__UVD_POPUP_MESSAGE_LISTENER__) throw new Error('UVD popup listener already initialized');
globalThis.__UVD_POPUP_MESSAGE_LISTENER__=true;
browser.runtime.onMessage.addListener(async msg=>{
 if(msg?.type==='detectedUpdate'){
  if(!coAppStartupReady||coAppUpdating)return;
  const t=await active();if(t?.id===tabId){displayCleared=false;scheduleDetectedRender()}
 }
 if(msg?.type==='scanFinished'&&msg.tabId===tabId){busy=false;if(!coAppStartupReady||coAppUpdating)return;setBusy(false);displayCleared=false;setInternalItems(await list());$('statusText').textContent='検出完了';await render(false)}
});

(async()=>{
 try{
  if(String(browser.runtime.getManifest().version)!==UVD_VERSION) throw new Error('UVD version mismatch: '+browser.runtime.getManifest().version+' != '+UVD_VERSION);
  // Paint the popup shell before any asynchronous storage, background, CoApp,
  // filesystem, or preview work. A slow dependency must never make the popup
  // appear not to open.
  displayCleared=false;
  try{applyAppearance();applyAdFilterUiState();applyButtonState();}catch(e){console.error('UVD initial shell paint failed',e)}

  // UI shell is painted first. Before CoApp verification completes, do not read
  // or render the internal video list and do not synchronize download state.
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  await loadSettings(false);
  const savedDetectionPresets=await loadDetectionPresets();refreshDetectionPresetSelect(savedDetectionPresets);
  applyAppearance();applyAdFilterUiState();applyButtonState();
  let t=null;try{t=await active();tabId=t?.id||null}catch(e){console.error('UVD active tab lookup failed',e)}
  if(tabId==null)throw new Error('Active tab could not be determined.');

  let coAppState;
  try{
   const box=$('companionStatus');if(box)box.textContent='CoAppバージョンを確認しています…';
   coAppState=await refreshCoAppUpdateState();
   showCoAppUpdateState(coAppState);
   if(!coAppState?.connected){$('statusText').textContent='CoAppのバージョンを確認できるまで動画リストを表示しません';throw new Error('CoApp version verification did not complete.');}
   const desired=String(coAppState.desiredCoAppVersion||''),current=String(coAppState.coAppVersion||'');
   if(!desired||!current){$('statusText').textContent='CoAppのバージョン情報を取得できるまで動画リストを表示しません';throw new Error('CoApp version information is incomplete.');}
   if(compareVersions(current,desired)<0){
    if(/^\d+\.\d+$/.test(current.trim())){
      $('statusText').textContent='旧形式のCoAppを検出しました。既存CoAppの自動更新経路では移行できません。';
      showUiDialog('CoAppの再セットアップが必要です',`現在のCoAppは旧形式 (${current}) です。必要なCoAppは ${desired} です。\n\ncompanion\\setup-coapp.ps1 を実行して同じインストール先を更新してください。`);
      throw new Error('Legacy two-part CoApp version requires setup-coapp.ps1 migration.');
    }
    pendingUiAction='startupCoAppUpdate';
    showUiDialog('CoApp更新があります',`現在のCoAppは ${current} です。必要なCoAppは ${desired} です。更新を実行するまで動画リストには触れません。`);
    await new Promise(resolve=>{globalThis.__uvdStartupCoAppResolve=resolve});
    coAppState=await refreshCoAppUpdateState();
    if(coAppState?.connected&&compareVersions(coAppState.coAppVersion||'0',desired)>=0){
      try{coAppState=await reconnectCoAppAfterUpdate(desired)}catch(e){$('statusText').textContent='CoApp更新後の接続確認に失敗しました';throw e;}
    }
    if(!coAppState?.connected||compareVersions(coAppState.coAppVersion||'0',desired)<0){$('statusText').textContent='CoApp更新完了を確認できないため動画リストを表示しません';throw new Error('CoApp update verification failed.');}
   }
  }catch(e){
   console.error('UVD startup CoApp gate failed',e);
   const message=String(e?.message||e||'CoAppのバージョン確認に失敗しました。');
   const box=$('companionStatus');
   if(box)box.textContent=coAppState?.error?`CoApp確認失敗: ${coAppState.error}`:`CoApp確認失敗: ${message}`;
   if($('statusText'))$('statusText').textContent='CoAppのバージョン確認に失敗したため動画リストを表示していません';
   try{applyButtonState()}catch{}
   return;
  }

  // Only after the CoApp response/update is settled may rawCandidates be
  // analyzed and merged into the persistent internal list.
  try{await browser.runtime.sendMessage({type:'uiProcessingReady',tabId});}catch(e){console.error('UVD UI processing gate failed',e)}
  try{const r=await Promise.race([browser.runtime.sendMessage({type:'finalizeRawCandidates',tabId}),sleep(5000).then(()=>({ok:false,error:'rawCandidates処理がタイムアウトしました。'}))]);if(!r?.ok)throw new Error(r?.error||'rawCandidates processing failed');}catch(e){console.error('UVD rawCandidates finalization failed',e)}
  try{const restored=await Promise.race([list(),sleep(1500).then(()=>[])]);setInternalItems(Array.isArray(restored)?restored:[]);}catch(e){console.error('UVD video list restore failed',e)}
  coAppStartupReady=true;
  try{await render(false)}catch(e){console.error('UVD initial render failed',e)}
  try{await refreshDetectionDiagnostics()}catch(e){console.error('UVD detection diagnostics failed',e)}
  try{await refreshPreviewLogPanel()}catch(e){console.error('UVD preview log restore failed',e)}
  setTimeout(()=>checkUvdUpdate(false),0);
  try{await syncDownloadState();await syncExistingFiles();applyButtonState()}catch(e){console.error('UVD post-startup synchronization failed',e)}
 }catch(e){
  console.error('UVD popup initialization failed',e);
  if(!items.length&&$('statusText'))$('statusText').textContent='動画リソースをまだ検出できませんでした';
  try{applyButtonState()}catch{}
 }
})();
