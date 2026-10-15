// Runs before the popup paints: apply the remembered theme and language so the
// page does not flash in the wrong colors or direction. The settings store
// (IndexedDB, via the service worker) stays the source of truth.
try {
  const root = document.documentElement;
  const theme = localStorage.getItem('esc.theme');
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  const lang = localStorage.getItem('esc.lang');
  if (lang) {
    root.lang = lang;
    root.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }
} catch {
  // Storage unavailable: defaults apply.
}
