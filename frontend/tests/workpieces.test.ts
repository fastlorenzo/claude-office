import { describe, expect, it } from "vitest";
import {
  BELT_HEIGHT,
  BODY_DIMS,
  PALLET_TOP,
  packPieces,
  pieceSignature,
  queueSlot,
  resolvePiece,
  samplePolyline,
  signaturesChanged,
  splitTag,
  tagLod,
  variantForSize,
  type PieceInstance,
} from "@/engine/world/factory/workpiecePlacement";

const P = [
  { x: 0, y: 0, z: 0 },
  { x: 10, y: 0, z: 0 },
  { x: 10, y: 0, z: 10 },
];

describe("samplePolyline", () => {
  it("interpolates by arc length", () => {
    expect(samplePolyline(P, 0)).toMatchObject({ x: 0, z: 0 });
    expect(samplePolyline(P, 0.25)).toMatchObject({ x: 5, z: 0 });
    const mid = samplePolyline(P, 0.5);
    expect(mid.x).toBeCloseTo(10);
    expect(mid.z).toBeCloseTo(0);
    expect(samplePolyline(P, 0.75)).toMatchObject({ x: 10, z: 5 });
    expect(samplePolyline(P, 1)).toMatchObject({ x: 10, z: 10 });
  });
  it("clamps t and handles degenerate paths", () => {
    expect(samplePolyline(P, -3).x).toBe(0);
    expect(samplePolyline(P, 9).z).toBe(10);
    expect(samplePolyline([], 0.5)).toEqual({ x: 0, y: 0, z: 0, yaw: 0 });
    expect(samplePolyline([{ x: 1, y: 2, z: 3 }], 0.5)).toMatchObject({
      x: 1,
      z: 3,
    });
  });
  it("heading: +x -> yaw 0, +z -> local x points along +z", () => {
    expect(samplePolyline(P, 0.1).yaw).toBeCloseTo(0);
    expect(samplePolyline(P, 0.9).yaw).toBeCloseTo(-Math.PI / 2);
  });
});

describe("variantForSize", () => {
  it("maps XS/S/M/L-XL to 0..3", () => {
    expect(variantForSize("XS")).toBe(0);
    expect(variantForSize("S")).toBe(1);
    expect(variantForSize("M")).toBe(2);
    expect(variantForSize("L")).toBe(3);
    expect(variantForSize("XL")).toBe(3);
    expect(BODY_DIMS).toHaveLength(4);
  });
});

describe("queueSlot", () => {
  const pts = [
    { x: 0, y: 0.3, z: 0 },
    { x: 0, y: 0.3, z: 1 },
  ];
  it("uses points in order then stacks upward", () => {
    expect(queueSlot(pts, 0)).toEqual(pts[0]);
    expect(queueSlot(pts, 1)).toEqual(pts[1]);
    expect(queueSlot(pts, 2)).toMatchObject({ z: 0, y: 0.3 + 0.9 });
    expect(queueSlot(pts, 5)).toMatchObject({ z: 1, y: 0.3 + 1.8 });
  });
  it("empty rack is the origin", () => {
    expect(queueSlot([], 3)).toEqual({ x: 0, y: 0, z: 0 });
  });
});

const base: PieceInstance = {
  id: "a",
  lanePath: P,
  t: 0.25,
  sizeClass: "M",
  state: "running",
  tag: "#412 · Fix thing",
};

describe("resolvePiece", () => {
  it("adds belt height, queue pieces ignore the lane", () => {
    expect(resolvePiece(base, []).placed.y).toBeCloseTo(BELT_HEIGHT);
    const q = resolvePiece({ ...base, queueSlot: 1 }, [
      { x: 0, y: 0, z: 0 },
      { x: 3, y: 0.3, z: 4 },
    ]);
    expect(q.placed).toMatchObject({ x: 3, y: 0.3, z: 4 });
  });
  it("accepts a resolver", () => {
    const r = resolvePiece(
      { ...base, lanePath: (t) => ({ x: t, y: 1, z: 0, yaw: 0 }) },
      [],
    );
    expect(r.placed).toMatchObject({ x: 0.25, y: 1 + BELT_HEIGHT });
  });
});

describe("splitTag", () => {
  it("splits number and title", () => {
    expect(splitTag("#9 · a · b")).toEqual({ num: "#9", title: "a · b" });
    expect(splitTag("#9")).toEqual({ num: "#9", title: "" });
  });
});

describe("change detection", () => {
  const sigMap = (ps: PieceInstance[]) =>
    new Map(ps.map((p) => [p.id, pieceSignature(resolvePiece(p, []))]));
  it("is stable for identical content, even with new path arrays", () => {
    const a = sigMap([base]);
    const b = sigMap([{ ...base, lanePath: P.map((p) => ({ ...p })) }]);
    expect(signaturesChanged(a, b)).toBe(false);
  });
  it("flags movement, state, draft, text and membership", () => {
    const a = sigMap([base]);
    for (const patch of [
      { t: 0.26 },
      { state: "failure" as const },
      { draft: true },
      { bot: true },
      { tag: "#412 · Other" },
      { sizeClass: "XL" as const },
    ]) {
      expect(signaturesChanged(a, sigMap([{ ...base, ...patch }]))).toBe(true);
    }
    expect(signaturesChanged(a, sigMap([base, { ...base, id: "b" }]))).toBe(
      true,
    );
    expect(signaturesChanged(a, new Map())).toBe(true);
  });
  it("ignores sub-millimetre jitter", () => {
    expect(
      signaturesChanged(sigMap([base]), sigMap([{ ...base, t: 0.25 + 1e-8 }])),
    ).toBe(false);
  });
});

describe("packPieces", () => {
  it("routes pieces to variant / ghost / band buffers", () => {
    const ps: PieceInstance[] = [
      { ...base, id: "1", sizeClass: "XS" },
      { ...base, id: "2", sizeClass: "L" },
      { ...base, id: "3", sizeClass: "XL" },
      { ...base, id: "4", draft: true },
    ];
    const pk = packPieces(ps.map((p) => resolvePiece(p, [])));
    expect(pk.count).toBe(4);
    expect(pk.bodies.map((b) => b.count)).toEqual([1, 0, 0, 2]);
    expect(pk.ghost.count).toBe(1);
    expect(pk.band.count).toBe(4);
    // body sits on the pallet deck; pallet at belt height
    expect(pk.bodies[0].m[13]).toBeCloseTo(BELT_HEIGHT + PALLET_TOP);
    expect(pk.pallet[13]).toBeCloseTo(BELT_HEIGHT);
  });
  it("reuses arrays when capacity suffices", () => {
    const rs = [resolvePiece(base, [])];
    const a = packPieces(rs);
    const buf = a.pallet;
    const b = packPieces(rs, a);
    expect(b.pallet).toBe(buf);
  });
});

describe("tagLod", () => {
  it("bands at 5 m and 10 m with hysteresis", () => {
    expect(tagLod(2, 0)).toBe(2);
    expect(tagLod(7, 0)).toBe(1);
    expect(tagLod(12, 0)).toBe(0);
    expect(tagLod(5.2, 2)).toBe(2);
    expect(tagLod(5.2, 1)).toBe(1);
    expect(tagLod(10.3, 1)).toBe(1);
    expect(tagLod(10.3, 0)).toBe(0);
  });
});
