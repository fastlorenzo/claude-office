/**
 * Parked cars: modern European bodies at real proportions, procedural.
 *
 * Five variants (layout/carModels.ts: hatch, saloon, SUV, estate, van), each
 * built ONCE as a template:
 *  - lower body: a loft along the car (stations every ~9 cm, denser at the
 *    rounded plan corners and the wheel arches) of a cross-section with
 *    tumblehome, a sloped bonnet / rounded nose and tail, wheel arches cut
 *    down to the sill (with liners), flat bumper fascias with grille,
 *    intakes and plates; lamps, door shut lines, cowl, cladding are surface
 *    regions of the same loft;
 *  - glasshouse: a second loft on the beltline with tumblehome — windscreen,
 *    roof, rear screen, side glass between A/B/C(/D) pillars;
 *  - mirrors, handles, wipers, fin, roof rails, EU plates.
 *
 * Two draws for the whole car park:
 *  - bodies: every parked car's template copied into ONE world-space mesh,
 *    its paint baked into the vertex colours;
 *  - wheels: one tyre + 5-spoke alloy (+ disc, calliper) template,
 *    thin-instanced per wheel, sitting on the ground at each model's track
 *    and wheelbase.
 * Both share one PBR material whose surface response comes from a tiny
 * lookup texture indexed by U (clear-coated solid / metallic paint, matte
 * plastic, gloss black, tinted glass, chrome, rubber, alloy, lamp lenses),
 * so paint, glass and tyres keep their own look without extra draws.
 */
import {
  Color3,
  Matrix,
  Mesh,
  PBRMaterial,
  RawTexture,
  Scene,
  Texture,
  VertexData,
  type BaseTexture,
} from "@/engine/babylon";
import {
  CAR_MODELS,
  carModel,
  carWheels,
  type CarKind,
  type CarModel,
} from "@/engine/layout/carModels";
import type { CarSpot } from "@/engine/layout/exteriorPlan";
import { hexColor, type RGBA } from "@/engine/world/factory/meshSoup";

type V3 = [number, number, number];
type Pts = readonly (readonly [number, number])[];

// ------------------------------------------------------------- surfaces

/** Surface ids (texel index of the lookup texture). */
const ID = {
  paint: 0,
  metallic: 1,
  plastic: 2,
  gloss: 3,
  glass: 4,
  chrome: 5,
  rubber: 6,
  alloy: 7,
  lens: 8,
  dull: 9,
} as const;

/** [clear coat, roughness, metallic] per surface id. */
const SURF_PROPS: readonly (readonly [number, number, number])[] = [
  [1, 0.42, 0], // solid paint under clear coat
  [1, 0.34, 0.55], // metallic paint
  [0, 0.78, 0], // textured black plastic, liners
  [1, 0.18, 0], // gloss black trim, tail-lamp lenses
  [1, 0.04, 0], // tinted glass
  [0, 0.16, 1], // chrome, mirror glass
  [0, 0.92, 0], // tyre rubber
  [0.6, 0.3, 1], // alloy wheels, rails
  [1, 0.07, 0.8], // headlamp (reflector behind a clear lens)
  [0, 0.5, 0], // plates, brake discs
];
const SURF_N = 16;

interface Surf {
  id: number;
  /** null: the car's paint. */
  col: RGBA | null;
  /** Unique per (id, colour): dedupe key. */
  k: number;
}
const surfCache = new Map<string, Surf>();
function surf(id: number, col: RGBA | null): Surf {
  const key = `${id}:${col ? col.join(",") : "paint"}`;
  let s = surfCache.get(key);
  if (!s) {
    s = { id, col, k: surfCache.size };
    surfCache.set(key, s);
  }
  return s;
}

const C = {
  liner: hexColor("#101113"),
  plastic: hexColor("#1e1f22"),
  seam: hexColor("#08090a"),
  gloss: hexColor("#0b0c0e"),
  glass: hexColor("#07090c"),
  chrome: hexColor("#cfd3d8"),
  mirror: hexColor("#8f99a4"),
  rubber: hexColor("#141518"),
  sidewall: hexColor("#1b1c1f"),
  alloy: hexColor("#b4b8be"),
  rail: hexColor("#9a9ea4"),
  rimDark: hexColor("#25272b"),
  disc: hexColor("#6a6d72"),
  calliper: hexColor("#3a3c40"),
  head: hexColor("#c3c9d0"),
  tail: hexColor("#900b12"),
  plate: hexColor("#ecece6"),
  plateBlue: hexColor("#1f40a4"),
  plateText: hexColor("#16181b"),
};

const S = {
  paint: surf(ID.paint, null),
  liner: surf(ID.plastic, C.liner),
  plastic: surf(ID.plastic, C.plastic),
  seam: surf(ID.plastic, C.seam),
  gloss: surf(ID.gloss, C.gloss),
  glass: surf(ID.glass, C.glass),
  chrome: surf(ID.chrome, C.chrome),
  mirror: surf(ID.chrome, C.mirror),
  head: surf(ID.lens, C.head),
  tail: surf(ID.gloss, C.tail),
  plate: surf(ID.dull, C.plate),
  plateBlue: surf(ID.dull, C.plateBlue),
  plateText: surf(ID.dull, C.plateText),
  rail: surf(ID.alloy, C.rail),
  tread: surf(ID.rubber, C.rubber),
  sidewall: surf(ID.rubber, C.sidewall),
  alloy: surf(ID.alloy, C.alloy),
  rimDark: surf(ID.dull, C.rimDark),
  disc: surf(ID.dull, C.disc),
  calliper: surf(ID.dull, C.calliper),
};

/** Per-spot paint palette (CarSpot.color): the exterior's original eight. */
const PAINT: readonly {
  rgb: readonly [number, number, number];
  metallic: boolean;
}[] = [
  { rgb: [0.75, 0.76, 0.78], metallic: true }, // silver
  { rgb: [0.1, 0.11, 0.13], metallic: false }, // black
  { rgb: [0.55, 0.08, 0.09], metallic: false }, // red
  { rgb: [0.12, 0.2, 0.42], metallic: true }, // blue
  { rgb: [0.88, 0.88, 0.88], metallic: false }, // white
  { rgb: [0.3, 0.32, 0.34], metallic: true }, // graphite
  { rgb: [0.16, 0.32, 0.24], metallic: true }, // green
  { rgb: [0.6, 0.48, 0.2], metallic: true }, // gold
];

function paintOf(i: number): { col: RGBA; id: number } {
  const p = PAINT[((i % PAINT.length) + PAINT.length) % PAINT.length];
  const lin = (v: number) => Math.max(0.022, Math.pow(v, 2.2));
  return {
    col: [lin(p.rgb[0]), lin(p.rgb[1]), lin(p.rgb[2]), 1],
    id: p.metallic ? ID.metallic : ID.paint,
  };
}

// ------------------------------------------------------------- shapes

/**
 * Side-view shape of a variant; `s` runs from the tail (0) to the nose (L).
 * Heights are metres above the ground.
 */
