/**
 * Floating nameplates + speech/thought bubbles on one fullscreen GUI layer.
 *
 * Every label links to a TransformNode (the character head anchor). Labels
 * fade/scale with camera distance (hidden beyond ~12 m; GUI hides projected
 * points behind the camera) and bubbles auto-hide unless persistent.
 */

import {
  AdvancedDynamicTexture,
  Control,
  Ellipse,
  Rectangle,
  Scene,
  StackPanel,
  TextBlock,
  TransformNode,
  Vector3,
  type Observer,
} from "../babylon";
import type { BubbleContent } from "@/types";
import { truncateBubbleText } from "@/utils/bubbleText";
import { ICON_MAP } from "@/components/game/shared/iconMap";
import { bubbleLayout, labelFade } from "./labelMath";
import { screenFonts } from "./canvasKit";

const font = (): string => screenFonts().sans;
const PILL_H = 30;

interface LabelOpts {
  title: string;
  subtitle?: string;
  color: string;
}

interface BubbleUi {
  box: Rectangle;
  text: TextBlock;
  tail: Control[];
  height: number;
  key: string;
  remaining: number; // seconds; Infinity when persistent
}

interface Entry {
  anchor: TransformNode;
  opts: LabelOpts;
  pill: Rectangle;
  dot: Ellipse;
  title: TextBlock;
  subtitle: TextBlock;
  bubble: BubbleUi | null;
  wanted: boolean; // setVisible
  alpha: number;
  scale: number;
}

export class LabelLayer {
  private readonly scene: Scene;
  private readonly ui: AdvancedDynamicTexture;
  private readonly entries = new Map<string, Entry>();
  private readonly observer: Observer<Scene> | null;

  constructor(scene: Scene) {
    this.scene = scene;
    this.ui = AdvancedDynamicTexture.CreateFullscreenUI(
      "labelLayer",
      true,
      scene,
    );
    this.ui.idealHeight = 1080;
    this.ui.renderAtIdealSize = false;
    this.observer = scene.onBeforeRenderObservable.add(() => this.tick());
  }

  attach(id: string, anchor: TransformNode, opts: LabelOpts): void {
    this.detach(id);
    const pill = new Rectangle(`lbl_${id}`);
    pill.height = `${PILL_H}px`;
    pill.adaptWidthToChildren = true;
    pill.cornerRadius = PILL_H / 2;
    pill.thickness = 1;
    pill.color = "rgba(255,255,255,0.16)";
    pill.background = "rgba(12,15,22,0.74)";
    pill.shadowColor = "rgba(0,0,0,0.45)";
    pill.shadowBlur = 10;
    pill.shadowOffsetY = 2;
    pill.isPointerBlocker = false;
    pill.isHitTestVisible = false;

    const row = new StackPanel(`lblRow_${id}`);
    row.isVertical = false;
    row.height = `${PILL_H}px`;
    row.adaptWidthToChildren = true;
    pill.addControl(row);

    const dotWrap = new Rectangle(`lblDotWrap_${id}`);
    dotWrap.width = "26px";
    dotWrap.height = `${PILL_H}px`;
    dotWrap.thickness = 0;
    const dot = new Ellipse(`lblDot_${id}`);
    dot.width = "10px";
    dot.height = "10px";
    dot.thickness = 0;
    dot.background = opts.color;
    dot.left = "3px";
    dot.shadowColor = opts.color;
    dot.shadowBlur = 6;
    dotWrap.addControl(dot);
    row.addControl(dotWrap);

    const title = new TextBlock(`lblTitle_${id}`, opts.title);
    title.resizeToFit = true;
    title.fontFamily = font();
    title.fontSize = 16;
    title.fontWeight = "600";
    title.color = "#F8FAFC";
    title.height = `${PILL_H}px`;
    row.addControl(title);

    const subtitle = new TextBlock(`lblSub_${id}`, opts.subtitle ?? "");
    subtitle.resizeToFit = true;
    subtitle.fontFamily = font();
    subtitle.fontSize = 14;
    subtitle.color = "rgba(226,232,240,0.62)";
    subtitle.height = `${PILL_H}px`;
    subtitle.paddingLeft = "8px";
    subtitle.paddingRight = "14px";
    subtitle.isVisible = !!opts.subtitle;
    row.addControl(subtitle);
    if (!opts.subtitle) title.paddingRight = "14px";

    this.ui.addControl(pill);
    pill.linkWithMesh(anchor);
    pill.linkOffsetY = -6;

    this.entries.set(id, {
      anchor,
      opts: { ...opts },
      pill,
      dot,
      title,
      subtitle,
      bubble: null,
      wanted: true,
      alpha: -1,
      scale: -1,
    });
    this.applyFade(this.entries.get(id) as Entry, true);
  }

