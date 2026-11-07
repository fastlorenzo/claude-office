import { describe, expect, it } from "vitest";
import {
  actionsFor,
  isInteractionTarget,
} from "../src/engine/interaction/actions";
import {
  factoryTarget,
  githubUrlOf,
  hasThinResolver,
  isFactoryTarget,
  panelKindFor,
  registerThinResolver,
  resolveThinTarget,
  sameFactoryIds,
  tagFactoryMesh,
  untagFactoryMesh,
  FACTORY_KINDS,
} from "../src/engine/interaction/factoryTargets";
import { FACTORY_PANEL_BY_KIND } from "../src/stores/worldUiStore";
import en from "../src/i18n/en";
import type { AbstractMesh } from "../src/engine/babylon";

const base = { projectId: "o/r", label: "r" };
const fakeMesh = (): AbstractMesh =>
  ({ metadata: { keep: 1 }, isPickable: false }) as unknown as AbstractMesh;

describe("factory targets -> actions", () => {
  it("every factory kind offers inspect, with Enter only when a session is linked", () => {
    for (const k of FACTORY_KINDS) {
      const plain = actionsFor(factoryTarget(k, base));
      expect(plain.map((a) => a.id)).toEqual(["inspect"]);
      expect(plain[0].key).toBe("F");
      const linked = actionsFor(factoryTarget(k, { ...base, sessionId: "s1" }));
      expect(linked.map((a) => a.id)).toEqual(["inspect", "enter"]);
      expect(linked[1].key).toBe("Enter");
    }
  });

  it("action labels exist in the dictionary", () => {
    for (const k of FACTORY_KINDS) {
      for (const a of actionsFor(factoryTarget(k, base)))
        expect(a.labelKey in en).toBe(true);
      expect(`world.kind.${k}` in en).toBe(true);
    }
  });

  it("maps kinds to panels consistently", () => {
    expect(panelKindFor(factoryTarget("lanePlate", base))).toBe("pr");
    expect(panelKindFor(factoryTarget("workpiece", base))).toBe("pr");
    expect(panelKindFor(factoryTarget("station", base))).toBe("station");
    expect(panelKindFor(factoryTarget("lineBoard", base))).toBe("line");
    expect(panelKindFor(factoryTarget("trunk", base))).toBe("line");
    expect(panelKindFor(factoryTarget("mainLine", base))).toBe("line");
    expect(panelKindFor(factoryTarget("dock", base))).toBe("deploy");
    expect(
      panelKindFor({ kind: "ops", sessionId: "", roomLabel: "" }),
    ).toBeNull();
    for (const k of FACTORY_KINDS)
      expect(FACTORY_PANEL_BY_KIND[k]).toBeTruthy();
  });

  it("carries ids and validates as an interaction target", () => {
    const t = factoryTarget("lanePlate", {
      ...base,
      prNumber: 4,
      lane: 2,
      checkName: "x",
      url: "https://g/1",
    });
    expect(isInteractionTarget(t)).toBe(true);
    expect(isFactoryTarget(t)).toBe(true);
    expect(t).toMatchObject({
      projectId: "o/r",
      prNumber: 4,
      lane: 2,
      checkName: "x",
    });
    expect("prNumber" in factoryTarget("dock", base)).toBe(false);
  });

  it("distinguishes targets by ids", () => {
    const a = factoryTarget("workpiece", { ...base, prNumber: 1 });
    expect(
      sameFactoryIds(a, factoryTarget("workpiece", { ...base, prNumber: 1 })),
    ).toBe(true);
    expect(
      sameFactoryIds(a, factoryTarget("workpiece", { ...base, prNumber: 2 })),
    ).toBe(false);
    expect(
      sameFactoryIds(
        a,
        factoryTarget("workpiece", { ...base, prNumber: 1, lane: 0 }),
      ),
    ).toBe(false);
  });

  it("only exposes http(s) GitHub urls", () => {
    expect(
      githubUrlOf(
        factoryTarget("dock", { ...base, url: "https://github.com/o/r" }),
      ),
    ).toBe("https://github.com/o/r");
    expect(
      githubUrlOf(
        factoryTarget("dock", { ...base, url: "javascript:alert(1)" }),
      ),
    ).toBeNull();
    expect(githubUrlOf(factoryTarget("dock", base))).toBeNull();
  });
});

describe("tagging and thin-instance resolver", () => {
  it("tagFactoryMesh merges into metadata and enables picking", () => {
    const m = fakeMesh();
    const t = factoryTarget("lineBoard", base);
    tagFactoryMesh(m, t, { range: 6 });
    const md = m.metadata as Record<string, unknown>;
    expect(md.keep).toBe(1);
    expect(md.interact).toBe(t);
    expect(md.interactRange).toBe(6);
    expect(m.isPickable).toBe(true);
    untagFactoryMesh(m);
    expect((m.metadata as Record<string, unknown>).interact).toBeUndefined();
  });

  it("resolves a thin instance index through the registered resolver", () => {
    const m = fakeMesh();
    expect(hasThinResolver(m)).toBe(false);
    expect(resolveThinTarget(m, 0)).toBeNull();
    const ids = [11, 12, 13];
    registerThinResolver(m, (_m, i) =>
      i < ids.length
        ? factoryTarget("workpiece", { ...base, prNumber: ids[i] })
        : null,
    );
    expect(hasThinResolver(m)).toBe(true);
    expect(
      (m as unknown as { thinInstanceEnablePicking: boolean })
        .thinInstanceEnablePicking,
    ).toBe(true);
    expect(resolveThinTarget(m, 1)?.prNumber).toBe(12);
    expect(resolveThinTarget(m, 3)).toBeNull();
    expect(resolveThinTarget(m, -1)).toBeNull();
  });

  it("swallows resolver errors", () => {
    const m = fakeMesh();
    registerThinResolver(m, () => {
      throw new Error("boom");
    });
    expect(resolveThinTarget(m, 0)).toBeNull();
  });
});