interface Shape {
  /** Underside of the body (sills, bumpers). */
  sill: number;
  /** Lower-body top: tail deck / beltline / bonnet, s ∈ [0, L]. */
  top: Pts;
  /** Glasshouse top at the roof edge, s ∈ [gs0, gs1] (ends on the belt). */
  roof: Pts;
  /** Rear-screen base and windscreen base. */
  gs0: number;
  gs1: number;
  /** Roof front edge (windscreen top). */
  ws: number;
  /** Top-band glass spans (rear screen, windscreen). */
  screens: [number, number][];
  /** Side window spans; gloss-black side spans (B / C pillars, sails). */
  glass: [number, number][];
  black: [number, number][];
  /** Door shut lines down the flanks; shut lines across the deck. */
  seams: number[];
  deckSeams: number[];
  /**
   * Lamp bands as section-height fractions [u0, u1] (u = 0 sill .. 1 top,
   * so lamps follow the shoulder line), reach from the end, min |x| / hw.
   */
  head: [number, number];
  headLen: number;
  headX: number;
  tail: [number, number];
  tailLen: number;
  tailX: number;
  /** Upper grille / lower intake bands [u0, u1] on the nose fascia, max |x| / hw. */
  grille: [number, number];
  grilleX: number;
  intake: [number, number];
  intakeX: number;
  /** Front / rear plate centre heights. */
  plate: [number, number];
  /** Plan-view corner radius, nose / tail. */
  corner: [number, number];
  boxy: boolean;
  /** Glasshouse side inset per metre of height. */
  tumble: number;
  crown: number;
  bonnetCrown: number;
  chromeBelt: boolean;
  cladding: boolean;
  rails: boolean;
  /** Door handle stations. */
  handles: number[];
  van: boolean;
}

const SHAPES: Readonly<Record<CarKind, Shape>> = {
  hatch: {
    sill: 0.2,
    top: [
      [0, 0.9],
      [0.015, 0.95],
      [0.05, 0.975],
      [0.16, 0.985],
      [0.6, 1.0],
      [1.6, 0.975],
      [2.95, 0.94],
      [3.45, 0.885],
      [3.8, 0.815],
      [3.97, 0.75],
      [4.06, 0.67],
      [4.1, 0.58],
    ],
    roof: [
      [0.16, 0.985],
      [0.33, 1.215],
      [0.5, 1.415],
      [0.75, 1.435],
      [1.5, 1.44],
      [2.05, 1.415],
      [2.5, 1.18],
      [2.95, 0.94],
    ],
    gs0: 0.16,
    gs1: 2.95,
    ws: 2.05,
    screens: [
      [0.16, 0.5],
      [2.05, 2.95],
    ],
    glass: [
      [1.93, 2.76],
      [1.06, 1.83],
    ],
    black: [
      [1.83, 1.93],
      [2.76, 2.95],
    ],
    seams: [2.96, 1.88, 1.1],
    deckSeams: [],
    head: [0.75, 0.975],
    headLen: 0.42,
    headX: 0.36,
    tail: [0.75, 0.975],
    tailLen: 0.3,
    tailX: 0.42,
    grille: [0.75, 1],
    grilleX: 0.36,
    intake: [0.07, 0.6],
    intakeX: 0.58,
    plate: [0.4, 0.47],
    corner: [0.42, 0.3],
    boxy: false,
    tumble: 0.3,
    crown: 0.04,
    bonnetCrown: 0.03,
    chromeBelt: false,
    cladding: false,
    rails: false,
    handles: [2.02, 1.22],
    van: false,
  },
  saloon: {
    sill: 0.19,
    top: [
      [0, 0.88],
      [0.02, 0.95],
      [0.08, 1.0],
      [0.22, 1.015],
      [0.6, 1.035],
      [1.05, 1.03],
      [2.2, 0.99],
      [3.3, 0.955],
      [3.85, 0.895],
      [4.3, 0.825],
      [4.55, 0.755],
      [4.65, 0.68],
      [4.7, 0.58],
    ],
    roof: [
      [1.05, 1.03],
      [1.45, 1.245],
      [1.85, 1.385],
      [2.2, 1.41],
      [2.5, 1.4],
      [2.9, 1.185],
      [3.3, 0.955],
    ],
    gs0: 1.05,
    gs1: 3.3,
    ws: 2.5,
    screens: [
      [1.05, 1.85],
      [2.5, 3.3],
    ],
    glass: [
      [2.27, 3.1],
      [1.45, 2.17],
    ],
    black: [
      [2.17, 2.27],
      [3.1, 3.3],
    ],
    seams: [3.44, 2.22, 1.42],
    deckSeams: [1.0],
    head: [0.75, 0.975],
    headLen: 0.45,
    headX: 0.38,
    tail: [0.75, 0.975],
    tailLen: 0.32,
    tailX: 0.4,
    grille: [0.4, 1],
    grilleX: 0.3,
    intake: [0.07, 0.3],
    intakeX: 0.6,
    plate: [0.4, 0.5],
    corner: [0.45, 0.34],
    boxy: false,
    tumble: 0.32,
    crown: 0.04,
    bonnetCrown: 0.03,
    chromeBelt: true,
    cladding: false,
    rails: false,
    handles: [2.35, 1.55],
    van: false,
  },
  suv: {
    sill: 0.3,
    top: [
      [0, 1.05],
      [0.015, 1.1],
      [0.06, 1.125],
      [0.14, 1.135],
      [0.8, 1.16],
      [2.0, 1.13],
      [3.2, 1.105],
      [3.75, 1.065],
      [4.22, 1.005],
      [4.46, 0.94],
      [4.56, 0.84],
      [4.6, 0.72],
    ],
    roof: [
      [0.14, 1.135],
      [0.28, 1.4],
      [0.42, 1.6],
      [0.7, 1.65],
      [1.6, 1.66],
      [2.45, 1.64],
      [2.85, 1.37],
      [3.2, 1.105],
    ],
    gs0: 0.14,
    gs1: 3.2,
    ws: 2.45,
    screens: [
      [0.14, 0.42],
      [2.45, 3.2],
    ],
    glass: [
      [2.08, 3.0],
      [1.2, 1.98],
      [0.58, 1.1],
    ],
    black: [
      [1.98, 2.08],
      [1.1, 1.2],
      [3.0, 3.2],
    ],
    seams: [3.27, 2.03, 1.15],
    deckSeams: [],
    head: [0.75, 0.975],
    headLen: 0.4,
    headX: 0.38,
    tail: [0.75, 0.975],
    tailLen: 0.3,
    tailX: 0.42,
    grille: [0.4, 1],
    grilleX: 0.42,
    intake: [0.07, 0.3],
    intakeX: 0.6,
    plate: [0.47, 0.6],
    corner: [0.42, 0.26],
    boxy: true,
    tumble: 0.26,
    crown: 0.035,
    bonnetCrown: 0.03,
    chromeBelt: false,
    cladding: true,
    rails: true,
    handles: [2.18, 1.3],
    van: false,
  },
  estate: {
    sill: 0.19,
    top: [
      [0, 0.9],
      [0.015, 0.95],
      [0.05, 0.975],
      [0.14, 0.985],
      [0.8, 1.0],
      [2.0, 0.975],
      [3.25, 0.945],
      [3.8, 0.885],
      [4.25, 0.815],
      [4.54, 0.745],
      [4.64, 0.67],
      [4.68, 0.58],
    ],
    roof: [
      [0.14, 0.985],
      [0.26, 1.23],
      [0.4, 1.415],
      [0.7, 1.435],
      [1.6, 1.44],
      [2.4, 1.43],
      [2.83, 1.185],
      [3.25, 0.945],
    ],
    gs0: 0.14,
    gs1: 3.25,
    ws: 2.4,
    screens: [
      [0.14, 0.4],
      [2.4, 3.25],
    ],
    glass: [
      [2.17, 3.06],
      [1.32, 2.07],
      [0.52, 1.24],
    ],
    black: [
      [2.07, 2.17],
      [1.24, 1.32],
      [3.06, 3.25],
    ],
    seams: [3.38, 2.12, 1.28],
    deckSeams: [],
    head: [0.75, 0.975],
    headLen: 0.44,
    headX: 0.38,
    tail: [0.75, 0.975],
    tailLen: 0.28,
    tailX: 0.42,
    grille: [0.6, 1],
    grilleX: 0.36,
    intake: [0.07, 0.4],
    intakeX: 0.6,
    plate: [0.4, 0.47],
    corner: [0.45, 0.26],
    boxy: false,
    tumble: 0.3,
    crown: 0.04,
    bonnetCrown: 0.03,
    chromeBelt: true,
    cladding: false,
    rails: true,
    handles: [2.3, 1.42],
    van: false,
  },
  van: {
    sill: 0.32,
    top: [
      [0, 1.06],
      [0.02, 1.09],
      [0.05, 1.1],
      [2.0, 1.115],
      [3.5, 1.12],
      [4.15, 1.11],
      [4.55, 1.04],
      [4.76, 0.96],
      [4.85, 0.86],
      [4.9, 0.72],
    ],
    roof: [
      [0.05, 1.1],
      [0.07, 1.6],
      [0.1, 1.84],
      [0.16, 1.915],
      [0.4, 1.93],
      [2.5, 1.93],
      [3.4, 1.915],
      [3.62, 1.8],
      [3.9, 1.46],
      [4.15, 1.11],
    ],
    gs0: 0.05,
    gs1: 4.15,
    ws: 3.55,
    screens: [
      [0.064, 0.1],
      [3.55, 4.13],
    ],
    glass: [[3.3, 4.0]],
    black: [[4.0, 4.15]],
    seams: [4.12, 3.25, 2.0],
    deckSeams: [],
    head: [0.75, 0.975],
    headLen: 0.36,
    headX: 0.4,
    tail: [0.2, 0.93],
    tailLen: 0.06,
    tailX: 0.8,
    grille: [0.75, 1],
    grilleX: 0.42,
    intake: [0.2, 0.6],
    intakeX: 0.62,
    plate: [0.55, 0.62],
    corner: [0.38, 0.1],
    boxy: true,
    tumble: 0.12,
    crown: 0.04,
    bonnetCrown: 0.025,
    chromeBelt: false,
    cladding: false,
    rails: false,
    handles: [3.38, 2.15],
    van: true,
  },
};