  update(id: string, opts: Partial<LabelOpts>): void {
    const e = this.entries.get(id);
    if (!e) return;
    if (opts.title !== undefined && opts.title !== e.opts.title) {
      e.opts.title = opts.title;
      e.title.text = opts.title;
    }
    if (opts.subtitle !== undefined && opts.subtitle !== e.opts.subtitle) {
      e.opts.subtitle = opts.subtitle;
      e.subtitle.text = opts.subtitle;
      e.subtitle.isVisible = !!opts.subtitle;
      e.title.paddingRight = opts.subtitle ? "0px" : "14px";
    }
    if (opts.color !== undefined && opts.color !== e.opts.color) {
      e.opts.color = opts.color;
      e.dot.background = opts.color;
      e.dot.shadowColor = opts.color;
    }
  }

  setBubble(id: string, bubble: BubbleContent | null): void {
    const e = this.entries.get(id);
    if (!e) return;
    const key = bubble
      ? `${bubble.type}|${bubble.icon ?? ""}|${bubble.text}|${bubble.persistent ? 1 : 0}`
      : "";
    if (e.bubble && e.bubble.key === key) return;
    this.removeBubble(e);
    if (!bubble || !bubble.text) return;

    const icon = bubble.icon ? ICON_MAP[bubble.icon] : undefined;
    const text = `${icon ? icon + "  " : ""}${truncateBubbleText(bubble.text)}`;
    const thought = bubble.type === "thought";
    const lay = bubbleLayout(text);

    const box = new Rectangle(`bub_${id}`);
    box.width = `${lay.width}px`;
    box.height = `${lay.height}px`;
    box.cornerRadius = thought ? lay.height / 2.2 : 12;
    box.thickness = thought ? 1.5 : 0;
    box.color = "rgba(100,116,139,0.55)";
    box.background = thought
      ? "rgba(241,245,249,0.9)"
      : "rgba(255,255,255,0.97)";
    box.shadowColor = "rgba(0,0,0,0.35)";
    box.shadowBlur = 12;
    box.shadowOffsetY = 3;
    box.isHitTestVisible = false;

    const tb = new TextBlock(`bubText_${id}`, text);
    tb.textWrapping = true;
    tb.fontFamily = font();
    tb.fontSize = 15;
    tb.lineSpacing = "2px";
    tb.fontStyle = thought ? "italic" : "normal";
    tb.color = thought ? "#334155" : "#0F172A";
    tb.paddingLeft = "12px";
    tb.paddingRight = "12px";
    tb.paddingTop = "6px";
    tb.paddingBottom = "6px";
    box.addControl(tb);

    const tail: Control[] = [];
    if (thought) {
      for (const [size, dx, dy] of [
        [10, -12, 9],
        [6, -20, 1],
      ] as const) {
        const c = new Ellipse(`bubDot_${id}_${size}`);
        c.width = `${size}px`;
        c.height = `${size}px`;
        c.thickness = 1.5;
        c.color = "rgba(100,116,139,0.55)";
        c.background = "rgba(241,245,249,0.9)";
        c.isHitTestVisible = false;
        tail.push(c);
        c.metadata = { dx, dy };
      }
    } else {
      const t = new Rectangle(`bubTail_${id}`);
      t.width = "12px";
      t.height = "12px";
      t.rotation = Math.PI / 4;
      t.thickness = 0;
      t.background = "rgba(255,255,255,0.97)";
      t.isHitTestVisible = false;
      t.metadata = { dx: 0, dy: 16 };
      tail.push(t);
    }
    for (const c of tail) {
      this.ui.addControl(c);
      c.linkWithMesh(e.anchor);
    }
    this.ui.addControl(box);
    box.linkWithMesh(e.anchor);

    e.bubble = {
      box,
      text: tb,
      tail,
      height: lay.height,
      key,
      remaining: bubble.persistent ? Infinity : lay.holdSec,
    };
    this.applyFade(e, true);
  }

