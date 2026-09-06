(() => {
  // Shared detection tuning definition. Background, popup, and content scripts use the same limits.
  const SAFE_LIMITS = Object.freeze({
    analysisMaxResponseMB: Object.freeze({min: 5, max: 50}),
    analysisMaxDepth: Object.freeze({min: 8, max: 20}),
    analysisMaxNodes: Object.freeze({min: 250, max: 2000}),
    analysisTimeBudgetMs: Object.freeze({min: 2, max: 10}),
    maxMutationNodes: Object.freeze({min: 32, max: 256})
  });

  // Built-in presets intentionally include future-phase fields, but only Phase 1 fields are active now.
  const PRESETS = Object.freeze({
    low: Object.freeze({analysisPreset:'low', mode:'auto', dynamicWait:600, dynamicScrollAttempts:3, maxSeconds:15, analysisMaxResponseMB:5, analysisMaxDepth:8, analysisMaxNodes:250, analysisTimeBudgetMs:2, maxMutationNodes:64, streamAnalysis:false, extensionlessDetection:false, domDetection:true, networkDetection:true, jsonDetection:false, urlCandidateDetection:true}),
    standard: Object.freeze({analysisPreset:'standard', mode:'auto', dynamicWait:300, dynamicScrollAttempts:5, maxSeconds:15, analysisMaxResponseMB:20, analysisMaxDepth:15, analysisMaxNodes:1000, analysisTimeBudgetMs:5, maxMutationNodes:128, streamAnalysis:true, extensionlessDetection:true, domDetection:true, networkDetection:true, jsonDetection:true, urlCandidateDetection:true}),
    high: Object.freeze({analysisPreset:'high', mode:'hybrid', dynamicWait:250, dynamicScrollAttempts:7, maxSeconds:60, analysisMaxResponseMB:35, analysisMaxDepth:18, analysisMaxNodes:1500, analysisTimeBudgetMs:8, maxMutationNodes:192, streamAnalysis:true, extensionlessDetection:true, domDetection:true, networkDetection:true, jsonDetection:true, urlCandidateDetection:true}),
    maximum: Object.freeze({analysisPreset:'maximum', mode:'hybrid', dynamicWait:180, dynamicScrollAttempts:10, maxSeconds:90, analysisMaxResponseMB:50, analysisMaxDepth:20, analysisMaxNodes:2000, analysisTimeBudgetMs:10, maxMutationNodes:256, streamAnalysis:true, extensionlessDetection:true, domDetection:true, networkDetection:true, jsonDetection:true, urlCandidateDetection:true})
  });

  // Default values cover both the currently active Phase 1 controls and future tuning controls.
  const DEFAULTS = Object.freeze({analysisPreset:'standard', mode:'auto', dynamicWait:150, dynamicScrollAttempts:2, maxSeconds:15, restorePosition:true, analysisMaxResponseMB:20, analysisMaxDepth:15, analysisMaxNodes:1000, analysisTimeBudgetMs:5, maxMutationNodes:128, streamAnalysis:true, extensionlessDetection:true, domDetection:true, networkDetection:true, jsonDetection:true, urlCandidateDetection:true, siteAccessMode:'all', whitelistSites:[], blacklistSites:[]});

  // Clamp every externally supplied value before it can affect detection work.
  function clampNumber(value, limits, fallback) {
    // Numeric candidate after conversion; invalid values fall back safely.
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(limits.min, Math.min(limits.max, number));
  }

  // Normalize site entries to hostnames/origins used by listener gating.
  function normalizeSiteList(value) {
    const source = Array.isArray(value) ? value : [];
    return [...new Set(source.map(item => String(item || '').trim().toLowerCase()).filter(Boolean))];
  }

  // Decide whether passive video listeners may start for the current page.
  function isSiteAllowed(url, settings = {}) {
    let hostname = '';
    let origin = '';
    try { const parsed = new URL(String(url || '')); hostname = parsed.hostname.toLowerCase(); origin = parsed.origin.toLowerCase(); } catch { return false; }
    const mode = settings.siteAccessMode || 'all';
    const matches = entry => { const value = String(entry || '').trim().toLowerCase().replace(/\/$/, ''); return value === hostname || value === origin || (value.startsWith('*.') && hostname.endsWith(value.slice(1))); };
    const list = mode === 'whitelist' ? settings.whitelistSites : settings.blacklistSites;
    const matched = normalizeSiteList(list).some(matches);
    return mode === 'whitelist' ? matched : mode === 'blacklist' ? !matched : true;
  }

  // Normalize one detection tuning object without mutating the caller's object.
  function normalize(value) {
    // Caller-provided settings object; never mutate it in place.
    const source = value && typeof value === 'object' ? value : {};
    return {
      ...DEFAULTS,
      ...source,
      analysisMaxResponseMB: clampNumber(source.analysisMaxResponseMB, SAFE_LIMITS.analysisMaxResponseMB, DEFAULTS.analysisMaxResponseMB),
      analysisMaxDepth: clampNumber(source.analysisMaxDepth, SAFE_LIMITS.analysisMaxDepth, DEFAULTS.analysisMaxDepth),
      analysisMaxNodes: clampNumber(source.analysisMaxNodes, SAFE_LIMITS.analysisMaxNodes, DEFAULTS.analysisMaxNodes),
      analysisTimeBudgetMs: clampNumber(source.analysisTimeBudgetMs, SAFE_LIMITS.analysisTimeBudgetMs, DEFAULTS.analysisTimeBudgetMs),
      maxMutationNodes: clampNumber(source.maxMutationNodes, SAFE_LIMITS.maxMutationNodes, DEFAULTS.maxMutationNodes),
      mode: ['auto','dynamic','static','hybrid','manual'].includes(source.mode) ? source.mode : DEFAULTS.mode,
      dynamicWait: Math.max(0, Math.min(1500, Number(source.dynamicWait) || DEFAULTS.dynamicWait)),
      dynamicScrollAttempts: Math.max(2, Math.min(10, Number(source.dynamicScrollAttempts) || DEFAULTS.dynamicScrollAttempts)),
      maxSeconds: Math.max(5, Math.min(300, Number(source.maxSeconds) || DEFAULTS.maxSeconds)),
      restorePosition: source.restorePosition !== false,
      streamAnalysis: source.streamAnalysis !== false,
      extensionlessDetection: source.extensionlessDetection !== false,
      domDetection: source.domDetection !== false,
      networkDetection: source.networkDetection !== false,
      jsonDetection: source.jsonDetection !== false,
      urlCandidateDetection: source.urlCandidateDetection !== false,
      siteAccessMode: source.siteAccessMode === 'whitelist' || source.siteAccessMode === 'blacklist' ? source.siteAccessMode : 'all',
      whitelistSites: normalizeSiteList(source.whitelistSites),
      blacklistSites: normalizeSiteList(source.blacklistSites)
    };
  }

  // Apply a named preset and then clamp its values to the absolute safety limits.
  function applyPreset(name, current = {}) {
    const preset = PRESETS[name];
    return normalize({...current, ...(preset || PRESETS.standard), analysisPreset:name || 'standard'});
  }

  // Return only the settings that belong to the detection tuning subsystem.
  function extract(value) {
    // Fully clamped configuration used as the preset snapshot source.
    const normalized = normalize(value);
    // Preset snapshot containing only detection-related fields.
    const out = {};
    for (const key of Object.keys(DEFAULTS)) out[key] = normalized[key]; // Copy each named detection field.
    return out;
  }

  globalThis.UVDDetectionTuning = Object.freeze({SAFE_LIMITS, PRESETS, DEFAULTS, normalize, applyPreset, extract, normalizeSiteList, isSiteAllowed});
})();