/** Side-section half-width profile f(u), u = 0 at the sill .. 1 at the top. */
const SIDE_U = [0, 0.07, 0.2, 0.4, 0.6, 0.75, 0.86, 0.93, 0.975, 1];
const SIDE_CAR = [
  0.95, 0.982, 0.997, 1, 0.996, 0.983, 0.962, 0.935, 0.9, 0.865,
];
const SIDE_BOX = [
  0.965, 0.988, 0.998, 1, 0.998, 0.99, 0.978, 0.96, 0.935, 0.905,
];

/** Monotone cubic (Fritsch–Carlson) through (s, y) points: no overshoot. */
function curve(pts: Pts): (s: number) => number {
  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++)
    d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m: number[] = new Array<number>(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++)
    m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (s: number): number => {
    if (s <= xs[0]) return ys[0];
    if (s >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && s > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (s - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] +
      (t3 - 2 * t2 + t) * h * m[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] +
      (t3 - t2) * h * m[i + 1]
    );
  };
}

const interp = (us: number[], fs: number[], u: number): number => {
  if (u <= us[0]) return fs[0];
  for (let i = 1; i < us.length; i++)
    if (u <= us[i])
      return (
        fs[i - 1] +
        ((fs[i] - fs[i - 1]) * (u - us[i - 1])) / (us[i] - us[i - 1])
      );
  return fs[fs.length - 1];
};

const inSpan = (spans: readonly (readonly [number, number])[], s: number) =>
  spans.some(([a, b]) => s >= a && s <= b);

/** Evaluated body: curves + derived numbers for one variant. */
class Body {
  readonly L: number;
  readonly hw: number;
  readonly top: (s: number) => number;
  readonly roof: (s: number) => number;
  readonly axles: number[];
  readonly yc: number;
  readonly Ra: number;
  readonly side: number[];
  readonly edge: number;
  readonly tailY: [number, number];

  constructor(
    readonly m: CarModel,
    readonly sh: Shape,
  ) {
    this.L = m.length;
    this.hw = m.width / 2;
    this.top = curve(sh.top);
    this.roof = curve(sh.roof);
    const sf = m.length - m.front;
    this.axles = [sf, sf - m.wheelbase];
    this.yc = m.tyreR;
    this.Ra = m.tyreR + 0.06;
    this.side = sh.boxy ? SIDE_BOX : SIDE_CAR;
    // Tail-lamp heights on the flat tail panel: the flank band just ahead.
    const yt = this.top(0.1) - sh.sill;
    this.tailY = [sh.sill + sh.tail[0] * yt, sh.sill + sh.tail[1] * yt];
    this.edge = this.side[this.side.length - 1];
  }

  /** Plan-view half-width: circular corners at the nose and the tail. */
  halfW(s: number): number {
    const [rf, rr] = this.sh.corner;
    let w = this.hw;
    const dF = this.L - s;
    if (dF < rf)
      w = Math.min(
        w,
        this.hw - rf + Math.sqrt(Math.max(0, rf * rf - (rf - dF) ** 2)),
      );
    if (s < rr)
      w = Math.min(
        w,
        this.hw - rr + Math.sqrt(Math.max(0, rr * rr - (rr - s) ** 2)),
      );
    return w;
  }

  /** Wheel-arch opening top at s (sill height outside the arches). */
  archY(s: number): number {
    let y = this.sh.sill;
    for (const a of this.axles) {
      const d = Math.abs(s - a);
      if (d <= this.Ra)
        y = Math.max(y, this.yc + Math.sqrt(this.Ra * this.Ra - d * d));
    }
    return Math.min(y, this.top(s) - 0.12);
  }

  crownAt(s: number): number {
    const sh = this.sh;
    if (s > sh.gs1) return sh.bonnetCrown;
    if (s < sh.gs0) return 0.02;
    // Under the glasshouse: tucked below its base.
    return -0.01;
  }

  /** Flank x at height y of station s. */
  sideX(s: number, y: number): number {
    const yb = this.sh.sill;
    const yt = this.top(s);
    const u = (y - yb) / Math.max(1e-3, yt - yb);
    return this.halfW(s) * interp(SIDE_U, this.side, u);
  }

