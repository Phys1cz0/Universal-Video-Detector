(() => {
  // Adapter follows the shared detection tuning without owning the settings store.
  let detectionTuning = UVDDetectionTuning.normalize({});
  browser.storage.local.get('uvdSettingsPersisted').then(r => { detectionTuning = UVDDetectionTuning.normalize(r?.uvdSettingsPersisted || {}); }).catch(() => {});
  browser.storage.onChanged.addListener((changes, area) => { if(area==='local' && changes.uvdSettingsPersisted) detectionTuning = UVDDetectionTuning.normalize(changes.uvdSettingsPersisted.newValue || {}); });
  if (globalThis.__UVD_GENERIC_ADAPTER_INITIALIZED__) return;
  const adapterSettingsReady = browser.storage.local.get('uvdSettingsPersisted').then(r => UVDDetectionTuning.normalize(r?.uvdSettingsPersisted || {})).catch(() => UVDDetectionTuning.normalize({}));
  adapterSettingsReady.then(settings => {
    if (!UVDDetectionTuning.isSiteAllowed(location.href, settings)) return;
  globalThis.__UVD_GENERIC_ADAPTER_INITIALIZED__ = true;
  if (window.__UVD_GENERIC_ADAPTER__) return;
  window.__UVD_GENERIC_ADAPTER__ = true;

  const emit = detail => {
    try { window.dispatchEvent(new CustomEvent('__UVD_METADATA__', {detail})); } catch {}
  };
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const isTwiigle = () => location.hostname === 'twiigle.com' || location.hostname === 'www.twiigle.com';
  const isTwidouga = () => /^(?:www\.)?twidouga\.net$/i.test(location.hostname);
  const VIDEO_HINT = /(?:video\.twimg\.com|\.m3u8(?:[?#]|$)|\.mpd(?:[?#]|$))/i;
  const VIDEO_EXT = /\.(?:mp4|webm|mov|m4v|m3u8|mpd)(?:[?#]|$)/i;

  function absolute(value) {
    if (!value || typeof value !== 'string') return null;
    const raw = value.trim().replace(/\\\//g, '/');
    if (!raw || raw.startsWith('javascript:') || raw.startsWith('data:')) return null;
    try { return new URL(raw, location.href).href; } catch { return null; }
  }

  function decodeRepeated(value) {
    let current = String(value || '').replace(/\\\//g, '/');
    for (let i = 0; i < 4; i++) {
      let next;
      try { next = decodeURIComponent(current); } catch { break; }
      if (next === current) break;
      current = next;
    }
    return current;
  }

  // Extract URLs from wrapper URLs without treating the wrapper itself as the
  // media URL. Handles fragment/query parameters and URL-encoded nesting.
  function embeddedUrls(value) {
    const out = new Set();
    if (!value || typeof value !== 'string') return out;
    const decoded = decodeRepeated(value);
    const add = v => {
      const u = absolute(decodeRepeated(v));
      if (u) out.add(u);
    };

    // First inspect query and fragment parameters. This covers wrappers such
    // as ?url=https%3A%2F%2F... and #contents=https://....
    try {
      const parsed = new URL(decoded, location.href);
      for (const v of parsed.searchParams.values()) {
        if (/^https?:/i.test(v)) add(v);
      }
      const hash = parsed.hash.replace(/^#/, '');
      if (hash) {
        for (const part of hash.split('&')) {
          const eq = part.indexOf('=');
          if (eq >= 0) {
            const v = decodeRepeated(part.slice(eq + 1));
            if (/^https?:/i.test(v)) add(v);
          }
        }
      }
    } catch {}

    // Then scan the decoded text for a directly embedded URL.
    const re = /https?:\/\/[^\s"'<>\\\]}),]+/gi;
    for (const m of decoded.matchAll(re)) {
      // Do not return a wrapper URL that merely contains another URL.
      // The inner URL extracted from its query/fragment above is authoritative.
      const candidate = m[0];
      if ((candidate.match(/https?:\/\//gi) || []).length > 1) continue;
      add(candidate);
    }
    return out;
  }

  function candidateUrls(el) {
    const out = new Set();
    if (!el || el.nodeType !== 1) return out;
    const attrs = [
      'href', 'src', 'data-src', 'data-url', 'data-video', 'data-video-url',
      'data-media', 'data-media-url', 'data-mp4', 'data-file', 'data-download',
      'data-href', 'poster', 'content'
    ];
    for (const name of attrs) {
      const value = el.getAttribute?.(name);
      if (value) {
        out.add(value);
        for (const u of embeddedUrls(value)) out.add(u);
      }
    }
    const text = [el.getAttribute?.('onclick') || '', el.getAttribute?.('style') || '', el.textContent || ''].join(' ');
    for (const u of embeddedUrls(text)) out.add(u);
    return out;
  }

  function isVideoUrl(url) {
    return !!url && (VIDEO_HINT.test(url) || VIDEO_EXT.test(url));
  }

  function findVideoUrls(root) {
    const out=new Set();
    if(!root)return out;
    const nodes=[];
    if(root.nodeType===1)nodes.push(root);
    try{nodes.push(...root.querySelectorAll?.("a[href*='.mp4' i],a[href*='.webm' i],a[href*='.mov' i],a[href*='.m4v' i],a[href*='.m3u8' i],a[href*='.mpd' i],video,source,iframe,script,[data-video],[data-video-url],[data-media-url],[data-media],[data-mp4],[data-file],[data-download],[data-href],[data-src],[data-url]")||[])}catch{}
    for(const el of nodes){
      for(const raw of candidateUrls(el)){
        for(const candidate of embeddedUrls(raw))if(isVideoUrl(candidate))out.add(candidate);
        const url=absolute(decodeRepeated(raw));if(isVideoUrl(url))out.add(url);
      }
      if(el.tagName==='SCRIPT')for(const raw of embeddedUrls(el.textContent||''))if(isVideoUrl(raw))out.add(raw);
    }
    return out;
  }
  function findVideoUrl(root){return [...findVideoUrls(root)][0]||null;}

  function findThumbnail(root) {
    try {
      const img = root.querySelector?.('img');
      return img?.currentSrc || img?.src || null;
    } catch { return null; }
  }

  function attrValue(el, names) {
    if (!el || el.nodeType !== 1) return '';
    for (const name of names) {
      const v = el.getAttribute?.(name);
      if (v != null && String(v).trim()) return clean(v);
    }
    return '';
  }

  function twidougaCard(node) {
    if (!isTwidouga()) return node;
    let p = node?.nodeType === 1 ? node : node?.parentElement;
    let fallback = p;
    for (let i=0; i<12 && p; i++, p=p.parentElement) {
      const ids = twidougaIds(p);
      const buttons = p.querySelectorAll?.('button,a[href],[onclick]') || [];
      const hasDownload = [...buttons].some(x => /ダウンロード|download/i.test(clean(x.textContent || '') + ' ' + String(x.getAttribute?.('aria-label') || '')));
      if (ids.length || hasDownload) {
        const hasMedia = findVideoUrls(p).size > 0;
        if (hasMedia) return p;
      }
      const hasMedia = !ids.length && !hasDownload ? false : findVideoUrls(p).size > 0;
      if (hasMedia) fallback = p;
    }
    return fallback || node;
  }

  function twidougaIds(root){
    const out=[];const seen=new Set();if(!root)return out;
    const names=['data-video-id','data-videoid','data-video','data-id','data-vid','data-media-id','data-mediaid','data-content-id','data-contentid','data-tweet-id','data-status-id','data-item-id','data-itemid','video-id','videoid','video_id','media-id','mediaid','content-id','contentid','tweet-id','status-id'];
    const add=(v,label)=>{v=clean(v);if(!v||v.length>200)return;const k=label+':'+v;if(seen.has(k))return;seen.add(k);out.push({label,value:v});};
    const inspect=el=>{if(!el||el.nodeType!==1)return;for(const n of names){const v=el.getAttribute?.(n);if(v)add(v,n);}};
    // Prefer IDs on actual media/link controls before IDs on broad containers.
    try{const mediaNodes=root.matches?.('video,source,iframe,a,button')?[root]:[...root.querySelectorAll('video,source,iframe,a,button')];for(const el of mediaNodes)inspect(el);}catch{}
    inspect(root);
    try{root.querySelectorAll?.('[data-video-id],[data-videoid],[data-video],[data-id],[data-vid],[data-media-id],[data-mediaid],[data-content-id],[data-contentid],[data-tweet-id],[data-status-id],[data-item-id],[data-itemid],[video-id],[videoid],[video_id],[media-id],[mediaid],[content-id],[contentid],[tweet-id],[status-id]').forEach(inspect);}catch{}
    return out;
  }

  function findName(root) {
    if (!root) return undefined;
    if (isTwiigle()) {
      try {
        const ranking = root.querySelector?.('.item_ranking');
        const value = clean(ranking?.textContent);
        if (value) return value;
      } catch {}
    }
    if (isTwidouga()) {
      const card=twidougaCard(root)||root;
      const ids=twidougaIds(card);
      if(ids.length) return `Twidouga - ${ids[0].value}`;
    }
    const selectors = '[data-title],[title],[aria-label],h1,h2,h3,h4,h5,h6,[class*="title" i],[class*="name" i]';
    try {
      const n = root.querySelector(selectors);
      const value = clean(n?.getAttribute('data-title') || n?.getAttribute('title') || n?.getAttribute('aria-label') || n?.textContent);
      if (value && !/^(direct|video|hls|dash|xで見る|download|ダウンロード)$/i.test(value)) return value;
    } catch {}
    try {
      const lines = clean(String(root.textContent || '').slice(0, 4000)).split(/\n+/).map(clean).filter(Boolean);
      return lines.find(x => x.length >= 2 && x.length <= 240 && !/^(direct|video|hls|dash|xで見る|download|ダウンロード|通報)$/i.test(x));
    } catch { return undefined; }
  }

  function findTwiigleCard(node){
    if(!node)return null;let p=node.nodeType===1?node:node.parentElement;
    try{const c=p.closest?.('li,article,[role="article"],.art_li,[class*="item" i]');if(c&&c.querySelectorAll('.item_ranking').length===1)return c;}catch{}
    for(let i=0;i<10&&p;i++,p=p.parentElement){let ranks=[];try{ranks=[...p.querySelectorAll('.item_ranking')]}catch{}if(ranks.length>1)break;if(ranks.length===1)return p;}
    return node;
  }

  function identityUrl(url) {
    try {
      const u = new URL(url, location.href);
      u.hash = '';
      for (const k of [...u.searchParams.keys()]) {
        if (/^(token|sig|signature|expires|exp|auth|key|timestamp|t|tag)$/i.test(k)) u.searchParams.delete(k);
      }
      return u.href;
    } catch { return String(url || ''); }
  }
  function itemIdFor(url) {
    const idUrl = identityUrl(url);
    const tw = idUrl.match(/video\.twimg\.com\/(?:ext_tw_video|amplify_video)\/(\d+)/i);
    if (tw) return `twimg_${tw[1]}`;
    let h = 2166136261;
    for (let i = 0; i < idUrl.length; i++) { h ^= idUrl.charCodeAt(i); h = Math.imul(h, 16777619); }
    return `url_${(h >>> 0).toString(16).padStart(8, '0')}`;
  }
  function twiigleTweetId(root){if(!root)return '';try{for(const a of root.querySelectorAll('a[href]')){const m=String(a.getAttribute('href')||'').match(/(?:^|\/)(?:status|statuses)\/(\d+)/i);if(m)return m[1];}}catch{}return '';}
  function emitRoot(root,explicitRank=null){
    const sourceRoot=explicitRank?.nodeType===1?explicitRank:root;const card=isTwiigle()?findTwiigleCard(sourceRoot):(isTwidouga()?twidougaCard(sourceRoot):findCard(sourceRoot));
    const urls=findVideoUrls(card||sourceRoot);if(!urls.size)return false;let itemIdentity=pageItemIdentity(card||sourceRoot),rankText='',tweetId='';
    if(isTwiigle()){const raw=clean(explicitRank?.textContent||'');const m=raw.match(/No\.\s*(\d+)/i);rankText=m?`No.${m[1]}`:'';tweetId=twiigleTweetId(card||sourceRoot);if(tweetId)itemIdentity=`twiigle:tweet:${tweetId}`;else if(rankText)itemIdentity=`twiigle:rank:${rankText.toLowerCase()}`;}
    let emitted=false;
    for(const url of urls){const type=/\.m3u8(?:[?#]|$)/i.test(url)?'hls':/\.mpd(?:[?#]|$)/i.test(url)?'dash':'direct';const identity=identityUrl(url);let name=findName(card||sourceRoot),filename='';
      try{const ux=new URL(url,location.href);for(const k of ['filename','file','name','download','downloadName']){const q=ux.searchParams.get(k);if(q){try{filename=decodeURIComponent(q)}catch{filename=q}if(filename.trim())break}}if(!filename)filename=decodeURIComponent((ux.pathname.split('/').pop()||'').trim());filename=filename.replace(/^['"]|['"]$/g,'').trim()}catch{}
      const mediaStable=itemIdFor(url).replace(/^twimg_/,'');let stableId=mediaStable;
      if(isTwidouga()){const id=twidougaIds(card||sourceRoot)[0]?.value||'';if(id){name=`Twidouga - ${id} - ${mediaStable}`;stableId=`twidouga:${id}:media:${mediaStable}`;}else if(!name||/^(xで見る|download|ダウンロード|通報)$/i.test(name))name=filename||`Twidouga - ${mediaStable}`;}
      if(!name||/^(direct|video|hls|dash)$/i.test(name)||/^(?:playlist|master|index|manifest)(?:[-_.][^/]*)?\.(?:m3u8|mpd)$/i.test(name))name=clean(document.title)||filename||`Video - ${mediaStable}`;
      if(isTwiigle())name=rankText?`${rankText} - ${mediaStable}`:`Video - ${mediaStable}`;
      if(tweetId)stableId=`tweet:${tweetId}:media:${mediaStable}`;else if(isTwiigle()&&rankText)stableId=`twiigle:${rankText.toLowerCase()}:media:${mediaStable}`;
      emit({itemId:`${itemIdFor(url)}|${isTwiigle()?(tweetId?`tweet:${tweetId}`:(rankText||'rank')):''}`,identityUrl:identity,mediaUrl:url,filename,pageItemIdentity:itemIdentity,ranking:rankText,type,thumbnail:findThumbnail(card||sourceRoot),name,pageUrl:location.href,landingPage:location.href,originUrl:location.href,source:isTwiigle()?'twiigle-ranking-item':(isTwidouga()?'twidouga-item':'generic-adapter'),videoIdentity:{stableId,mediaUrl:identity,filename,thumbnail:findThumbnail(card||sourceRoot),pageItemIdentity:itemIdentity}});emitted=true;}
    return emitted;
  }

  function scanTwiigle() {
    if (!isTwiigle() && !isTwidouga()) return;
    try {
      if(isTwiigle()) for(const rank of document.querySelectorAll('.item_ranking')) emitRoot(rank,rank);
      else scanTwidouga();
    } catch {}
  }

  function scanTwiigleItem(rank) {
    if (!isTwiigle() || !rank || rank.nodeType !== 1) return;
    try { emitRoot(rank,rank); } catch {}
  }

  function scanTwidouga(){
    if(!isTwidouga())return;
    const seen=new Set(),candidates=[];
     try{
       const idSelector='[data-video-id],[data-videoid],[data-media-id],[data-mediaid],[data-tweet-id],[data-status-id],[data-item-id],[data-itemid],[data-video-url],[data-video],[data-vid]';
       document.querySelectorAll(idSelector).forEach(n=>{if(n?.nodeType===1)candidates.push(n)});
       if(!candidates.length) document.querySelectorAll('video,source,a[href*="x.com"],a[href*="twitter.com"]').forEach(n=>{if(n?.nodeType===1)candidates.push(n)});
     }catch{}
     const idCache=new WeakMap();
     const getIds=el=>{if(!el)return [];if(idCache.has(el))return idCache.get(el);const ids=twidougaIds(el);idCache.set(el,ids);return ids;};
     for(const node of candidates){
       let card=node,found=false;
       for(let i=0;i<8&&card;i++,card=card.parentElement){if(getIds(card).length){found=true;break;}}
       if(!card||seen.has(card)||!found)continue;
       const urls=findVideoUrls(card);if(!urls.size)continue;
       seen.add(card);emitRoot(card);
     }
  }

  function candidateRoots(node) {
    if (!node || node.nodeType !== 1) return [];
    // One nearest semantic root is enough for passive mutation handling.
    // Returning several ancestors caused each ancestor to be rescanned by
    // findVideoUrls(), multiplying DOM work on busy SPA pages.
    try {
      const c = node.closest?.('article,li,[role="article"],[class*="card" i],[class*="item" i],[class*="video" i],a,button');
      if (c) return [c];
    } catch {}
    const p = node.parentElement;
    return p && !/^(BODY|HTML)$/.test(p.tagName) ? [p] : [node];
  }

  function collectGenericRoots() {
    const roots = new Set();
    const selector = [
      'video','source','iframe',
      'a[href*=".mp4" i]','a[href*=".webm" i]','a[href*=".mov" i]','a[href*=".m4v" i]',
      'a[href*=".m3u8" i]','a[href*=".mpd" i]','a[href*="video.twimg.com" i]','a[href*="contents.html#contents=" i]',
      '[data-video]','[data-video-url]','[data-media]','[data-media-url]','[data-mp4]','[data-file]','[data-download]','[data-href]'
    ].join(',');
    try {
      document.querySelectorAll(selector).forEach(node => {
        if (node?.nodeType !== 1) return;
        for (const root of candidateRoots(node)) roots.add(root);
      });
    } catch {}
    return roots;
  }

  function bestMediaCard(root) {
    if (!root || root.nodeType !== 1) return null;
    // Do not repeatedly rescan the same subtree while climbing ancestors.
    // Prefer the nearest item-like container; otherwise keep the changed node.
    try {
      const c = root.closest?.('article,li,[role="article"],[class*="card" i],[class*="item" i],[class*="video" i]');
      if (c) {
        const urls = findVideoUrls(c);
        if (urls.size && urls.size <= 4) return c;
      }
    } catch {}
    return root;
  }

  // Legacy internal name used by the dedicated emitRoot path. Keep it as a
  // local alias so the generic adapter never throws on a non-site-specific item.
  function findCard(root) { return bestMediaCard(root) || root; }

  function emitGenericRoot(root) {
    const card = bestMediaCard(root) || root;
    const urls = findVideoUrls(card);
    const thumbnail = findThumbnail(card);
    const titleNode = card.querySelector?.('[data-title],[title],[aria-label],h1,h2,h3,h4,h5,h6');
    let name = clean(titleNode?.getAttribute('data-title') || titleNode?.getAttribute('title') || titleNode?.getAttribute('aria-label') || titleNode?.textContent);
    if (!name) {
      try {
        const lines = clean(String(card.textContent || '').slice(0, 4000)).split(/\n+/).map(clean).filter(Boolean);
        name = lines.find(x => x.length >= 2 && x.length <= 180 && !/^(direct|video|hls|dash|download|ダウンロード)$/i.test(x));
      } catch {}
    }
    let emitted = false;
    for (const url of urls) {
      if (!isVideoUrl(url)) continue;
      const type = /\.m3u8(?:[?#]|$)/i.test(url) ? 'hls' : /\.mpd(?:[?#]|$)/i.test(url) ? 'dash' : 'direct';
      const identity = identityUrl(url);
      emit({
        itemId: itemIdFor(url),
        identityUrl: identity,
        mediaUrl: url,
        url,
        type,
        thumbnail: thumbnail || null,
        name: name || undefined,
        pageUrl: location.href,
        landingPage: location.href,
        originUrl: location.href,
        source: 'generic-adapter',
        videoIdentity: {
          stableId: itemIdFor(url),
          mediaUrl: identity,
          filename: '',
          thumbnail: thumbnail || null
        }
      });
      emitted = true;
    }
    return emitted;
  }

  let timer = 0;
  let pendingMutationNodes = new Set();
  function scheduleTargeted(nodes) {
    for (const n of nodes || []) if (n?.nodeType === 1) pendingMutationNodes.add(n);
    if (!pendingMutationNodes.size) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
  // Adapter follows the shared detection tuning without owning the settings store.
  let detectionTuning = UVDDetectionTuning.normalize({});
  browser.storage.local.get('uvdSettingsPersisted').then(r => { detectionTuning = UVDDetectionTuning.normalize(r?.uvdSettingsPersisted || {}); }).catch(() => {});
  browser.storage.onChanged.addListener((changes, area) => { if(area==='local' && changes.uvdSettingsPersisted) detectionTuning = UVDDetectionTuning.normalize(changes.uvdSettingsPersisted.newValue || {}); });
      timer = 0;
      const nodes = [...pendingMutationNodes];
      pendingMutationNodes.clear();
      runTargeted(nodes);
    }, 350);
  }

  function runTargeted(nodes) {
    if (isTwiigle() || isTwidouga()) {
      // Dedicated adapters already have item-scoped handlers. Only inspect the
      // changed nodes for generic resource extraction here.
      try {
        for (const n of nodes || []) emitRoot(n);
      } catch {}
      return;
    }
    const roots = new Set();
    const addRoot = root => { if (root?.nodeType === 1) roots.add(root); };
    for (const node of nodes || []) {
      addRoot(node);
      // Only climb to the nearest semantic card. Never enumerate several
      // ancestors and rescan each subtree.
      try{
        const card=node.closest?.('article,li,[role="article"],[class*="card" i],[class*="item" i],[class*="video" i]');
        if(card) addRoot(card);
      }catch{}
    }
    for (const root of roots) emitGenericRoot(root);
    // Script/bootstrap data is inspected only when that script node was part of
    // the mutation. It is never searched across the entire document passively.
    for (const node of nodes || []) {
      if (String(node.tagName || '').toLowerCase() !== 'script') continue;
      for (const raw of embeddedUrls(node.textContent || '')) {
        if (!isVideoUrl(raw)) continue;
        emit({
          itemId: itemIdFor(raw), identityUrl: identityUrl(raw), mediaUrl: raw,
          url: raw, type: /\.m3u8(?:[?#]|$)/i.test(raw) ? 'hls' : /\.mpd(?:[?#]|$)/i.test(raw) ? 'dash' : 'direct',
          name: clean(document.title) || undefined, pageUrl: location.href,
          landingPage: location.href, originUrl: location.href, source: 'generic-adapter-script-mutation'
        });
      }
    }
  }

  function run() {
    if (isTwiigle()) { scanTwiigle(); return; }
    if (isTwidouga()) { scanTwidouga(); return; }
    const candidates = collectGenericRoots();
    for (const card of candidates) emitGenericRoot(card);
    try {
      document.querySelectorAll('script').forEach(script => {
        for (const raw of embeddedUrls(script.textContent || '')) {
          if (!isVideoUrl(raw)) continue;
          emit({
            itemId: itemIdFor(raw), identityUrl: identityUrl(raw), mediaUrl: raw,
            url: raw, type: /\.m3u8(?:[?#]|$)/i.test(raw) ? 'hls' : /\.mpd(?:[?#]|$)/i.test(raw) ? 'dash' : 'direct',
            name: clean(document.title) || undefined, pageUrl: location.href,
            landingPage: location.href, originUrl: location.href, source: 'generic-adapter-script'
          });
        }
      });
    } catch {}
  }

  // Initial page inspection is allowed once. Subsequent passive work is strictly
  // limited to nodes reported by the DOM event stream; no whole-document scan is
  // performed for every mutation.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, {once: true});
  else run();

  // Detector owns the single passive DOM observer. Generic Adapter receives
  // the already de-duplicated mutation batch instead of registering a second
  // observer over the same Document.
  window.addEventListener('__UVD_DOM_BATCH__', e => {
    const nodes = e?.detail?.nodes;
    if (Array.isArray(nodes) && nodes.length) scheduleTargeted(nodes);
  });

  // Explicit Update is allowed to request an active re-check. The adapter
  // itself still performs only DOM/resource inspection; scrolling and other
  // active acquisition remain owned by detector.js.
  window.addEventListener('__UVD_ACTIVE_RESCAN__', () => {
    if (isTwiigle()) return; // Twiigle has its dedicated path above.
    schedule();
  });
  });
})();
