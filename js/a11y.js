// Accessibility helpers: a polite screen-reader announcer and a modal focus
// trap. Kept tiny and dependency-free — the game stays fully playable if any
// of this is unsupported.

let liveRegion = null;

// Announce a transient status ("Game over", "Paused", …) to assistive tech via
// an aria-live region. Clearing first guarantees an identical repeat message is
// still spoken.
export function announce(msg){
  if (!liveRegion) liveRegion = document.getElementById('sr-status');
  if (!liveRegion) return;
  liveRegion.textContent = '';
  requestAnimationFrame(() => { liveRegion.textContent = msg; });
}

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

// Trap Tab focus inside `container`, move focus to `initial` (or the first
// focusable), and return a release() that restores focus to where it was.
export function trapFocus(container, initial){
  if (!container) return () => {};
  const prev = document.activeElement;
  const visibleFocusables = () =>
    [...container.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);

  const first = initial || visibleFocusables()[0];
  if (first) setTimeout(() => { try { first.focus(); } catch (e) {} }, 30);

  function onKey(e){
    if (e.key !== 'Tab') return;
    const list = visibleFocusables();
    if (!list.length) return;
    const lo = list[0], hi = list[list.length - 1];
    if (e.shiftKey && document.activeElement === lo){ e.preventDefault(); hi.focus(); }
    else if (!e.shiftKey && document.activeElement === hi){ e.preventDefault(); lo.focus(); }
  }
  container.addEventListener('keydown', onKey);

  return function release(){
    container.removeEventListener('keydown', onKey);
    if (prev && typeof prev.focus === 'function'){ try { prev.focus(); } catch (e) {} }
  };
}

// True when the OS/browser asks for reduced motion. Read live so a runtime
// toggle is respected without a reload.
export function prefersReducedMotion(){
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}