  /** Right half of the lower-body section at s, bottom centre → top centre. */
  lowerRing(s: number): [number, number][] {
    const yb = this.sh.sill;
    const yt = this.top(s);
    const ya = Math.max(yb, this.archY(s));
    const w = this.halfW(s);
    const S = (y: number) =>
      w * interp(SIDE_U, this.side, (y - yb) / Math.max(1e-3, yt - yb));
    const sx = S(ya);
    const xi = Math.min(
      this.m.track / 2 - this.m.tyreW / 2 - 0.05,
      sx - 0.1,
      w * 0.8,
    );
    const pts: [number, number][] = [
      [0, yb],
      [xi, yb],
      [xi, ya],
      [sx - 0.015, ya],
    ];
    for (const u of SIDE_U) {
      const y = Math.max(yb + u * (yt - yb), ya);
      pts.push([S(y), y]);
    }
    const cr = this.crownAt(s);
    const e = w * this.edge;
    pts.push(
      [e * 0.72, yt + cr * 0.6],
      [e * 0.36, yt + cr * 0.92],
      [0, yt + cr],
    );
    return pts;
  }

  /** Right half of the glasshouse section at s, belt → roof centre. */
  glassRing(s: number): [number, number][] {
    const sh = this.sh;
    const yb = this.top(s);
    const yt = Math.max(yb, this.roof(s));
    const h = yt - yb;
    const xb = this.halfW(s) * (this.edge - 0.022);
    const x = (y: number) => xb - sh.tumble * (y - yb);
    const y1 = yb + Math.min(0.03, h * 0.2);
    const yS = yt - Math.min(0.07, h * 0.3);
    const yC = yt - Math.min(0.022, h * 0.1);
    const cr = sh.crown * Math.min(1, h / 0.25);
    return [
      [xb + 0.004, yb - 0.012],
      [x(y1), y1],
      [x(yS), yS],
      [x(yC) - 0.012, yC],
      [x(yC) - 0.075, yt],
      [0, yt + cr],
    ];
  }
}

const GLASS_LABELS = ["belt", "side", "corner", "corner", "top"] as const;
type GlassLabel = (typeof GLASS_LABELS)[number];

// ------------------------------------------------------------- geometry

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * Geometry accumulator with per-vertex surface id (U), colour and a paint
 * flag. Triangles are stored with cross(b − a, c − a) along the outward
 * normal and flipped on build (Babylon's front-face winding, as MeshSoup).
 */
class Acc {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly col: number[] = [];
  readonly uv: number[] = [];
  readonly paint: number[] = [];
  readonly idx: number[] = [];

  vert(p: V3, n: V3, s: Surf): number {
    const i = this.pos.length / 3;
    this.pos.push(p[0], p[1], p[2]);
    this.nor.push(n[0], n[1], n[2]);
    const c = s.col ?? [1, 1, 1, 1];
    this.col.push(c[0], c[1], c[2], 1);
    this.uv.push((s.id + 0.5) / SURF_N, 0.5);
    this.paint.push(s.col ? 0 : 1);
    return i;
  }

  /** Flat polygon (3 or 4 corners), winding oriented to face `n`. */
  quad(p: readonly V3[], n: V3, s: Surf): void {
    const c = cross(sub(p[1], p[0]), sub(p[2], p[0]));
    const a = p.map((q) => this.vert(q, n, s));
    const flip = dot(c, n) < 0;
    for (let k = 1; k + 1 < a.length; k++)
      if (flip) this.idx.push(a[0], a[k + 1], a[k]);
      else this.idx.push(a[0], a[k], a[k + 1]);
  }

  box(c: V3, size: V3, s: Surf): void {
    const [hx, hy, hz] = [size[0] / 2, size[1] / 2, size[2] / 2];
    const P = (x: number, y: number, z: number): V3 => [
      c[0] + x * hx,
      c[1] + y * hy,
      c[2] + z * hz,
    ];
    this.quad(
      [P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), P(1, -1, 1)],
      [1, 0, 0],
      s,
    );
    this.quad(
      [P(-1, -1, -1), P(-1, 1, -1), P(-1, 1, 1), P(-1, -1, 1)],
      [-1, 0, 0],
      s,
    );
    this.quad(
      [P(-1, 1, -1), P(1, 1, -1), P(1, 1, 1), P(-1, 1, 1)],
      [0, 1, 0],
      s,
    );
    this.quad(
      [P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1)],
      [0, -1, 0],
      s,
    );
    this.quad(
      [P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)],
      [0, 0, 1],
      s,
    );
    this.quad(
      [P(-1, -1, -1), P(1, -1, -1), P(1, 1, -1), P(-1, 1, -1)],
      [0, 0, -1],
      s,
    );
  }

  /** Box from a to b with a w × h section (h along `up`, default +y). */
  bar(a: V3, b: V3, w: number, h: number, s: Surf, up: V3 = [0, 1, 0]): void {
    const d = norm(sub(b, a));
    let sd = cross(d, up);
    if (len(sd) < 1e-6) sd = cross(d, [1, 0, 0]);
    sd = norm(sd);
    const u = norm(cross(sd, d));
    const P = (e: V3, i: number, j: number): V3 => [
      e[0] + (sd[0] * i * w + u[0] * j * h) / 2,
      e[1] + (sd[1] * i * w + u[1] * j * h) / 2,
      e[2] + (sd[2] * i * w + u[2] * j * h) / 2,
    ];
    const neg = (v: V3): V3 => [-v[0], -v[1], -v[2]];
    this.quad([P(a, 1, -1), P(b, 1, -1), P(b, 1, 1), P(a, 1, 1)], sd, s);
    this.quad(
      [P(a, -1, -1), P(b, -1, -1), P(b, -1, 1), P(a, -1, 1)],
      neg(sd),
      s,
    );
    this.quad([P(a, -1, 1), P(b, -1, 1), P(b, 1, 1), P(a, 1, 1)], u, s);
    this.quad(
      [P(a, -1, -1), P(b, -1, -1), P(b, 1, -1), P(a, 1, -1)],
      neg(u),
      s,
    );
    this.quad([P(a, -1, -1), P(a, 1, -1), P(a, 1, 1), P(a, -1, 1)], neg(d), s);
    this.quad([P(b, -1, -1), P(b, 1, -1), P(b, 1, 1), P(b, -1, 1)], d, s);
  }

  /**
   * Loft grid P[station][ring point] (ring CCW seen from +z, stations along
   * +z): auto-smoothed normals (faces within ~42° blend), per-face surface
   * from `classify`, vertices shared per (grid point, surface, normal).
   */
  grid(
    P: V3[][],
    closed: boolean,
    classify: (j: number, c: V3, n: V3) => Surf,
  ): void {
    const nS = P.length;
    const R = P[0].length;
    const segs = closed ? R : R - 1;
    const unit: (V3 | null)[] = [];
    const area: number[] = [];
    const at = (i: number, j: number) => P[i][j % R];
    for (let i = 0; i < nS - 1; i++)
      for (let j = 0; j < segs; j++) {
        const n = cross(
          sub(at(i + 1, j + 1), at(i, j)),
          sub(at(i + 1, j), at(i, j + 1)),
        );
        const l = len(n);
        unit.push(l < 1e-7 ? null : [n[0] / l, n[1] / l, n[2] / l]);
        area.push(l);
      }
    const face = (i: number, j: number): number => {
      if (i < 0 || i >= nS - 1) return -1;
      if (closed) j = (j + segs) % segs;
      else if (j < 0 || j >= segs) return -1;
      return i * segs + j;
    };
    const COS = Math.cos(0.73);
    const cache = new Map<string, number>();
    for (let i = 0; i < nS - 1; i++)
      for (let j = 0; j < segs; j++) {
        const f = i * segs + j;
        const un = unit[f];
        if (!un) continue;
        const A = at(i, j);
        const B = at(i, j + 1);
        const Cc = at(i + 1, j + 1);
        const D = at(i + 1, j);
        const cen: V3 = [
          (A[0] + B[0] + Cc[0] + D[0]) / 4,
          (A[1] + B[1] + Cc[1] + D[1]) / 4,
          (A[2] + B[2] + Cc[2] + D[2]) / 4,
        ];
        const sf = classify(j, cen, un);
        const corners: [number, number][] = [
          [i, j],
          [i, j + 1],
          [i + 1, j + 1],
          [i + 1, j],
        ];
        const vi = corners.map(([ci, cj]) => {
          const n: V3 = [0, 0, 0];
          for (const [fi, fj] of [
            [ci - 1, cj - 1],
            [ci - 1, cj],
            [ci, cj - 1],
            [ci, cj],
          ]) {
            const g = face(fi, fj);
            if (g < 0) continue;
            const u2 = unit[g];
            if (!u2 || dot(u2, un) < COS) continue;
            n[0] += u2[0] * area[g];
            n[1] += u2[1] * area[g];
            n[2] += u2[2] * area[g];
          }
          const nn = norm(n);
          const key = `${ci},${cj % R},${sf.k},${Math.round(nn[0] * 500)},${Math.round(nn[1] * 500)},${Math.round(nn[2] * 500)}`;
          let v = cache.get(key);
          if (v === undefined) {
            v = this.vert(at(ci, cj), nn, sf);
            cache.set(key, v);
          }
          return v;
        });
        this.idx.push(vi[0], vi[1], vi[2], vi[0], vi[2], vi[3]);
      }
  }

  /**
   * Surface of revolution about x: closed (r, x) outline, smooth around the
   * axle, creased along the outline; `cols[e]` colours edge e.
   */
  lathe(prof: Pts, cols: readonly Surf[], seg: number): void {
    for (let e = 0; e + 1 < prof.length; e++) {
      const [r0, x0] = prof[e];
      const [r1, x1] = prof[e + 1];
      const dr = r1 - r0;
      const dx = x1 - x0;
      const l = Math.hypot(dr, dx);
      if (l < 1e-6) continue;
      const nr = dx / l;
      const nx = -dr / l;
      const base = this.pos.length / 3;
      for (let k = 0; k <= seg; k++) {
        const a = (k / seg) * Math.PI * 2;
        const cy = Math.cos(a);
        const sz = Math.sin(a);
        this.vert([x0, r0 * cy, r0 * sz], [nx, nr * cy, nr * sz], cols[e]);
        this.vert([x1, r1 * cy, r1 * sz], [nx, nr * cy, nr * sz], cols[e]);
      }
      for (let k = 0; k < seg; k++) {
        const a = base + 2 * k;
        // cross(b − a, c − a) outward for the outline's orientation.
        this.idx.push(a, a + 3, a + 1, a, a + 2, a + 3);
      }
    }
  }
}

