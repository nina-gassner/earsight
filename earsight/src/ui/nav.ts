/**
 * Makes groups of buttons usable with a glasses input (touchpad / neural band / d-pad) as well as touch and mouse:
 *  - a visible focus ring (see style.css) so you can see which button is selected,
 *  - arrow keys / Tab-like keys move the selection between the buttons of a group (wrapping around),
 *  - Enter / Space / "select" activates the selected button,
 *  - hovering or touching a button selects it, and a press (pointerup) clicks it even when the device never sends a
 *    normal "click" (some glasses browsers only send pointer events). A click that follows is not counted twice.
 */
const NEXT = new Set(['ArrowDown', 'ArrowRight', 'PageDown']);
const PREV = new Set(['ArrowUp', 'ArrowLeft', 'PageUp']);

export function enableGroupNav(container: HTMLElement, selector = 'button'): void {
  const items = () => Array.from(container.querySelectorAll<HTMLElement>(selector)).filter((b) => !b.hidden && b.offsetParent !== null && !(b as HTMLButtonElement).disabled);
  container.addEventListener('keydown', (e) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (NEXT.has(e.key) || PREV.has(e.key)) {
      if (!list.length) return;
      e.preventDefault();
      const n = i < 0 ? 0 : (i + (NEXT.has(e.key) ? 1 : -1) + list.length) % list.length;
      list[n].focus();
    } else if ((e.key === 'Enter' || e.key === ' ') && i >= 0) {
      e.preventDefault();
      list[i].click();
    }
  });
  let lastActivate = 0;
  container.addEventListener('click', () => { lastActivate = performance.now(); }, true);
  container.addEventListener('pointerover', (e) => { (e.target as HTMLElement).closest<HTMLElement>(selector)?.focus({ preventScroll: true }); });
  container.addEventListener('pointerup', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(selector);
    if (!b || (b as HTMLButtonElement).disabled) return;
    // if the browser sends a normal click right after, that one does the work; otherwise we click ourselves
    const t = performance.now();
    window.setTimeout(() => { if (lastActivate < t) b.click(); }, 60);
  });
}

/** puts the selection on the first visible button of a group (so a d-pad press has something to act on) */
export function focusFirst(container: HTMLElement, selector = 'button'): void {
  container.querySelector<HTMLElement>(selector + ':not([hidden])')?.focus({ preventScroll: true });
}
