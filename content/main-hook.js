(() => {
  // main-hook runs in the page context, so forward only its uncaught errors to the extension content script.
  const isMainHookError = event => {
    const filename = String(event?.filename || '');
    const stack = event?.error?.stack ? String(event.error.stack) : '';
    return filename.includes('/content/main-hook.js') || stack.includes('/content/main-hook.js');
  };
  const reportHookError = (error, context) => {
    try {
      window.dispatchEvent(new CustomEvent('__UVD_HOOK_ERROR__', {
        detail: { message: error instanceof Error ? (error.stack || error.message) : String(error || 'Unknown error'), context }
      }));
    } catch {}
  };
  window.addEventListener('error', event => {
    if (isMainHookError(event)) reportHookError(event.error || event.message, 'main-hook.window.error');
  });
  window.addEventListener('unhandledrejection', event => reportHookError(event.reason, 'main-hook.unhandledrejection'));
  if (window.__UVD_MAIN_HOOK__) return;
  window.__UVD_MAIN_HOOK__ = true;
  // Tuning arrives from the isolated content-script realm via a DOM event.
  let detectionTuning = {analysisMaxResponseMB:20,streamAnalysis:true,extensionlessDetection:true,jsonDetection:true,networkDetection:true};
  window.addEventListener('__UVD_DETECTION_TUNING__', event => { if(event.detail&&typeof event.detail==='object') detectionTuning={...detectionTuning,...event.detail}; });

  const isVideoUrl = u => /\.(?:m3u8|mpd|mp4|webm|mov|m4v)(?:[?#]|$)/i.test(String(u || ''));
  const emit = item => { if (!item?.url) return; try { window.dispatchEvent(new CustomEvent('__UVD_VIDEO_URL__',{detail:item})); } catch {} };
  const normalizeUrl = (u, base=location.href) => { try { return new URL(u,base).href; } catch { return null; } };
  const embeddedVideoUrls = (value, base=location.href) => {
    const out=new Set();
    if(typeof value!=='string'||!value)return out;
    let s=value.replace(/\\\//g,'/');
    for(let i=0;i<4;i++){try{const d=decodeURIComponent(s);if(d===s)break;s=d}catch{break}}
    const add=u=>{const n=normalizeUrl(u,base);if(n&&isVideoUrl(n))out.add(n)};
    try{const u=new URL(s,base);for(const v of u.searchParams.values())if(/^https?:/i.test(v))add(v);const h=u.hash.replace(/^#/,'');for(const part of h.split('&')){const eq=part.indexOf('=');if(eq>=0){const v=decodeURIComponent(part.slice(eq+1));if(/^https?:/i.test(v))add(v);}}}catch{}
    for(const m of s.matchAll(/https?:\/\/[^\s"'<>\\\]}),]+/gi))add(m[0]);
    return out;
  };
  const paginationSeen = new Set(), paginationRunning = new Set();
  let activeAcquisition = false;
  let activeAcquisitionToken = 0;
  window.addEventListener('__UVD_ACTIVE_RESCAN_START__', () => { activeAcquisition = true; activeAcquisitionToken++; });
  window.addEventListener('__UVD_ACTIVE_RESCAN_END__', () => { activeAcquisition = false; });
  const requestTemplates = new Map();
  const MAX_REQUEST_TEMPLATES = 160;
  function rememberRequestTemplate(key, desc){
    if(!key || !desc) return;
    requestTemplates.set(key, desc);
    if(requestTemplates.size > MAX_REQUEST_TEMPLATES){
      const first=requestTemplates.keys().next().value;
      if(first) requestTemplates.delete(first);
    }
  }
  const pageNames=/^(pageNo|pageno|page|currentPage|current_page|pageIndex|page_index|current|current_page_number|pageNumber|page_number)$/i;
  const sizeNames=/^(pageSize|pagesize|limit|size|perPage|per_page|take|count|length)$/i;
  const offsetNames=/^(offset|start|skip|from)$/i;
  const cursorNames=/^(cursor|pageToken|page_token|continuationToken|continuation_token|nextCursor|next_cursor|nextPageToken|next_page_token)$/i;
  const listNames=['list','items','records','results','videos','files','rows','contents'];
  const totalNames=['total','totalCount','total_count','totalItems','total_items','count'];

  function isObject(v){return v&&typeof v==='object'&&!Array.isArray(v);}
  function looksMedia(v){
    if(!isObject(v))return false;
    return Object.keys(v).some(k=>/(m3u8|mpd|video.?url|file.?url|download.?url|thumbnail|poster|video.?id|media.?id|filename|fileName|title)/i.test(k));
  }
  function findPageInfo(obj,depth=0){
    if(!isObject(obj)||depth>8)return null;
    let list=null,listKey=null,total=null,totalKey=null,next=null,nextKey=null;
    for(const k of listNames)if(Array.isArray(obj[k])){list=obj[k];listKey=k;break;}
    for(const k of totalNames)if(Number.isFinite(Number(obj[k]))){total=Number(obj[k]);totalKey=k;break;}
    for(const k of Object.keys(obj))if(cursorNames.test(k)&&obj[k]!=null&&String(obj[k])){next=String(obj[k]);nextKey=k;break;}
    if(list) return {list,listKey,total,totalKey,next,nextKey};
    for(const v of Object.values(obj)){const r=findPageInfo(v,depth+1);if(r)return r;}
    return null;
  }
  function jsonParse(text){try{return JSON.parse(text);}catch{return null;}}

  function cloneBody(body){
    if(body==null)return null;
    if(typeof body==='string')return body;
    if(body instanceof URLSearchParams)return body.toString();
    if(body instanceof Blob)return body;
    return null;
  }
  function modifyBody(body,changes){
    if(body==null)return null;
    if(typeof body==='string'){
      const trimmed=body.trim();
      if((trimmed.startsWith('{')&&trimmed.endsWith('}'))){
        try{const o=JSON.parse(body);for(const [k,v] of Object.entries(changes))o[k]=v;return JSON.stringify(o);}catch{}
      }
      try{const sp=new URLSearchParams(body);for(const [k,v] of Object.entries(changes))sp.set(k,String(v));return sp.toString();}catch{}
    }
    return null;
  }
  function headersFor(desc){
    const h=new Headers();
    if(desc?.headers && typeof desc.headers==='object')for(const [k,v] of Object.entries(desc.headers)){
      if(!/^(host|content-length|cookie|origin|referer|sec-|user-agent)$/i.test(k))try{h.set(k,v);}catch{}
    }
    return h;
  }
  async function replayRequest(desc,url,changes){
    if(!desc)return null;
    const method=String(desc.method||'GET').toUpperCase();
    const target=normalizeUrl(url||desc.url); if(!target)return null;
    let body=desc.body;
    if(method!=='GET'&&method!=='HEAD'&&changes)body=modifyBody(body,changes);
    const init={method,credentials:'include',headers:headersFor(desc)};
    if(method!=='GET'&&method!=='HEAD'&&body!=null)init.body=body;
    try{const r=await originalFetch(target,init);return {url:target,text:await r.text()};}catch{return null;}
  }
  async function fetchUrl(desc,url,changes){
    const key=`${desc?.method||'GET'} ${url} ${JSON.stringify(changes||{})}`;
    if(paginationSeen.has(key)||paginationRunning.has(key))return;
    paginationRunning.add(key);
    try{const out=await replayRequest(desc,url,changes);if(out){paginationSeen.add(key);emitText(out.url,out.text,'pagination-api',desc);}}finally{paginationRunning.delete(key);}
  }
  function getParamKey(url,names){try{return [...new URL(url,location.href).searchParams.keys()].find(k=>names.test(k));}catch{return null;}}

  function getObjectParam(obj,names){
    if(!isObject(obj))return null;
    for(const k of Object.keys(obj)) if(names.test(k)) return {key:k,value:obj[k]};
    return null;
  }
  function setRequestParam(desc,apiUrl,key,value,bodyChanges={}){
    if(!desc)return;
    const method=String(desc.method||'GET').toUpperCase();
    if(method==='GET'||method==='HEAD'){
      const nu=new URL(apiUrl,location.href); nu.searchParams.set(key,String(value)); fetchUrl(desc,nu.href,null);
    }else{
      const changes={...bodyChanges,[key]:value}; fetchUrl(desc,apiUrl,changes);
    }
  }
  function requestAllPages(apiUrl,info,desc,rootObj){
    // Rule 101/102: passive background detection may inspect observed responses,
    // but may not initiate pagination or additional acquisition.
    if(!activeAcquisition)return;
    if(!apiUrl||!info||!Array.isArray(info.list)||!info.list.some(looksMedia))return;
    const u=new URL(apiUrl,location.href);
    const method=String(desc?.method||'GET').toUpperCase();
    const urlPage=getParamKey(apiUrl,pageNames), urlSize=getParamKey(apiUrl,sizeNames), urlOffset=getParamKey(apiUrl,offsetNames), urlCursor=getParamKey(apiUrl,cursorNames);
    const bodyPage=getObjectParam(desc?.body&&jsonParse(desc.body),pageNames);
    const bodySize=getObjectParam(desc?.body&&jsonParse(desc.body),sizeNames);
    const bodyOffset=getObjectParam(desc?.body&&jsonParse(desc.body),offsetNames);
    const bodyCursor=getObjectParam(desc?.body&&jsonParse(desc.body),cursorNames);
    const responsePage=getObjectParam(rootObj,pageNames);
    const responseSize=getObjectParam(rootObj,sizeNames);
    const responseOffset=getObjectParam(rootObj,offsetNames);
    const responseCursor=getObjectParam(rootObj,cursorNames);
    const pageKey=urlPage||bodyPage?.key||responsePage?.key;
    const sizeKey=urlSize||bodySize?.key||responseSize?.key;
    const offsetKey=urlOffset||bodyOffset?.key||responseOffset?.key;
    const cursorKey=urlCursor||bodyCursor?.key||responseCursor?.key;
    const page=Math.max(1,Number(urlPage?u.searchParams.get(urlPage):bodyPage?.value)||Number(getObjectParam(rootObj,pageNames)?.value)||1);
    const size=Math.max(1,Math.min(Number(urlSize?u.searchParams.get(urlSize):bodySize?.value)||Number(getObjectParam(rootObj,sizeNames)?.value)||info.list.length||20,500));
    const totalObj=getObjectParam(rootObj,totalNames); const total=totalObj&&Number.isFinite(Number(totalObj.value))?Number(totalObj.value):Number.isFinite(Number(info.total))?Number(info.total):null;
    const next=info.next||responseCursor?.value;

    if(next && cursorKey){
      if(method==='GET'||method==='HEAD'){const nu=new URL(apiUrl,location.href);nu.searchParams.set(cursorKey,String(next));fetchUrl(desc,nu.href,null);}
      else fetchUrl(desc,apiUrl,{[cursorKey]:next});
      return;
    }
    if(total!=null && total>info.list.length){
      if(pageKey){
        const pages=Math.min(100,Math.ceil(total/size));
        // Serialize active pagination for every site. A response can schedule
        // only its immediate successor; this prevents request storms when a
        // response reports a large total page count.
        const nextPage=page+1;
        if(nextPage<=pages) setRequestParam(desc,apiUrl,pageKey,nextPage);
        return;
      }
      if(offsetKey){
        const current=Number(urlOffset?u.searchParams.get(urlOffset):bodyOffset?.value)||0;
        const nextOffset=current+size;
        if(nextOffset<total){
          if(method==='GET'||method==='HEAD'){const nu=new URL(apiUrl,location.href);nu.searchParams.set(offsetKey,String(nextOffset));if(sizeKey)nu.searchParams.set(sizeKey,String(size));fetchUrl(desc,nu.href,null);}
          else fetchUrl(desc,apiUrl,{[offsetKey]:nextOffset,...(sizeKey?{[sizeKey]:size}:{})});
        }
        return;
      }
      if(sizeKey){
        // Some APIs return only the default 20 items but accept a larger limit.
        if(method==='GET'||method==='HEAD'){const nu=new URL(apiUrl,location.href);nu.searchParams.set(sizeKey,String(Math.min(total,500)));fetchUrl(desc,nu.href,null);}
        else fetchUrl(desc,apiUrl,{[sizeKey]:Math.min(total,500)});
        return;
      }
    }
    // No total: follow an observed page/offset one page at a time. This also handles
    // APIs where pagination parameters live in a POST JSON body rather than the URL.
    if(info.list.length>=size){
      if(pageKey){ setRequestParam(desc,apiUrl,pageKey,page+1); return; }
      if(offsetKey){
        const current=Number(urlOffset?u.searchParams.get(urlOffset):bodyOffset?.value)||0;
        if(current<99*size){
          if(method==='GET'||method==='HEAD'){const nu=new URL(apiUrl,location.href);nu.searchParams.set(offsetKey,String(current+size));if(sizeKey)nu.searchParams.set(sizeKey,String(size));fetchUrl(desc,nu.href,null);}
          else fetchUrl(desc,apiUrl,{[offsetKey]:current+size,...(sizeKey?{[sizeKey]:size}:{})});
        }
        return;
      }
      // If the request itself has no pagination parameter, make one conservative
      // larger-limit request. Many infinite-scroll endpoints use an implicit limit.
      // Do this only for a media-list response, never for arbitrary responses.
      if(sizeKey){
        const larger=Math.min(500,Math.max(size*5,100));
        if(method==='GET'||method==='HEAD'){const nu=new URL(apiUrl,location.href);nu.searchParams.set(sizeKey,String(larger));fetchUrl(desc,nu.href,null);}
        else fetchUrl(desc,apiUrl,{[sizeKey]:larger});
      } else if(method==='GET'||method==='HEAD') {
        // Probe conventional page=2 only when the response is exactly a full media page.
        const nu=new URL(apiUrl,location.href);nu.searchParams.set('page','2');fetchUrl(desc,nu.href,null);
      } else {
        // POST JSON without an observed page field: try the common page/limit pair.
        if(jsonParse(desc?.body)){ fetchUrl(desc,apiUrl,{page:2,limit:size}); }
      }
    }
  }

  const titleKeys=['title','name','videoTitle','displayName','caption','subject'];
  const imageKeys=['thumbnail','thumb','poster','cover','coverImage','image','imageUrl','coverUrl'];
  const pick=(v,keys)=>{for(const k of keys)if(typeof v?.[k]==='string'&&v[k].trim())return v[k].trim();};

  function walk(value,apiUrl,desc,depth=0,inheritedPageItemIdentity=''){
    if(!value||typeof value!=='object'||depth>30)return;
    if(Array.isArray(value)){for(const x of value)walk(x,apiUrl,desc,depth+1,inheritedPageItemIdentity);return;}
    if(activeAcquisition){const info=findPageInfo(value);if(info)requestAllPages(apiUrl,info,desc,value);}
    const localPageItemId=(value.tweetId??value.statusId??value.postId);
    const pageItemIdentity=localPageItemId!=null&&String(localPageItemId).trim()?`twiigle:tweet:${String(localPageItemId).trim()}`:inheritedPageItemIdentity;
    const mediaKeys=['m3u8Url','m3u8URL','playlistUrl','playlist','manifestUrl','manifest','videoUrl','videoURL','fileUrl','fileURL','downloadUrl','downloadURL','src','url','video','media','source','stream'];
    for(const key of mediaKeys){
      const raw=value[key];if(typeof raw!=='string')continue;
      const candidates=new Set();
      const direct=normalizeUrl(raw,apiUrl||location.href);if(direct)candidates.add(direct);
      for(const u of embeddedVideoUrls(raw,apiUrl||location.href))candidates.add(u);
      for(const url of candidates){
        if(!isVideoUrl(url))continue;
        const type=/\.m3u8(?:[?#]|$)/i.test(url)?'hls':/\.mpd(?:[?#]|$)/i.test(url)?'dash':'direct';
        emit({url,type,source:'api-response',apiUrl,
          name:pick(value,titleKeys),filename:value.fileName||value.filename,
          thumbnail:pick(value,imageKeys),fileSize:value.fileSize||value.size,duration:value.duration||value.length,
          id:value.id??value.videoId??value.videoID??value.mediaId??value.mediaID,
          pageItemIdentity,
          landingPage:value.landingPage||value.pageUrl||value.href});
      }
    }
    // Some ranking APIs wrap the real media URL inside a JSON string or nested
    // object under a site-specific field. Inspect string leaves as well, but only
    // emit URLs that are already classified as video resources.
    for(const [k,v] of Object.entries(value)){
      if(typeof v!=='string'||mediaKeys.includes(k))continue;
      const decoded=v.replace(/\\\//g,'/');
      for(const m of decoded.matchAll(/https?:\/\/[^\s"'<>\\]+/gi)){
        const u=normalizeUrl(m[0],apiUrl||location.href);
        if(!u||!isVideoUrl(u))continue;
        emit({url:u,type:/\.m3u8(?:[?#]|$)/i.test(u)?'hls':/\.mpd(?:[?#]|$)/i.test(u)?'dash':'direct',source:'api-response-nested',apiUrl,
          name:pick(value,titleKeys),filename:value.fileName||value.filename,thumbnail:pick(value,imageKeys),
          id:value.tweetId??value.statusId??value.postId??value.videoId??value.mediaId??undefined,
          pageItemIdentity,
          landingPage:value.landingPage||value.pageUrl||value.href});
      }
    }
    for(const v of Object.values(value))walk(v,apiUrl,desc,depth+1,pageItemIdentity);
  }
  const MAX_TEXT_SCAN_BYTES = 1 * 1024 * 1024;
  const STREAM_OVERLAP_CHARS = 4096;
  const VIDEO_TEXT_HINT = /(?:\.m3u8(?:[?#\s]|$)|\.mpd(?:[?#\s]|$)|\.(?:mp4|webm|mov|m4v)(?:[?#\s]|$)|video\.twimg\.com)/i;
  function emitText(apiUrl,text,source,desc){
    if(!text||typeof text!=='string')return;
    // Cheap candidate check first. Only small candidate-bearing payloads enter
    // JSON/object analysis. Larger payloads use URL extraction only.
    if(!VIDEO_TEXT_HINT.test(text))return;
    const size=text.length;
    if(detectionTuning.jsonDetection!==false && size<=Math.max(1,Number(detectionTuning.analysisMaxResponseMB)||1)*1024*1024){
      const obj=jsonParse(text);
      if(obj){
        // Pagination is an active-acquisition feature only. Passive responses
        // must never start additional acquisition.
        walk(obj,apiUrl,desc);
        return;
      }
    }
    const re=/https?:\/\/[^\s"'<>\\]+/g;
    for(const m of text.matchAll(re)){
      const u=normalizeUrl(m[0].replace(/\\\//g,'/'),apiUrl||location.href);
      if(u&&isVideoUrl(u))emit({url:u,source,apiUrl,type:/\.m3u8/i.test(u)?'hls':/\.mpd/i.test(u)?'dash':'direct'});
    }
  }
  function scanResponseChunk(text,apiUrl,source){
    if(!text||!VIDEO_TEXT_HINT.test(text))return;
    const re=/https?:\/\/[^\s"'<>\\]+/g;
    for(const m of text.matchAll(re)){
      const u=normalizeUrl(m[0].replace(/\\\//g,'/'),apiUrl||location.href);
      if(u&&isVideoUrl(u))emit({url:u,source,apiUrl,type:/\.m3u8/i.test(u)?'hls':/\.mpd/i.test(u)?'dash':'direct'});
    }
  }
  async function streamFetchForVideoUrls(response,apiUrl,source){
    try{
      if(!response?.body?.getReader)return false;
      const reader=response.body.getReader();
      const decoder=new TextDecoder();
      let carry='',total=0;
      while(total<20*1024*1024){
        const {value,done}=await reader.read();
        if(done)break;
        total+=value?.byteLength||0;
        const chunk=carry+decoder.decode(value,{stream:true});
        scanResponseChunk(chunk,apiUrl,source);
        carry=chunk.slice(-STREAM_OVERLAP_CHARS);
        if(total>=20*1024*1024)break;
      }
      try{reader.cancel();}catch{}
      return true;
    }catch{return false}
  }
  const binaryUrlRe=/\.(?:m4s|ts|mp4|webm|mkv|mov|m4v|mp3|aac|jpg|jpeg|png|gif|webp|avif|woff|woff2|wasm|bin)(?:[?#]|$)/i;
  const binaryTypeRe=/^(?:video|audio|image|font)\//i;
  const binaryExactTypeRe=/^(?:application\/(?:octet-stream|wasm)|application\/(?:x-)?7z-compressed|application\/zip)$/i;
  const textTypeRe=/^(?:text\/|application\/(?:json|javascript|x-javascript|graphql|ld\+json|manifest\+json|vnd\.api\+json|x-ndjson))/i;
  function shouldReadResponse(url,headers,responseType){
    const u=String(url||'');
    if(binaryUrlRe.test(u))return false;
    const ct=String(headers?.get?.('content-type')||'').split(';',1)[0].trim().toLowerCase();
    if(binaryTypeRe.test(ct)||binaryExactTypeRe.test(ct))return false;
    if(responseType && responseType!=='text')return false;
    if(textTypeRe.test(ct))return true;
    // Servers without a Content-Type header are handled only when the URL
    // itself strongly indicates an API/text response. This avoids cloning and
    // reading arbitrary HTML/binary responses across busy pages.
    return /(?:\/api(?:\/|$)|graphql|\.json(?:[?#]|$)|\.graphql(?:[?#]|$))/i.test(u);
  }
  function responseTextLimit(headers){
    const n=Number(headers?.get?.('content-length'));
    // Keep the hard ceiling below the old 20MB threshold. The 4MB analysis
    // path above is the only route that performs JSON/object analysis.
    return Number.isFinite(n)&&n>Math.max(1,Number(detectionTuning.analysisMaxResponseMB)||20)*1024*1024;
  }
  const originalFetch=window.fetch.bind(window);
  window.fetch=function(...args){
    if(detectionTuning.networkDetection===false)return originalFetch(...args);
    const input=args[0],init=args[1]||{};let reqUrl=typeof input==='string'?input:input?.url;let method=String(init.method||(input?.method)||'GET').toUpperCase();let body=cloneBody(init.body);
    const desc={url:reqUrl,method,body,headers:init.headers||{}};
    if(reqUrl && (activeAcquisition || /(?:\/api(?:\/|$)|graphql|\.json(?:[?#]|$))/i.test(String(reqUrl)))) rememberRequestTemplate(normalizeUrl(reqUrl),desc);
    return originalFetch(...args).then(response=>{
      if(!shouldReadResponse(reqUrl,response.headers,''))return response;
      if(responseTextLimit(response.headers)){
        if(detectionTuning.streamAnalysis===false)return response;
        // Do not clone large bodies into a second full string. Read a bounded
        // stream from a clone and only perform lightweight video-URL extraction.
        try{const clone=response.clone();streamFetchForVideoUrls(clone,reqUrl,'fetch-response-stream').catch(()=>{});}catch{}
        return response;
      }
      try{response.clone().text().then(t=>emitText(reqUrl,t,'fetch-response',desc)).catch(()=>{});}catch{}
      return response;
    });
  };

  const open=XMLHttpRequest.prototype.open,send=XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open=function(method,url,...rest){this.__UVD_METHOD__=method;this.__UVD_URL__=url;return open.call(this,method,url,...rest);};
  XMLHttpRequest.prototype.send=function(body){
    if(detectionTuning.networkDetection===false)return send.call(this,body);const desc={url:this.__UVD_URL__,method:String(this.__UVD_METHOD__||'GET').toUpperCase(),body:cloneBody(body),headers:{}};if(desc.url && (activeAcquisition || /(?:\/api(?:\/|$)|graphql|\.json(?:[?#]|$))/i.test(String(desc.url)))) rememberRequestTemplate(normalizeUrl(desc.url),desc);this.addEventListener('load',()=>{try{if(!shouldReadResponse(this.__UVD_URL__,{get:k=>this.getResponseHeader(k)},this.responseType))return;const cl=Number(this.getResponseHeader('content-length'));if(Number.isFinite(cl)&&cl>(Math.max(1,Number(detectionTuning.analysisMaxResponseMB)||20)*1024*1024))return;emitText(this.__UVD_URL__,this.responseText,'xhr-response',desc);}catch{}});return send.call(this,body);};

  const emitDomMetadata=()=>{try{
    const imgs=[...document.querySelectorAll('article img,li img,[role=article] img,a img,video+img')].slice(0,120);
    for(const img of imgs){const src=img.currentSrc||img.src;if(!src)continue;const c=img.closest('article,li,[role=article],a,button');if(!c)continue;const e=c.querySelector('[title],[aria-label],[data-title],h1,h2,h3,h4');const name=(e?.getAttribute('data-title')||e?.getAttribute('title')||e?.getAttribute('aria-label')||e?.textContent||'').trim();if(name)window.dispatchEvent(new CustomEvent('__UVD_METADATA__',{detail:{thumbnail:src,name,source:'dom-metadata'}}));}
  }catch{}};
  const idle=window.requestIdleCallback||((cb)=>setTimeout(()=>cb({timeRemaining:()=>0}),800));
  idle(emitDomMetadata,{timeout:1500});
})();