/** Sorted, de-duplicated stations (pairs 0.2 mm apart survive: arch steps). */
function stations(list: number[], s0: number, s1: number): number[] {
  const v = list
    .filter((s) => s >= s0 - 1e-9 && s <= s1 + 1e-9)
    .sort((a, b) => a - b);
  const out: number[] = [];
  for (const s of v)
    if (!out.length || s - out[out.length - 1] > 5e-5) out.push(s);
  return out;
}

const mirrorX = ([x, y, z]: V3): V3 => [-x, y, z];

/** Lower body: loft + both bumper fascias. */
function buildLower(a: Acc, b: Body): void {
  const { L, sh } = b;
  const list: number[] = [];
  for (let s = 0; s <= L + 1e-9; s += 0.11) list.push(s);
  list.push(L);
  for (let k = 0; k <= 7; k++) {
    const t = 1 - Math.cos(((k / 7) * Math.PI) / 2);
    list.push(sh.corner[1] * t, L - sh.corner[0] * t);
  }
  for (const ax of b.axles) {
    for (let k = -5; k <= 5; k++)
      list.push(ax + b.Ra * Math.sin(((k / 6) * Math.PI) / 2));
    for (const sg of [-1, 1])
      list.push(ax + sg * (b.Ra - 1e-4), ax + sg * (b.Ra + 1e-4));
  }
  list.push(sh.gs0, sh.gs1, sh.gs1 - 0.07, L - sh.headLen, sh.tailLen);
  list.push(L - LAMP_END, LAMP_END);
  for (const s of [...sh.seams, ...sh.deckSeams])
    list.push(s - 0.004, s + 0.004);
  const st = stations(list, 0, L);

  const half = st.map((s) => b.lowerRing(s));
  const n = half[0].length; // right half incl. both centre points
  const P: V3[][] = st.map((s, i) => {
    const z = s - L / 2;
    const r = half[i].map(([x, y]): V3 => [x, y, z]);
    const ring = r.slice();
    for (let k = n - 2; k >= 1; k--) ring.push(mirrorX(r[k]));
    return ring;
  });
  // Full-ring segment j -> its right-half segment (bottom centre = 0).
  const halfSeg = (j: number) => (j < n - 1 ? j : 2 * (n - 1) - 1 - j);
  a.grid(P, true, (j, c, nn) => lowerSurface(b, halfSeg(j), false, c, nn));

  // Fascias: flat caps at both ends; strip k spans the same section band as
  // half-ring segment k, split in columns for the grille / intake / lamps.
  const cols = [-1, -0.8, -0.62, -0.45, -0.3, 0, 0.3, 0.45, 0.62, 0.8, 1];
  for (const [i, nz] of [
    [0, -1],
    [st.length - 1, 1],
  ] as const) {
    const r = half[i];
    const z = st[i] - L / 2;
    for (let k = 3; k < r.length - 1; k++) {
      const [x0, y0] = r[k];
      const [x1, y1] = r[k + 1];
      if (Math.abs(y1 - y0) < 1e-5 && Math.abs(x1 - x0) < 1e-5) continue;
      for (let c = 0; c + 1 < cols.length; c++) {
        const fa = cols[c];
        const fb = cols[c + 1];
        const q: V3[] = [
          [fa * x0, y0, z],
          [fb * x0, y0, z],
          [fb * x1, y1, z],
          [fa * x1, y1, z],
        ];
        const ar = len(cross(sub(q[2], q[0]), sub(q[3], q[1])));
        if (ar < 1e-8) continue;
        const cen: V3 = [((fa + fb) / 4) * (x0 + x1), (y0 + y1) / 2, z];
        a.quad(q, [0, 0, nz], lowerSurface(b, k, true, cen, [0, 0, nz]));
      }
    }
  }
  if (sh.cladding) for (const sx of [-1, 1]) archCladding(a, b, sx);
}