  setVisible(id: string, visible: boolean): void {
    const e = this.entries.get(id);
    if (!e || e.wanted === visible) return;
    e.wanted = visible;
    this.applyFade(e, true);
  }

  detach(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.removeBubble(e);
    e.pill.linkWithMesh(null);
    this.ui.removeControl(e.pill);
    e.pill.dispose();
    this.entries.delete(id);
  }

  dispose(): void {
    for (const id of [...this.entries.keys()]) this.detach(id);
    if (this.observer)
      this.scene.onBeforeRenderObservable.remove(this.observer);
    this.ui.dispose();
  }

  // -------------------------------------------------------------------------

  private removeBubble(e: Entry): void {
    const b = e.bubble;
    if (!b) return;
    for (const c of [b.box, ...b.tail]) {
      c.linkWithMesh(null);
      this.ui.removeControl(c);
      c.dispose();
    }
    e.bubble = null;
  }

  private tick(): void {
    if (this.entries.size === 0) return;
    const dt = Math.min(0.1, this.scene.getEngine().getDeltaTime() / 1000);
    for (const e of this.entries.values()) {
      if (e.bubble && e.bubble.remaining !== Infinity) {
        e.bubble.remaining -= dt;
        if (e.bubble.remaining <= 0) this.removeBubble(e);
      }
      this.applyFade(e, false);
    }
  }

  private applyFade(e: Entry, force: boolean): void {
    const cam = this.scene.activeCamera;
    let alpha = 1;
    let scale = 1;
    if (cam) {
      e.anchor.computeWorldMatrix(true);
      const d = Vector3.Distance(
        cam.globalPosition,
        e.anchor.getAbsolutePosition(),
      );
      const f = labelFade(d);
      alpha = f.alpha;
      scale = f.scale;
    }
    if (!e.wanted) alpha = 0;
    if (
      !force &&
      Math.abs(alpha - e.alpha) < 0.02 &&
      Math.abs(scale - e.scale) < 0.01
    )
      return;
    e.alpha = alpha;
    e.scale = scale;
    const show = alpha > 0.02;
    e.pill.isVisible = show;
    e.pill.alpha = alpha;
    e.pill.scaleX = scale;
    e.pill.scaleY = scale;
    const b = e.bubble;
    if (b) {
      const pillTop = (PILL_H / 2 + 8) * scale;
      b.box.isVisible = show;
      b.box.alpha = alpha;
      b.box.scaleX = scale;
      b.box.scaleY = scale;
      b.box.linkOffsetY = -6 - pillTop - (b.height / 2 + 16) * scale;
      for (const c of b.tail) {
        const m = c.metadata as { dx: number; dy: number };
        c.isVisible = show;
        c.alpha = alpha;
        c.scaleX = scale;
        c.scaleY = scale;
        c.linkOffsetY = -6 - pillTop - m.dy * scale;
        c.linkOffsetX = m.dx * scale;
      }
    }
  }
}
