/**
 * Every World renders into a canvas of its own, never into the host's element.
 *
 * React Fast Refresh / HMR (and any remount) disposes a World and builds the
 * next one on the same host canvas while the old engine still has async GPU
 * work in flight: the HDR environment prefilter, texture uploads, shader
 * compiles. `canvas.getContext` hands both engines the SAME WebGL context, so
 * that late work rebinds the active texture unit, textures and framebuffers
 * behind the new engine's state cache. The new world then draws with whole
 * material sets missing (floors, walls, ceilings gone; the terrain, factory
 * lines and status floors showing through) until the page is reloaded.
 *
 * `claimCanvas` inserts a private canvas next to the host (copying its classes,
 * inline style, tab index and data / aria attributes) and hides the host;
 * `release` removes it and shows the host again. A private canvas means a
 * private context, which the World loses on dispose (frees the GPU memory at
 * once and turns any late call of the old engine into a no-op).
 */
export interface ClaimedCanvas {
  readonly canvas: HTMLCanvasElement;
  release(): void;
}

export function claimCanvas(host: HTMLCanvasElement): ClaimedCanvas {
  const doc = host.ownerDocument;
  const canvas = doc.createElement("canvas");
  canvas.className = host.className;
  canvas.style.cssText = host.style.cssText;
  if (host.hasAttribute("tabindex")) canvas.tabIndex = host.tabIndex;
  for (const name of host.getAttributeNames())
    if (name.startsWith("data-") || name.startsWith("aria-"))
      canvas.setAttribute(name, host.getAttribute(name) ?? "");
  canvas.dataset.worldCanvas = "1";
  host.insertAdjacentElement("afterend", canvas);
  const display = host.style.display;
  host.style.display = "none";
  let released = false;
  return {
    canvas,
    release() {
      if (released) return;
      released = true;
      canvas.remove();
      host.style.display = display;
    },
  };
}