/** Lamps stop this far short of the fascias (they wrap the corners only). */
const LAMP_END = 0.015;

/** Section band [u0, u1] of half-ring segment hj (side segments only). */
function segBand(hj: number): [number, number] | null {
  const k = hj - 4;
  return k >= 0 && k + 1 < SIDE_U.length ? [SIDE_U[k], SIDE_U[k + 1]] : null;
}
const within = (u: [number, number] | null, band: readonly number[]) =>
  !!u && u[0] >= band[0] - 1e-6 && u[1] <= band[1] + 1e-6;

/**
 * Surface of a lower-body face: `hj` is its right-half segment (0 floor,
 * 1–2 wheel well, 3 rocker lip, 4–12 flank bands, 13–15 top); bands follow
 * the grid so lamps / grilles / cladding have clean edges.
 */
function lowerSurface(b: Body, hj: number, cap: boolean, c: V3, n: V3): Surf {
  const { L, sh, hw } = b;
  if (!cap && hj <= 2) return S.liner;
  const s = c[2] + L / 2;
  const ax = Math.abs(c[0]);
  const y = c[1];
  const u = segBand(hj);
  if (!cap) {
    const yt = b.top(s);
    for (const q of sh.seams)
      if (Math.abs(s - q) < 0.0045 && Math.abs(n[0]) > 0.4 && y < yt - 0.03)
        return S.seam;
    for (const q of sh.deckSeams)
      if (Math.abs(s - q) < 0.0045 && n[1] > 0.4) return S.seam;
    if (s > sh.gs1 - 0.07 && s < sh.gs1 + 0.005 && n[1] > 0.5) return S.plastic;
    if (
      within(u, sh.head) &&
      s > L - sh.headLen &&
      s < L - LAMP_END &&
      ax > sh.headX * hw &&
      n[2] > -0.3
    )
      return S.head;
  }
  if (
    // Flank wrap follows the shoulder band; round the tail corner (and on
    // the flat tail panel below) the lamps keep the panel's heights.
    (sh.van || s > 0.05
      ? within(u, sh.tail)
      : y >= b.tailY[0] && y <= b.tailY[1]) &&
    s < sh.tailLen &&
    (!cap || sh.van) &&
    ax > sh.tailX * hw &&
    n[2] < 0.3
  )
    return S.tail;
  if (
    cap &&
    c[2] < 0 &&
    !sh.van &&
    y >= b.tailY[0] &&
    y <= b.tailY[1] &&
    ax > sh.tailX * hw
  )
    return S.tail;
  if (cap && c[2] > 0) {
    if (within(u, sh.grille) && ax < sh.grilleX * hw) return S.gloss;
    if (within(u, sh.intake) && ax < sh.intakeX * hw) return S.plastic;
  }
  // Rear diffuser band.
  if (s < 0.3 && n[2] < -0.35 && within(u, [0, 0.2])) return S.plastic;
  if (sh.van) {
    // Unpainted bumpers, side rubbing strip.
    if (s > L - 0.32 && within(u, [0, 0.4])) return S.plastic;
    if (s < 0.14 && within(u, [0, 0.2])) return S.plastic;
    if (y > 0.5 && y < 0.58 && Math.abs(n[0]) > 0.5) return S.plastic;
  }
  if (sh.cladding) {
    if (within(u, [0, 0.2])) return S.plastic;
  } else if (!cap && hj <= 4 && Math.abs(n[0]) > 0.3) return S.plastic;
  return S.paint;
}

/** SUV wheel-arch extensions: a smooth plastic band round each opening. */
function archCladding(a: Acc, b: Body, sx: number): void {
  const N = 16;
  const w = 0.07;
  for (const ax of b.axles) {
    const pt = (t: number, r: number): V3 => {
      const s = ax + r * Math.cos(t);
      const y = b.yc + r * Math.sin(t);
      return [sx * (b.sideX(s, y) + 0.004), y, s - b.L / 2];
    };
    for (let k = 0; k < N; k++) {
      const t0 = (k / N) * Math.PI;
      const t1 = ((k + 1) / N) * Math.PI;
      const tm = (t0 + t1) / 2;
      a.quad(
        [pt(t0, b.Ra), pt(t1, b.Ra), pt(t1, b.Ra + w), pt(t0, b.Ra + w)],
        norm([sx, Math.sin(tm) * 0.25, 0]),
        S.plastic,
      );
    }
  }
}

/** Glasshouse loft (open ring sitting on the belt). */
function buildGlass(a: Acc, b: Body): void {
  const { L, sh } = b;
  const list: number[] = [];
  for (let s = sh.gs0; s <= sh.gs1 + 1e-9; s += 0.08) list.push(s);
  list.push(sh.gs1, sh.ws);
  for (const sp of [...sh.screens, ...sh.glass, ...sh.black]) list.push(...sp);
  const st = stations(list, sh.gs0, sh.gs1);
  const P: V3[][] = st.map((s) => {
    const z = s - L / 2;
    const r = b.glassRing(s).map(([x, y]): V3 => [x, y, z]);
    const ring = r.slice();
    for (let k = r.length - 2; k >= 0; k--) ring.push(mirrorX(r[k]));
    return ring;
  });
  const n = GLASS_LABELS.length;
  const labelOf = (j: number): GlassLabel =>
    j < n ? GLASS_LABELS[j] : GLASS_LABELS[2 * n - 1 - j];
  a.grid(P, false, (j, c) => glassSurface(sh, labelOf(j), c[2] + L / 2));
}

function glassSurface(sh: Shape, label: GlassLabel, s: number): Surf {
  const glass = inSpan(sh.glass, s);
  switch (label) {
    case "top":
      return inSpan(sh.screens, s) ? S.glass : S.paint;
    case "corner":
      return S.paint;
    case "side":
      return glass ? S.glass : inSpan(sh.black, s) ? S.gloss : S.paint;
    case "belt":
      return glass ? (sh.chromeBelt ? S.chrome : S.gloss) : S.paint;
  }
}

