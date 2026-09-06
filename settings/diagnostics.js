(() => {
  if (globalThis.UVDDiagnostics) return;

  const ERROR_LOG_KEY = 'uvdErrorLogs';
  const ERROR_LOG_LIMIT = 500;
  const FLUSH_DELAY_MS = 150;
  let queue = [];
  let flushTimer = 0;
  let flushing = false;

  function detectSource() {
    if (typeof document !== 'undefined') {
      if (location?.pathname?.includes('/ui/')) return 'popup';
      return 'content';
    }
    return 'background';
  }

  function stringifyError(value) {
    if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
    if (value && typeof value === 'object') {
      try { return JSON.stringify(value); } catch { return String(value); }
    }
    return String(value ?? 'Unknown error');
  }

  function enqueue(record) {
    queue.push(record);
    if (queue.length > 50) queue.splice(0, queue.length - 50);
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
  }

  async function flush() {
    flushTimer = 0;
    if (flushing || !queue.length || !globalThis.browser?.storage?.local) return;
    flushing = true;
    const batch = queue.splice(0);
    try {
      const stored = await browser.storage.local.get(ERROR_LOG_KEY);
      const logs = Array.isArray(stored[ERROR_LOG_KEY]) ? stored[ERROR_LOG_KEY] : [];
      logs.push(...batch);
      if (logs.length > ERROR_LOG_LIMIT) logs.splice(0, logs.length - ERROR_LOG_LIMIT);
      await browser.storage.local.set({ [ERROR_LOG_KEY]: logs });
    } catch {
      // Diagnostics must never throw or create another error while handling one.
    } finally {
      flushing = false;
      if (queue.length && !flushTimer) flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
    }
  }

  function reportError(error, context = '', extra = {}) {
    enqueue({
      ts: Date.now(),
      level: 'ERROR',
      source: detectSource(),
      context: String(context || ''),
      message: stringifyError(error),
      pageUrl: typeof location !== 'undefined' ? String(location.href || '') : '',
      ...extra
    });
  }

  function reportMessage(message, context = '', extra = {}) {
    reportError(String(message || 'Unknown error'), context, extra);
  }

  const api = Object.freeze({ reportError, reportMessage, flush });
  globalThis.UVDDiagnostics = api;

  // Capture errors that escape normal UVD catch blocks.
  function isLikelyExternalPageScriptError(event) {
    const message = String(event?.message || '');
    const filename = String(event?.filename || '');
    // Cross-origin page failures commonly arrive as the uninformative
    // "Script error.". They are page errors, not actionable UVD errors.
    // Do not fill the UVD diagnostics panel with them.
    return detectSource() === 'content' && message === 'Script error.' && !filename.startsWith('moz-extension://');
  }

  if (typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('error', event => {
      if (isLikelyExternalPageScriptError(event)) return;
      reportError(event.error || event.message || 'Unhandled error', 'window.error', {
        filename: String(event.filename || ''),
        line: Number(event.lineno) || 0,
        column: Number(event.colno) || 0
      });
    });
    globalThis.addEventListener('unhandledrejection', event => {
      reportError(event.reason || 'Unhandled promise rejection', 'unhandledrejection');
    });
  }

  // Capture UVD console.error output so caught errors are also retained.
  if (globalThis.console?.error && !console.error.__uvdWrapped) {
    const originalError = console.error.bind(console);
    const wrappedError = (...args) => {
      try {
        reportError(args.map(stringifyError).join(' '), 'console.error');
      } finally {
        originalError(...args);
      }
    };
    Object.defineProperty(wrappedError, '__uvdWrapped', { value: true });
    console.error = wrappedError;
  }
})();
