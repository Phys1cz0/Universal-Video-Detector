(() => {
  if (globalThis.__UVD_DETECTOR_INITIALIZED__) return;
  globalThis.__UVD_DETECTOR_INITIALIZED__ = true;
  const detectorSettingsReady = browser.storage.local.get('uvdSettingsPersisted').then(r => UVDDetectionTuning.normalize(r?.uvdSettingsPersisted || {})).catch(() => UVDDetectionTuning.normalize({}));
  detectorSettingsReady.then(settings => {
    if (!UVDDetectionTuning.isSiteAllowed(location.href, settings)) {
      globalThis.__UVD_DETECTOR_DISABLED_BY_SITE_RULE__ = true;
      return;
    }
  // Detection can produce hundreds of media/resource events during image-heavy
  // page loads. Queue and batch them so one DOM burst does not create hundreds of
  // Native/extension messages and storage/render cycles. This remains passive: it
  // never starts scrolling or any active acquisition.
  const pendingDetected = new Map();
  const recentlyQueuedDetected = new Map();
  let pageIdentityCacheKey = '';
  let pageIdentityCache = null;
  // Resource URLs already reported by PerformanceResourceTiming.
  const seenPerformanceResources = new Set();
  // Current detection tuning is clamped by the shared schema and updated from Firefox storage.
  let detectionTuning = UVDDetectionTuning.normalize({});
  // Lightweight diagnostics counters used to distinguish load reduction from missed detection.
  const detectionDiagnostics = {domBatches:0,domCandidates:0,networkCandidates:0,rawCandidates:0};
  const absoluteUrl = value => { try { return new URL(String(value || ''), location.href).href; } catch { return ''; } };
  const textValue = value => {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
    if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join('|');
    if (typeof value === 'object') {
      if (value['@id'] != null) return textValue(value['@id']);
      if (value.value != null) return textValue(value.value);
      if (value.name != null) return textValue(value.name);
    }
    return '';
  };
  const typeList = value => Array.isArray(value) ? value.map(x => String(x || '')).filter(Boolean) : (value ? [String(value)] : []);
  const isPageStructuredType = value => typeList(value).some(t => /(?:^|\/)(?:WebPage|AboutPage|CollectionPage|ItemPage|SearchResultsPage|Article|NewsArticle|BlogPosting|CreativeWork|VideoGallery)$/i.test(t) || /^(WebPage|AboutPage|CollectionPage|ItemPage|SearchResultsPage|Article|NewsArticle|BlogPosting|CreativeWork|VideoGallery)$/i.test(t));
  const structuredIdentifier = obj => {
    const v = obj?.identifier;
    if (v == null) return '';
    if (Array.isArray(v)) return v.map(structuredIdentifier).filter(Boolean).join('|');
    if (typeof v === 'object') return textValue(v.value ?? v['@id'] ?? v.name);
    return String(v).trim();
  };
  const structuredMainPage = obj => {
    const v = obj?.mainEntityOfPage;
    if (typeof v === 'string') return absoluteUrl(v);
    if (Array.isArray(v)) return v.map(structuredMainPage).filter(Boolean).join('|');
    if (v && typeof v === 'object') return absoluteUrl(v['@id'] || v.url || v.identifier);
    return '';
  };
  const collectPageIdentity = () => {
    const currentUrl = location.href;
    const cacheKey = `${currentUrl}|${document.title || ''}|${document.querySelector('link[rel="canonical"]')?.getAttribute('href') || ''}`;
    if (pageIdentityCache && pageIdentityCacheKey === cacheKey) return pageIdentityCache;
    const out = {
      pageOrigin: location.origin,
      canonicalUrl: '',
      ogUrl: '',
      structuredId: '',
      structuredIdentifier: '',
      structuredType: '',
      structuredMainEntityOfPage: '',
      microdataItemId: '',
      microdataItemType: '',
      pageUrl: currentUrl,
      pageTitle: document.title || ''
    };
    try { out.canonicalUrl = absoluteUrl(document.querySelector('link[rel="canonical"]')?.getAttribute('href')); } catch {}
    try { out.ogUrl = absoluteUrl(document.querySelector('meta[property="og:url"],meta[name="og:url"]')?.getAttribute('content')); } catch {}
    try {
      const nodes = [...document.querySelectorAll('script[type="application/ld+json"]')];
      const candidates = [];
      const walk = (value, depth=0) => {
        if (depth > 8 || value == null) return;
        if (Array.isArray(value)) { for (const v of value) walk(v, depth + 1); return; }
        if (typeof value !== 'object') return;
        const types = typeList(value['@type']);
        if (isPageStructuredType(types)) candidates.push({value,score:3});
        else if (types.some(t => /VideoObject|MediaObject/i.test(t))) candidates.push({value,score:1});
        if (value['@graph']) walk(value['@graph'], depth + 1);
      };
      for (const node of nodes) {
        try { const parsed = JSON.parse(node.textContent || ''); walk(parsed); } catch {}
      }
      candidates.sort((a,b) => b.score - a.score);
      const best = candidates[0]?.value;
      if (best) {
        out.structuredId = textValue(best['@id']);
        out.structuredIdentifier = structuredIdentifier(best);
        out.structuredType = typeList(best['@type']).join('|');
        out.structuredMainEntityOfPage = structuredMainPage(best);
      }
    } catch {}
    try {
      const nodes = [...document.querySelectorAll('[itemscope][itemtype][itemid]')];
      const pageNode = nodes.find(el => isPageStructuredType(el.getAttribute('itemtype')));
      if (pageNode) {
        out.microdataItemId = absoluteUrl(pageNode.getAttribute('itemid')) || String(pageNode.getAttribute('itemid') || '').trim();
        out.microdataItemType = String(pageNode.getAttribute('itemtype') || '').trim();
      }
    } catch {}
    // Canonical/OG URL are retained as fallback evidence, but CoApp never treats
    // a title alone as a page identity and performs the final comparison itself.
    pageIdentityCacheKey = cacheKey;
    pageIdentityCache = out;
    return out;
  };
  let detectedFlushTimer = 0;
  let detectedFlushRunning = false;
  const detectionKey = item => {
    const u = String(item?.url || '');
    const normalized = u.replace(/#.*$/, '');
    return `${item?.id != null ? String(item.id) : ''}|${normalized}|${item?.type || ''}`;
  };
  const flushDetected = async () => {
    detectedFlushTimer = 0;
    if (detectedFlushRunning || !pendingDetected.size) return;
    detectedFlushRunning = true;
    try {
      while (pendingDetected.size) {
        const batch = [];
        for (const [k, item] of pendingDetected) {
          pendingDetected.delete(k);
          batch.push(item);
          if (batch.length >= 40) break;
        }
        try {
          await browser.runtime.sendMessage({type:'detectedBatch', items:batch});
        } catch {}
        // Yield between chunks so a large page cannot monopolize the content task.
        if (pendingDetected.size) await new Promise(r => setTimeout(r, 0));
      }
    } finally {
      detectedFlushRunning = false;
      if (pendingDetected.size && !detectedFlushTimer)
        detectedFlushTimer = setTimeout(flushDetected, 40);
    }
  };
  const collectVideoIdentity = item => {
    const media = absoluteUrl(item?.url || item?.mediaUrl || '');
    const uuid = (media.match(/([0-9a-f]{8}-[0-9a-f-]{20,})/i)?.[1] || '').toLowerCase();
    let path = ''; try { const u = new URL(media); path = `${u.origin}${u.pathname}`.toLowerCase(); } catch {}
    return { stableId: item?.itemId ? String(item.itemId) : '', mediaUrl: media, uuid, path, filename: String(item?.filename || ''), thumbnail: absoluteUrl(item?.thumbnail || ''), pageItemIdentity: String(item?.pageItemIdentity || '') };
  };
  const send = item => {
    if (!item?.url) return;
    const enriched = {...item,pageUrl:item?.pageUrl||location.href,landingPage:item?.landingPage||location.href,pageIdentity:item?.pageIdentity||collectPageIdentity(),videoIdentity:item?.videoIdentity||collectVideoIdentity(item)};
    const k = detectionKey(enriched);
    const signature = `${enriched.url}|${enriched.name||''}|${enriched.thumbnail||''}|${enriched.type||''}`;
    const now = Date.now();
    const previous = recentlyQueuedDetected.get(k);
    if(previous && previous.signature===signature && now-previous.at<1500) return;
    recentlyQueuedDetected.set(k,{signature,at:now});
    pendingDetected.set(k, enriched);
    detectionDiagnostics.rawCandidates=pendingDetected.size;
    if (!detectedFlushTimer && !detectedFlushRunning) detectedFlushTimer = setTimeout(flushDetected, 40);
  };
  const classify = (url, declaredType='') => {
    if (!url || typeof url !== 'string') return null;
    const l = url.toLowerCase();
    if (/\.m3u8(?:[?#]|$)/i.test(l)) return 'hls';
    if (/\.mpd(?:[?#]|$)/i.test(l)) return 'dash';
    if (/\.(mp4|webm|mov|m4v)(?:[?#]|$)/i.test(l)) return 'direct';
    if(detectionTuning.extensionlessDetection && /^(direct|mp4|webm|mov|m4v|hls|dash|video)$/i.test(String(declaredType||''))) return String(declaredType).toLowerCase()==='hls'?'hls':String(declaredType).toLowerCase()==='dash'?'dash':'direct';
    return null;
  };
  const scanText = (text, source = 'page') => {
    if (!text || typeof text !== 'string' || text.length > 20_000_000) return;
    const re = /https?:\/\/[^\s"'<>\\]+/g;
    for (const m of text.matchAll(re)) {
      const u = m[0].replace(/\\\//g, '/');
      const type = classify(u);
      if (type) send({url:u, type, source});
    }
  };
  let discoveryRunning = false;
  let discoveryToken = 0;
  let pendingDiscovery = false;

  let activeSettings = {
    mode: 'auto',
    dynamicWait: 300,
    dynamicScrollAttempts: 5,
    maxSeconds: 45,
    restorePosition: true
  };

  async function loadDetectionTuning(){
    try{const stored=await browser.storage.local.get('uvdSettingsPersisted');detectionTuning=UVDDetectionTuning.normalize(stored?.uvdSettingsPersisted||{});window.dispatchEvent(new CustomEvent('__UVD_DETECTION_TUNING__',{detail:detectionTuning}));}catch{}
  }
  browser.storage.onChanged.addListener((changes,area)=>{if(area!=='local'||!changes.uvdSettingsPersisted)return;detectionTuning=UVDDetectionTuning.normalize(changes.uvdSettingsPersisted.newValue||{});window.dispatchEvent(new CustomEvent('__UVD_DETECTION_TUNING__',{detail:detectionTuning}));});
  loadDetectionTuning();

  browser.runtime.onMessage.addListener(msg => {
    if (msg?.type === 'detectionDiagnostics') return Promise.resolve({ok:true,...detectionDiagnostics,pendingDetected:pendingDetected.size,tuning:detectionTuning});
    if (msg?.type === 'pageReady') {
      passiveScan();
      return Promise.resolve({ok:true});
    }
    if (msg?.type === 'rescan') {
      activeSettings = {...activeSettings, ...(msg.settings || {})};
      browser.runtime.sendMessage({type:'scanStart', hold:true}).catch(()=>{});
      try { window.dispatchEvent(new CustomEvent('__UVD_ACTIVE_RESCAN__')); } catch {}
      scan();
      runDiscovery(activeSettings, true);
      return Promise.resolve({ok:true});
    }
  });

  function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
  let passiveTimer=0;
  function passiveScan(records){
    // Passive mode never performs a whole-document rescan. The initial DOM is
    // scanned once at page load. After that, only the DOM nodes reported by the
    // observer are inspected. Network/resource events are handled by their own
    // listeners and are not rediscovered by repeatedly scanning the page.
    if(!Array.isArray(records)||!records.length)return;
    const nodes=[];
    const seen=new Set();
    const addNode=n=>{if(n&&n.nodeType===1&&!seen.has(n)){seen.add(n);nodes.push(n)}};
    for(const r of records){
      if(r.type==='attributes'){
        const name=String(r.attributeName||'');
        if(/^(?:src|poster|href|data-(?:src|url|video|video-url|media-url|download-url|media|mp4|file|download|href)|content)$/i.test(name)) addNode(r.target);
        continue;
      }
      if(r.type==='childList') for(const n of r.addedNodes||[]){
        if(n?.nodeType!==1)continue;
        // The added subtree itself is the only passive scan scope.
        addNode(n);
      }
    }
    if(!nodes.length)return;
    detectionDiagnostics.domBatches++;detectionDiagnostics.domCandidates+=nodes.length;
    clearTimeout(passiveTimer);
    passiveTimer=setTimeout(()=>{
      passiveTimer=0;
      // One central passive DOM batch is shared with Generic Adapter. This
      // prevents separate observers from walking the same mutation twice.
      try { window.dispatchEvent(new CustomEvent('__UVD_DOM_BATCH__',{detail:{nodes}})); } catch {}
      scanNodes(nodes,'mutation');
    },250);
  }
  const notifyPageReady=()=>browser.runtime.sendMessage({type:'detectorReady',readyState:document.readyState,url:location.href,pageIdentity:collectPageIdentity()}).catch(()=>{});
  function scrollableElements(){
    const out=[];
    try{
      const all=document.querySelectorAll('body *');
      for(const el of all){
        if(!(el instanceof HTMLElement)) continue;
        const cs=getComputedStyle(el), oy=cs.overflowY, ox=cs.overflowX;
        const scrollable=(/(auto|scroll|overlay)/i.test(oy)&&el.scrollHeight>el.clientHeight+80) ||
                         (/(auto|scroll|overlay)/i.test(ox)&&el.scrollWidth>el.clientWidth+80);
        if(scrollable) out.push(el);
        if(out.length>=80) break;
      }
    }catch{}
    return out;
  }
  function scrollMetrics(targets){
    let maxBottom=0,totalHeight=document.documentElement.scrollHeight||0;
    try{maxBottom=Math.max(0,(window.scrollY||window.pageYOffset||0)+(window.innerHeight||0));}catch{}
    for(const el of targets){try{maxBottom=Math.max(maxBottom,el.scrollTop+el.clientHeight);totalHeight=Math.max(totalHeight,el.scrollHeight);}catch{}}
    return {maxBottom,totalHeight};
  }
  function nearBottom(targets){
    const rootGap=Math.max(120,(document.documentElement.scrollHeight||0)-(window.scrollY||window.pageYOffset||0)-(window.innerHeight||0));
    if(rootGap<=120)return true;
    return targets.some(el=>{try{return el.scrollHeight-el.scrollTop-el.clientHeight<=120;}catch{return false;}});
  }
  function scrollToRatio(targets, ratio){
    const rootMax=Math.max(0,(document.documentElement.scrollHeight||0)-(window.innerHeight||0));
    const top=Math.round(rootMax*Math.max(0,Math.min(1,ratio)));
    try{window.scrollTo({top,behavior:'auto'});}catch{try{window.scrollTo(0,top);}catch{}}
    for(const el of targets){
      try{const max=Math.max(0,el.scrollHeight-el.clientHeight);el.scrollTop=Math.round(max*Math.max(0,Math.min(1,ratio)));}catch{}
    }
  }
  function scrollBottom(targets){scrollToRatio(targets,1);}
  function scrollOneViewportUp(targets){
    try{window.scrollBy({top:-Math.max(180,Math.floor(window.innerHeight*.9)),behavior:'auto'});}catch{try{window.scrollBy(0,-Math.max(180,Math.floor(window.innerHeight*.9)));}catch{}}
    for(const el of targets){try{el.scrollTop=Math.max(0,el.scrollTop-Math.max(180,Math.floor(el.clientHeight*.9)));}catch{}}
  }
  function looksLikeLazyList(){
    try{
      const rootH=document.documentElement.scrollHeight||0;
      if(rootH>window.innerHeight+300)return true;
      return scrollableElements().length>0;
    }catch{return false;}
  }

  async function runStaticDiscovery(){
    // A page can finish its own asynchronous list population after the first
    // scan. Keep the explicit UI-triggered discovery window open long enough
    // to collect those resources, without starting any autonomous navigation.
    const started=Date.now();
    let lastScan=0;
    while(Date.now()-started<3500){
      scan();
      lastScan=Date.now();
      await sleep(250);
    }
    if(Date.now()-lastScan>50)scan();
  }

  function requestActiveAdapterScan(rank){
    try { window.dispatchEvent(new CustomEvent('__UVD_ACTIVE_RESCAN__',{detail:rank?{rank}:undefined})); } catch {}
  }

  async function runTwiigleDiscovery(settings){
    if(!/^(?:www\.)?twiigle\.com$/i.test(location.hostname))return false;
    const wait=Math.max(180,Math.min(900,Number(settings.dynamicWait)||300));
    const maxMs=Math.max(6000,Math.min(45000,(Number(settings.maxSeconds)||45)*1000));
    const started=Date.now();let stable=0,lastCount=-1;
    // Rule: never acquire Twiigle by scrolling one ranking item at a time.
    // Explicit Update triggers bounded batch rescans only; API pagination remains
    // handled by main-hook from observed media-list responses.
    for(let pass=0;pass<6&&Date.now()-started<maxMs;pass++){
      requestActiveAdapterScan();await sleep(wait);
      const count=document.querySelectorAll('.item_ranking').length;
      stable=count===lastCount?stable+1:0;lastCount=count;
      if(count>=60&&stable>=1)break;
    }
    return true;
  }

  async function runDynamicDiscovery(settings){
    const originalY=window.scrollY||window.pageYOffset||0;
    const targets=scrollableElements();
    const positions=targets.map(el=>({el,top:el.scrollTop,left:el.scrollLeft}));
    const wait=Math.max(80,Math.min(1500,Number(settings.dynamicWait)||300));
    const started=Date.now();
    let stable=0, lastSig='';
    try{
      // Fast trigger pattern: jump to the bottom first, then move up one viewport
      // and return to the bottom. This fires scroll/IntersectionObserver based lazy
      // loaders without crawling through every intermediate position.
      const attempts=Math.max(2,Math.min(10,Number(settings.dynamicScrollAttempts)||5));
      for(let cycle=0;cycle<attempts && Date.now()-started<Math.max(5,Number(settings.maxSeconds)||45)*1000;cycle++){
        const before=scrollMetrics(targets);
        scrollBottom(targets);
        await sleep(wait);
        scan();
        await sleep(Math.min(450,wait+80));
        scan();

        scrollOneViewportUp(targets);
        await sleep(Math.min(180,Math.max(60,wait/2)));
        scrollBottom(targets);
        await sleep(wait);
        scan();

        const after=scrollMetrics(targets);
        const sig=`${after.totalHeight}|${after.maxBottom}|${document.querySelectorAll('video,source,img,article,li,[data-video-id],[data-id*="video"]').length}`;
        const changed=sig!==lastSig || after.totalHeight>before.totalHeight || after.maxBottom>before.maxBottom;
        if(changed){stable=0;lastSig=sig;}else stable++;

        // Give a newly appended final page another bottom trigger before ending.
        if(nearBottom(targets) && stable>=3){
          scrollOneViewportUp(targets);
          await sleep(120);
          scrollBottom(targets);
          await sleep(wait*2);
          scan();
          const finalM=scrollMetrics(targets);
          const finalSig=`${finalM.totalHeight}|${finalM.maxBottom}|${document.querySelectorAll('video,source,img,article,li,[data-video-id],[data-id*="video"]').length}`;
          if(finalSig===sig)stable++;else{stable=0;lastSig=finalSig;}
          if(stable>=4)break;
        }
      }
    } finally {
      if(settings.restorePosition!==false){
        try{window.scrollTo({top:originalY,behavior:'auto'});}catch{try{window.scrollTo(0,originalY);}catch{}}
        for(const p of positions){try{p.el.scrollTop=p.top;p.el.scrollLeft=p.left;}catch{}}
      }
    }
  }

  async function runDiscovery(settings={}, initiatedByUi=false){
    // Rule 101/102: active discovery may only be entered from an explicit UI rescan request.
    if(!initiatedByUi){
      scan();
      return;
    }
    if(discoveryRunning){pendingDiscovery=true;return;}
    const mode=settings.mode||'auto';
    if(mode==='manual'){
      scan();
      await sleep(300);
      browser.runtime.sendMessage({type:'scanDone'}).catch(()=>{});
      return;
    }
    discoveryRunning=true;
    const token=++discoveryToken;
    try{
      try { window.dispatchEvent(new CustomEvent('__UVD_ACTIVE_RESCAN_START__')); } catch {}
      if(mode==='static'){
        await runStaticDiscovery();
      }else if(mode==='dynamic'){
        if(!(await runTwiigleDiscovery(settings))) await runDynamicDiscovery(settings);
      }else if(mode==='hybrid'){
        await runStaticDiscovery();
        if(!(await runTwiigleDiscovery(settings))) await runDynamicDiscovery(settings);
      }else{
        // Auto: inspect static/network sources first. Do not enter the long-running
        // dynamic discovery loop on ordinary pages. Scrolling is reserved for pages
        // that actually expose a long or internally scrollable lazy-loaded list.
        await runStaticDiscovery();
        if(token===discoveryToken && looksLikeLazyList()){
          if(!(await runTwiigleDiscovery(settings))) await runDynamicDiscovery(settings);
        }
      }
    }catch{} finally{
      try { window.dispatchEvent(new CustomEvent('__UVD_ACTIVE_RESCAN_END__')); } catch {}
      discoveryRunning=false;
      if(pendingDiscovery){
        pendingDiscovery=false;
        setTimeout(()=>runDiscovery(settings, true),0);
      }else{
        browser.runtime.sendMessage({type:'scanDone'}).catch(()=>{});
      }
    }
  }

  window.addEventListener('__UVD_HOOK_ERROR__', e => {
    const detail = e?.detail || {};
    UVDDiagnostics?.reportMessage?.(detail.message || 'main-hook error', detail.context || 'main-hook');
  });

  window.addEventListener('__UVD_METADATA__', e => {
    const d=e.detail||{};
    // All adapter output must enter the same detection queue.  The generic
    // adapter uses mediaUrl as the canonical download field; accepting only
    // the legacy `url` field caused Twiigle adapter detections to be silently
    // discarded, leaving only network-observed videos in the internal list.
    const mediaUrl=String(d.mediaUrl||d.url||'').trim();
    if (mediaUrl) {
      const type=classify(mediaUrl,d.type);
      if(type) send({...d,url:mediaUrl,type,source:d.source||'adapter'});
    } else if (d.name || d.thumbnail) {
      browser.runtime.sendMessage({type:'metadata', item:{name:d.name,thumbnail:d.thumbnail,source:d.source||'adapter'}}).catch(()=>{});
    }
  });

  const scanNodes = (roots, source='mutation') => {
    if(detectionTuning.domDetection===false)return;
    const queue=[];
    const seen=new Set();
    const add=n=>{if(n?.nodeType===1&&!seen.has(n)){seen.add(n);queue.push(n)}};
    for(const root of Array.isArray(roots)?roots:[]){
      add(root);
      try{
        root.querySelectorAll?.("video,source,iframe,script,a[href*='.mp4' i],a[href*='.webm' i],a[href*='.mov' i],a[href*='.m4v' i],a[href*='.m3u8' i],a[href*='.mpd' i],[data-video],[data-video-url],[data-media-url],[data-download-url],[data-media],[data-mp4],[data-file],[data-download],[data-href]").forEach((el)=>{ if(queue.length<256) add(el); });
      }catch{}
    }
    for(const el of queue){
      try{
        const tag=String(el.tagName||'').toLowerCase();
        if(tag==='video'||tag==='source'){
          const u=el.currentSrc||el.src;
          const type=classify(u);
          if(type)send({url:u,type,source:source==='mutation'?'element-mutation':'element'});
        }
        if(tag==='script')scanText(el.textContent||'',source==='mutation'?'script-mutation':'script');
        for(const attr of ['src','href','data-src','data-url','data-video','data-video-url','data-media-url','data-download-url','data-media','data-mp4','data-file','data-download','data-href','poster','content']){
          const value=el.getAttribute?.(attr);
          if(!value)continue;
          const type=classify(value);
          if(type)send({url:absoluteUrl(value)||value,type,source:source==='mutation'?'attribute-mutation':'attribute'});
          if(/(?:https?:\/\/|video\.twimg\.com|\.(?:m3u8|mpd|mp4|webm|mov|m4v)(?:[?#]|$))/i.test(value))
            scanText(value,source==='mutation'?'attribute-mutation':'attribute');
        }
      }catch{}
    }
  };

  const scan = () => {
    if(detectionTuning.domDetection===false)return;
    // Whole-document scanning is intentionally limited to the initial page load
    // and explicit UI-triggered active acquisition. Passive events use scanNodes().
    try {
      for (const r of performance.getEntriesByType('resource')) {
        const u = r.name;
        if (seenPerformanceResources.has(u)) continue;
        seenPerformanceResources.add(u);
        const type = classify(u);
        if (type) send({url:u, type, source:'performance'});
      }
    } catch {}
    const initialRoots=[];
    try{
      const selector='video,source,iframe,script[type="application/ld+json"],script:not([type]),a[href*=".mp4" i],a[href*=".webm" i],a[href*=".mov" i],a[href*=".m4v" i],a[href*=".m3u8" i],a[href*=".mpd" i],a[href*="video.twimg.com" i],[data-video],[data-video-url],[data-media-url],[data-media],[data-mp4],[data-file],[data-download],[data-href],[data-src],[data-url]';
      document.querySelectorAll(selector).forEach(n=>initialRoots.push(n));
    }catch{}
    scanNodes(initialRoots,'initial');
  };

  window.addEventListener('__UVD_VIDEO_URL__', e => {
    const d = e.detail || {};
    const type = classify(d.url,d.type);
    if (type) send({...d, type});
  });

  try {
    const s = document.createElement('script');
    s.src = browser.runtime.getURL('content/main-hook.js');
    s.onload = () => { loadDetectionTuning(); s.remove(); };
    (document.documentElement || document.head).appendChild(s);
  } catch {}

  new MutationObserver(passiveScan).observe(document.documentElement, {subtree:true, childList:true, attributes:true, attributeFilter:['src','poster','href','data-src','data-url','data-video','data-video-url','data-media-url','data-download-url','data-media','data-mp4','data-file','data-download','data-href','content']});
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => {scan();notifyPageReady();}, {once:true}); else {scan();notifyPageReady();}
  // Do not use timed whole-document rescans in passive mode. SPA navigation only
  // invalidates page identity; newly inserted/changed media are caught by the
  // targeted MutationObserver and network hooks.
  for (const method of ['pushState','replaceState']) {
    try {
      const original = history[method];
      history[method] = function(...args) { const r = original.apply(this,args); pageIdentityCacheKey=''; pageIdentityCache=null; notifyPageReady(); return r; };
    } catch {}
  }
  window.addEventListener('popstate', () => { pageIdentityCacheKey=''; pageIdentityCache=null; notifyPageReady(); });

  // Detection starts when the popup requests it. Normal page browsing is passive.
  });
})();