/** Mirrors, handles, wipers, fin, rails, plates. */
function buildDetails(a: Acc, b: Body): void {
  const { L, sh } = b;
  const Z = (s: number) => s - L / 2;
  // Door mirrors on the door tops just behind the windscreen base.
  const sM = sh.gs1 - 0.14;
  const yB = b.top(sM);
  const x0 = b.halfW(sM) * b.edge;
  for (const sx of [-1, 1]) {
    const zc = Z(sM);
    a.box([sx * (x0 + 0.03), yB + 0.045, zc], [0.08, 0.045, 0.07], S.gloss);
    a.box([sx * (x0 + 0.115), yB + 0.095, zc], [0.19, 0.125, 0.105], S.paint);
    a.quad(
      [
        [sx * (x0 + 0.03), yB + 0.04, zc - 0.0535],
        [sx * (x0 + 0.2), yB + 0.04, zc - 0.0535],
        [sx * (x0 + 0.2), yB + 0.15, zc - 0.0535],
        [sx * (x0 + 0.03), yB + 0.15, zc - 0.0535],
      ],
      [0, 0, -1],
      S.mirror,
    );
    // Door handles just below the belt.
    for (const sH of sh.handles) {
      const y = b.top(sH) - 0.09;
      const x = b.sideX(sH, y);
      a.box(
        [sx * (x + 0.004), y, Z(sH)],
        [0.014, 0.028, 0.15],
        sh.chromeBelt ? S.chrome : S.paint,
      );
    }
  }
  // Wipers parked on the windscreen base.
  const sw = sh.gs1 - 0.075;
  const yw = b.roof(sw) + 0.014;
  a.bar([-0.66, yw, Z(sw)], [-0.02, yw, Z(sw + 0.02)], 0.022, 0.016, S.gloss);
  a.bar(
    [0.02, yw, Z(sw + 0.015)],
    [0.62, yw, Z(sw + 0.035)],
    0.022,
    0.016,
    S.gloss,
  );
  // Shark-fin aerial behind the rear screen (not on the van).
  if (!sh.van) {
    const sf = sh.screens[0][1] + 0.1;
    a.box(
      [0, b.roof(sf) + sh.crown + 0.025, Z(sf)],
      [0.065, 0.055, 0.15],
      S.gloss,
    );
  }
  // Roof rails along the roof edges.
  if (sh.rails) {
    const s0 = sh.screens[0][1] + 0.12;
    const s1 = sh.ws - 0.12;
    const N = 6;
    for (const sx of [-1, 1]) {
      const pt = (s: number): V3 => {
        const r = b.glassRing(s);
        return [sx * (r[3][0] - 0.03), b.roof(s) + 0.04, Z(s)];
      };
      for (let k = 0; k < N; k++)
        a.bar(
          pt(s0 + ((s1 - s0) * k) / N),
          pt(s0 + ((s1 - s0) * (k + 1)) / N),
          0.03,
          0.028,
          S.rail,
        );
      for (const s of [s0, s1]) {
        const p = pt(s);
        a.box([p[0], p[1] - 0.02, p[2]], [0.04, 0.045, 0.09], S.gloss);
      }
    }
  }
  // EU plates (520 × 110 mm): blue band on the viewer's left.
  const plate = (y: number, z: number, dir: 1 | -1) => {
    a.box([0, y, z + dir * 0.006], [0.52, 0.11, 0.012], S.plate);
    const zf = z + dir * 0.0135;
    a.box([dir * 0.235, y, zf], [0.045, 0.104, 0.003], S.plateBlue);
    for (let k = 0; k < 7; k++) {
      const x = dir * (0.17 - k * 0.058) - (k > 1 ? dir * 0.012 : 0);
      a.box([x, y, zf], [0.032, 0.062, 0.003], S.plateText);
    }
  };
  plate(sh.plate[0], L / 2, 1);
  plate(sh.plate[1], -L / 2, -1);
  if (sh.van) {
    // Split rear doors.
    a.box(
      [0, (sh.sill + 1.06) / 2 + 0.05, -L / 2 - 0.002],
      [0.008, 1.06 - sh.sill - 0.1, 0.004],
      S.seam,
    );
  }
}

/** Template of one variant in its local frame (pure data, cached). */
export interface CarTemplate {
  kind: CarKind;
  pos: Float32Array;
  nor: Float32Array;
  col: Float32Array;
  uv: Float32Array;
  /** 1: vertex takes the car's paint (colour + solid / metallic id). */
  paint: Uint8Array;
  idx: Uint32Array;
}

const templates = new Map<CarKind, CarTemplate>();

export function carTemplate(kind: CarKind): CarTemplate {
  const hit = templates.get(kind);
  if (hit) return hit;
  const a = new Acc();
  const b = new Body(CAR_MODELS[kind], SHAPES[kind]);
  buildLower(a, b);
  buildGlass(a, b);
  buildDetails(a, b);
  const t: CarTemplate = {
    kind,
    pos: new Float32Array(a.pos),
    nor: new Float32Array(a.nor),
    col: new Float32Array(a.col),
    uv: new Float32Array(a.uv),
    paint: new Uint8Array(a.paint),
    idx: new Uint32Array(a.idx),
  };
  templates.set(kind, t);
  return t;
}

// ------------------------------------------------------------- wheels

/** Wheel template size (225/50 R17); instances scale to their model's tyre. */
const WHEEL_R = 0.33;
const WHEEL_W = 0.225;

let wheelCache: CarTemplate | null = null;

/** One wheel at the origin, axle along x: tyre, 5-spoke alloy, disc. */
export function wheelTemplate(): CarTemplate {
  if (wheelCache) return wheelCache;
  const a = new Acc();
  const R = WHEEL_R;
  const hw = WHEEL_W / 2;
  const rim = 0.216;
  // Outline from the axis on the −x face over the tread to the +x face.
  const half: [number, number, Surf][] = [
    [0, -0.02, S.rimDark],
    [rim - 0.014, -0.02, S.rimDark],
    [rim - 0.004, -0.094, S.alloy],
    [rim + 0.006, -0.103, S.sidewall],
    [rim + 0.016, -0.1, S.sidewall],
    [0.27, -hw, S.sidewall],
    [R - 0.035, -hw + 0.004, S.tread],
    [R - 0.01, -hw + 0.022, S.tread],
    [R, -0.085, S.tread],
  ];
  const prof: [number, number][] = half.map(([r, x]) => [r, x]);
  const cols: Surf[] = half.map(([, , c]) => c);
  for (let i = half.length - 1; i >= 0; i--)
    prof.push([half[i][0], -half[i][1]]);
  for (let i = half.length - 2; i >= 0; i--) cols.push(half[i][2]);
  a.lathe(prof, cols, 28);
  for (const sx of [-1, 1]) {
    // Five spokes proud of the dark barrel, hub, centre cap.
    for (let k = 0; k < 5; k++) {
      const ang = (k / 5) * Math.PI * 2;
      const cy = Math.cos(ang);
      const cz = Math.sin(ang);
      a.bar(
        [sx * 0.082, 0.05 * cy, 0.05 * cz],
        [sx * 0.092, (rim - 0.01) * cy, (rim - 0.01) * cz],
        0.042,
        0.022,
        S.alloy,
        [1, 0, 0],
      );
    }
    a.lathe(
      // Outlines run outward on −x and inward on +x (normals face out).
      sx > 0
        ? [
            [0.07, 0.06],
            [0.07, 0.09],
            [0.03, 0.098],
            [0, 0.098],
          ]
        : [
            [0, -0.098],
            [0.03, -0.098],
            [0.07, -0.09],
            [0.07, -0.06],
          ],
      [S.alloy, S.alloy, S.alloy],
      16,
    );
    // Brake disc + calliper (seen through the spokes).
    a.lathe(
      sx > 0
        ? [
            [0.165, 0.05],
            [0.04, 0.05],
          ]
        : [
            [0.04, -0.05],
            [0.165, -0.05],
          ],
      [S.disc],
      20,
    );
    a.box([sx * 0.055, 0.11, -0.07], [0.03, 0.07, 0.11], S.calliper);
  }
  wheelCache = {
    kind: "hatch",
    pos: new Float32Array(a.pos),
    nor: new Float32Array(a.nor),
    col: new Float32Array(a.col),
    uv: new Float32Array(a.uv),
    paint: new Uint8Array(a.paint),
    idx: new Uint32Array(a.idx),
  };
  return wheelCache;
}

/** Thin-instance matrices of every parked car's wheels (world space). */
export function carWheelMatrices(
  cars: readonly CarSpot[],
  groundY: number,
): Float32Array {
  const buf = new Float32Array(cars.length * 4 * 16);
  const m = new Matrix();
  let o = 0;
  for (const c of cars) {
    const md = carModel(c);
    const cs = Math.cos(c.yaw);
    const sn = Math.sin(c.yaw);
    const sc = Matrix.Scaling(
      md.tyreW / WHEEL_W,
      md.tyreR / WHEEL_R,
      md.tyreR / WHEEL_R,
    );
    const rot = Matrix.RotationY(-c.yaw);
    for (const [x, y, z] of carWheels(md)) {
      sc.multiplyToRef(rot, m);
      m.setTranslationFromFloats(
        c.x + x * cs - z * sn,
        groundY + y,
        c.z + x * sn + z * cs,
      );
      m.copyToArray(buf, o);
      o += 16;
    }
  }
  return buf;
}

// ------------------------------------------------------------- scene

/** Shared material: vertex-coloured PBR, surface response from a lookup. */
export function carMaterial(scene: Scene): {
  mat: PBRMaterial;
  tex: RawTexture;
} {
  const data = new Uint8Array(SURF_N * 4);
  SURF_PROPS.forEach(([cc, rough, metal], i) => {
    data[i * 4] = Math.round(cc * 255);
    data[i * 4 + 1] = Math.round(rough * 255);
    data[i * 4 + 2] = Math.round(metal * 255);
    data[i * 4 + 3] = 255;
  });
  const tex = RawTexture.CreateRGBATexture(
    data,
    SURF_N,
    1,
    scene,
    false,
    false,
    Texture.NEAREST_SAMPLINGMODE,
  );
  tex.name = "exterior:carSurfaces";
  tex.wrapU = Texture.CLAMP_ADDRESSMODE;
  tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  const mat = new PBRMaterial("exterior:carMat", scene);
  mat.albedoColor = Color3.White();
  // R: clear-coat intensity · G: roughness · B: metallic.
  mat.metallic = 1;
  mat.roughness = 1;
  mat.metallicTexture = tex;
  mat.useRoughnessFromMetallicTextureAlpha = false;
  mat.useRoughnessFromMetallicTextureGreen = true;
  mat.useMetallnessFromMetallicTextureBlue = true;
  mat.clearCoat.isEnabled = true;
  mat.clearCoat.intensity = 1;
  mat.clearCoat.roughness = 0.03;
  mat.clearCoat.indexOfRefraction = 1.5;
  mat.clearCoat.texture = tex;
  mat.clearCoat.useRoughnessFromMainTexture = false;
  mat.environmentIntensity = 0.9;
  mat.enableSpecularAntiAliasing = true;
  mat.backFaceCulling = true;
  mat.freeze();
  return { mat, tex };
}

/** Exterior sky (+ skyline) reflections once the far bake lands. */
export function setCarReflection(
  mat: PBRMaterial,
  tex: BaseTexture | null,
): void {
  mat.unfreeze();
  mat.reflectionTexture = tex;
  mat.freeze();
}

/**
 * The car park in two draws: all bodies baked into one world-space mesh
 * (paint per car in the vertex colours) + every wheel thin-instanced.
 */
export function buildParkedCars(
  scene: Scene,
  cars: readonly CarSpot[],
  groundY: number,
  mat: PBRMaterial,
): Mesh[] {
  if (!cars.length) return [];
  let nv = 0;
  let ni = 0;
  for (const c of cars) {
    const t = carTemplate(carModel(c).kind);
    nv += t.pos.length / 3;
    ni += t.idx.length;
  }
  const pos = new Float32Array(nv * 3);
  const nor = new Float32Array(nv * 3);
  const col = new Float32Array(nv * 4);
  const uv = new Float32Array(nv * 2);
  const idx = new Uint32Array(ni);
  let v0 = 0;
  let i0 = 0;
  for (const c of cars) {
    const t = carTemplate(carModel(c).kind);
    const p = paintOf(c.color);
    const pu = (p.id + 0.5) / SURF_N;
    const cs = Math.cos(c.yaw);
    const sn = Math.sin(c.yaw);
    const n = t.pos.length / 3;
    for (let k = 0; k < n; k++) {
      const x = t.pos[k * 3];
      const z = t.pos[k * 3 + 2];
      const o = (v0 + k) * 3;
      pos[o] = c.x + x * cs - z * sn;
      pos[o + 1] = groundY + t.pos[k * 3 + 1];
      pos[o + 2] = c.z + x * sn + z * cs;
      const nx = t.nor[k * 3];
      const nz = t.nor[k * 3 + 2];
      nor[o] = nx * cs - nz * sn;
      nor[o + 1] = t.nor[k * 3 + 1];
      nor[o + 2] = nx * sn + nz * cs;
      const q = (v0 + k) * 4;
      const pk = t.paint[k] === 1;
      for (let e = 0; e < 4; e++) col[q + e] = pk ? p.col[e] : t.col[k * 4 + e];
      uv[(v0 + k) * 2] = pk ? pu : t.uv[k * 2];
      uv[(v0 + k) * 2 + 1] = 0.5;
    }
    // Flip to Babylon's front-face winding.
    for (let e = 0; e < t.idx.length; e += 3) {
      idx[i0 + e] = t.idx[e] + v0;
      idx[i0 + e + 1] = t.idx[e + 2] + v0;
      idx[i0 + e + 2] = t.idx[e + 1] + v0;
    }
    v0 += n;
    i0 += t.idx.length;
  }
  const body = new Mesh("exterior:cars", scene);
  const vd = new VertexData();
  vd.positions = pos;
  vd.normals = nor;
  vd.colors = col;
  vd.uvs = uv;
  vd.indices = idx;
  vd.applyToMesh(body);

  const wt = wheelTemplate();
  const wheels = new Mesh("exterior:carWheels", scene);
  const wd = new VertexData();
  wd.positions = wt.pos;
  wd.normals = wt.nor;
  wd.colors = wt.col;
  wd.uvs = wt.uv;
  const wi = new Uint32Array(wt.idx.length);
  for (let e = 0; e < wt.idx.length; e += 3) {
    wi[e] = wt.idx[e];
    wi[e + 1] = wt.idx[e + 2];
    wi[e + 2] = wt.idx[e + 1];
  }
  wd.indices = wi;
  wd.applyToMesh(wheels);
  wheels.thinInstanceSetBuffer(
    "matrix",
    carWheelMatrices(cars, groundY),
    16,
    true,
  );
  wheels.thinInstanceRefreshBoundingInfo(false);

  for (const m of [body, wheels]) {
    m.material = mat;
    m.isPickable = false;
    m.receiveShadows = false;
    m.hasVertexAlpha = false;
    m.freezeWorldMatrix();
  }
  return [body, wheels];
}
