/**
 * Procedural furniture family — one coherent contemporary line (light oak,
 * black powder-coated steel, taupe / graphite upholstery, white solid
 * surface), built with rounded edges so nothing reads as a raw CG box.
 *
 * Canonical prop frame: origin on the floor at the footprint centre, metres,
 * and the *user* of the prop faces +Z (they stand / sit on the -Z side of
 * desks, the backrest of chairs / sofas is at -Z, shelves open towards -Z).
 * Wall-hung props (art, hooks) face -Z and are placed with a yaw.
 *
 * Every builder emits into an ArtBatcher: one draw call per material per
 * role whatever the number of placements (thin instances), plus per-piece
 * albedo jitter so repeated boards / books / cushions differ subtly.
 */
import {
  Matrix,
  Quaternion,
  Vector3,
  type Material,
  type Mesh,
  type Scene,
} from "@/engine/babylon";
import type { ModelRole } from "@/engine/assets/manifest";
import type { Materials } from "@/engine/materials/Materials";
import { ArtBatcher, paintOf } from "@/engine/art/geometry";
import { v3 } from "@/engine/util/MeshBatcher";

type Builder = (b: ArtBatcher) => void;

/** Procedural-only roles (always built in code, never loaded). */
export type ProceduralRole =
  | "workDesk"
  | "taskChair"
  | "execDesk"
  | "artPrint"
  | "loungeTable"
  | "sofa"
  | "chair"
  | "shelves"
  | "coffeeCart"
  | "laptop"
  | "planter"
  | "planterTall"
  | "floorLamp"
  | "coatHooks"
  | "sideTable";
export type PropRole = ModelRole | ProceduralRole;
export const PROCEDURAL_ROLES: readonly ProceduralRole[] = [
  "workDesk",
  "taskChair",
  "execDesk",
  "artPrint",
  "loungeTable",
  "sofa",
  "chair",
  "shelves",
  "coffeeCart",
  "laptop",
  "planter",
  "planterTall",
  "floorLamp",
  "coatHooks",
  "sideTable",
];

const BOOK_COLORS = [
  "#C9B79C",
  "#2F4858",
  "#B8664A",
  "#E8E2D6",
  "#5C6B73",
  "#8C6646",
  "#3A3D42",
  "#7E9A82",
  "#D8CFC0",
  "#1F2A33",
];

const MUG_COLORS = ["#E9E6E1", "#2B2D31", "#C9775A", "#8FA392", "#E9E6E1"];

/** Mug with handle (vertex-painted). */
function mug(b: ArtBatcher, x: number, y: number, z: number, i: number) {
  b.paint = paintOf(MUG_COLORS[i % MUG_COLORS.length]);
  b.cylinder("paint", v3(x, y + 0.048, z), 0.095, 0.082, 0.078, 18);
  b.rbox("paint", v3(x + 0.05, y + 0.05, z), v3(0.018, 0.055, 0.012), {
    r: 0.005,
  });
  b.paint = null;
}

/** Slim aluminium keyboard + mouse. */
function keyboard(b: ArtBatcher, x: number, y: number, z: number, yaw = 0) {
  b.paint = paintOf("#B9BCC0");
  b.rbox("paint", v3(x, y + 0.006, z), v3(0.42, 0.012, 0.125), {
    r: 0.004,
    yaw,
  });
  b.rbox("paint", v3(x + 0.3, y + 0.012, z + 0.01), v3(0.06, 0.022, 0.1), {
    r: 0.02,
    seg: 2,
    yaw,
  });
  b.paint = paintOf("#2A2B2E");
  b.rbox("paint", v3(x, y + 0.0125, z + 0.004), v3(0.39, 0.002, 0.105), {
    r: 0.001,
    yaw,
  });
  b.paint = null;
}

/**
 * Bench desk: 25 mm oak top with soft edge, black T-legs, cable tray +
 * cable spine, felt privacy screen, keyboard, mug, notebook.
 */
const workDesk: Builder = (b) => {
  const w = 1.4;
  const d = 0.72;
  const h = 0.74;
  const top = 0.025;
  b.rbox("oak", v3(0, h - top / 2, 0), v3(w, top, d), { r: 0.008 });
  for (const sx of [-1, 1]) {
    const x = sx * (w / 2 - 0.1);
    b.rbox(
      "blackMetal",
      v3(x, (h - top) / 2, 0),
      v3(0.06, h - top - 0.02, 0.06),
      {
        r: 0.004,
      },
    );
    b.rbox("blackMetal", v3(x, 0.012, 0), v3(0.07, 0.024, d - 0.08), {
      r: 0.006,
    });
    b.rbox("blackMetal", v3(x, h - top - 0.02, 0), v3(0.06, 0.03, d - 0.14), {
      r: 0.004,
    });
  }
  b.rbox("blackMetal", v3(0, h - top - 0.035, 0.08), v3(w - 0.26, 0.04, 0.03), {
    r: 0.004,
  });
  // Cable tray (wire basket) + cable spine down a leg.
  b.rbox("blackMetal", v3(0, h - 0.13, d / 2 - 0.13), v3(w - 0.4, 0.07, 0.15), {
    r: 0.006,
  });
  b.cylinder(
    "blackMetal",
    v3(w / 2 - 0.16, (h - 0.13) / 2, d / 2 - 0.12),
    h - 0.13,
    0.035,
    0.035,
    10,
  );
  // Felt privacy screen along the far edge.
  b.rbox("fabric", v3(0, h + 0.2, d / 2 - 0.016), v3(w - 0.04, 0.4, 0.026), {
    r: 0.012,
    seg: 2,
  });
  b.rbox(
    "blackMetal",
    v3(-0.45, h + 0.02, d / 2 - 0.016),
    v3(0.03, 0.05, 0.05),
    { r: 0.004 },
  );
  b.rbox(
    "blackMetal",
    v3(0.45, h + 0.02, d / 2 - 0.016),
    v3(0.03, 0.05, 0.05),
    { r: 0.004 },
  );
  keyboard(b, -0.05, h, -0.12);
  mug(b, -0.52, h, 0.05, 0);
  // Notebook + pen
  b.paint = paintOf("#2F4858");
  b.rbox("paint", v3(0.48, h + 0.007, -0.08), v3(0.15, 0.014, 0.21), {
    r: 0.004,
    yaw: 0.18,
  });
  b.paint = null;
  b.cylinder("blackMetal", v3(0.5, h + 0.017, -0.06), 0.14, 0.008, 0.008, 6, {
    roll: Math.PI / 2,
    yaw: 0.5,
  });
};

/** Ergonomic task chair: mesh back in a black frame, upholstered seat, 5-star base. */
const taskChair: Builder = (b) => {
  b.rbox("fabricDark", v3(0, 0.47, 0.03), v3(0.48, 0.075, 0.47), {
    r: 0.035,
    seg: 2,
  });
  b.rbox("blackMetal", v3(0, 0.42, 0.03), v3(0.34, 0.03, 0.32), { r: 0.01 });
  // Back: frame + mesh
  b.rbox("blackMetal", v3(0, 0.86, -0.235), v3(0.46, 0.56, 0.03), {
    r: 0.06,
    seg: 2,
    pitch: -0.14,
  });
  b.rbox("mesh", v3(0, 0.86, -0.225), v3(0.42, 0.52, 0.012), {
    r: 0.05,
    seg: 2,
    pitch: -0.14,
  });
  b.rbox("fabricDark", v3(0, 0.7, -0.2), v3(0.34, 0.07, 0.03), {
    r: 0.02,
    seg: 2,
    pitch: -0.1,
  });
  b.rbox("blackMetal", v3(0, 0.56, -0.24), v3(0.06, 0.26, 0.035), {
    r: 0.01,
    pitch: -0.1,
  });
  b.cylinder("blackMetal", v3(0, 0.27, 0), 0.3, 0.045, 0.045, 16);
  b.cylinder("blackMetal", v3(0, 0.15, 0), 0.08, 0.07, 0.07, 16);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    b.rbox(
      "blackMetal",
      v3(Math.sin(a) * 0.16, 0.085, Math.cos(a) * 0.16),
      v3(0.04, 0.03, 0.31),
      { yaw: a, r: 0.012, seg: 2 },
    );
    b.sphere(
      "blackMetal",
      v3(Math.sin(a) * 0.3, 0.03, Math.cos(a) * 0.3),
      0.055,
      v3(1, 1, 1),
      10,
    );
  }
  for (const sx of [-1, 1]) {
    b.rbox("blackMetal", v3(sx * 0.265, 0.58, 0.0), v3(0.025, 0.2, 0.03), {
      r: 0.008,
    });
    b.rbox("blackMetal", v3(sx * 0.265, 0.69, 0.03), v3(0.065, 0.025, 0.24), {
      r: 0.012,
      seg: 2,
    });
  }
};

/** Executive desk: smoked-oak top, black frame, white lacquer pedestal, lamp. */
const execDesk: Builder = (b) => {
  const w = 1.9;
  const d = 0.85;
  const h = 0.75;
  b.rbox("oakDark", v3(0, h - 0.018, 0), v3(w, 0.036, d), { r: 0.01 });
  b.rbox(
    "oakDark",
    v3(0, h * 0.56, d / 2 - 0.08),
    v3(w - 0.2, h * 0.55, 0.024),
    {
      r: 0.006,
    },
  );
  for (const sx of [-1, 1]) {
    const x = sx * (w / 2 - 0.08);
    for (const sz of [-1, 1])
      b.rbox(
        "blackMetal",
        v3(x, (h - 0.036) / 2, sz * (d / 2 - 0.08)),
        v3(0.045, h - 0.036, 0.045),
        {
          r: 0.006,
        },
      );
    b.rbox("blackMetal", v3(x, h - 0.06, 0), v3(0.045, 0.04, d - 0.12), {
      r: 0.006,
    });
  }
  // Pedestal (handle-less drawers, groove lines)
  const px = w / 2 - 0.36;
  b.rbox("quartz", v3(px, 0.3, -0.03), v3(0.42, 0.58, 0.6), { r: 0.012 });
  for (const y of [0.22, 0.42])
    b.rbox("blackMetal", v3(px, y, -0.333), v3(0.4, 0.006, 0.004), { r: 0 });
  keyboard(b, -0.05, h, -0.16);
  // Desk lamp
  b.cylinder("blackMetal", v3(-0.74, h + 0.008, 0.2), 0.016, 0.15, 0.15, 24);
  b.cylinder("blackMetal", v3(-0.74, h + 0.21, 0.22), 0.4, 0.014, 0.014, 8, {
    pitch: 0.18,
  });
  b.cylinder("blackMetal", v3(-0.68, h + 0.4, 0.15), 0.12, 0.09, 0.13, 20, {
    roll: 0.9,
  });
  b.paint = paintOf("#B8664A");
  b.rbox("paint", v3(0.45, h + 0.008, -0.1), v3(0.16, 0.016, 0.22), {
    r: 0.004,
    yaw: 0.25,
  });
  b.paint = null;
  mug(b, 0.7, h, 0.15, 2);
  // Pen pot
  b.cylinder("blackMetal", v3(0.62, h + 0.05, 0.25), 0.1, 0.07, 0.07, 16);
};

/** Framed abstract print (0.8 × 1.0 m), hung by its centre, faces -Z. */
const artPrint: Builder = (b) => {
  const w = 0.8;
  const h = 1.0;
  b.rbox("blackMetal", v3(0, 0, 0.012), v3(w + 0.04, h + 0.04, 0.024), {
    r: 0.004,
  });
  b.paint = paintOf("#F1ECE4");
  b.box("paint", v3(0, 0, 0), v3(w - 0.06, h - 0.06, 0.02));
  b.paint = paintOf("#D97757");
  b.cylinder("paint", v3(-0.06, 0.14, -0.012), 0.004, 0.36, 0.36, 48, {
    pitch: Math.PI / 2,
  });
  b.paint = paintOf("#2F4858");
  b.box("paint", v3(0.12, -0.12, -0.013), v3(0.3, 0.42, 0.004));
  b.paint = paintOf("#C9B79C");
  b.box("paint", v3(0.0, -0.32, -0.014), v3(0.5, 0.05, 0.004));
  b.paint = null;
};

const loungeTable: Builder = (b) => {
  b.cylinder("oak", v3(0, 0.4, 0), 0.03, 0.7, 0.7, 48);
  b.cylinder("oak", v3(0, 0.382, 0), 0.006, 0.68, 0.68, 48);
  b.cylinder("blackMetal", v3(0, 0.2, 0), 0.36, 0.05, 0.05, 16);
  b.cylinder("blackMetal", v3(0, 0.008, 0), 0.016, 0.42, 0.42, 40);
  b.paint = paintOf("#E8E2D6");
  b.rbox("paint", v3(0.08, 0.425, 0.05), v3(0.24, 0.02, 0.3), {
    r: 0.004,
    yaw: 0.3,
  });
  b.paint = paintOf("#2F4858");
  b.rbox("paint", v3(0.1, 0.443, 0.06), v3(0.22, 0.016, 0.28), {
    r: 0.004,
    yaw: 0.22,
  });
  b.paint = null;
  mug(b, -0.18, 0.415, -0.1, 3);
};

/** Low modern sofa: upholstered plinth, soft cushions, slim black legs. */
const sofa: Builder = (b) => {
  const w = 2.1;
  const d = 0.9;
  b.rbox("fabricWarm", v3(0, 0.22, 0), v3(w, 0.2, d), { r: 0.03, seg: 2 });
  for (const sx of [-1, 1]) {
    b.rbox("fabricWarm", v3(sx * 0.47, 0.39, 0.06), v3(0.93, 0.15, d - 0.2), {
      r: 0.05,
      seg: 3,
    });
    b.rbox(
      "fabricWarm",
      v3(sx * 0.47, 0.6, -d / 2 + 0.16),
      v3(0.95, 0.4, 0.2),
      {
        r: 0.07,
        seg: 3,
        pitch: -0.14,
      },
    );
    b.rbox("fabricWarm", v3(sx * (w / 2 - 0.075), 0.4, 0), v3(0.15, 0.36, d), {
      r: 0.05,
      seg: 3,
    });
  }
  b.rbox("fabricAccent", v3(-0.66, 0.6, -d / 2 + 0.32), v3(0.42, 0.4, 0.13), {
    r: 0.06,
    seg: 3,
    pitch: -0.3,
    yaw: 0.15,
  });
  b.rbox("fabricWarm", v3(0.7, 0.58, -d / 2 + 0.32), v3(0.4, 0.38, 0.12), {
    r: 0.06,
    seg: 3,
    pitch: -0.3,
    yaw: -0.12,
  });
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      b.cylinder(
        "blackMetal",
        v3(sx * (w / 2 - 0.12), 0.06, sz * (d / 2 - 0.12)),
        0.12,
        0.03,
        0.022,
        10,
      );
};

/** Lounge armchair: graphite upholstery on an oak frame. */
const chair: Builder = (b) => {
  b.rbox("fabricDark", v3(0, 0.4, 0.04), v3(0.66, 0.13, 0.62), {
    r: 0.05,
    seg: 3,
  });
  b.rbox("fabricDark", v3(0, 0.66, -0.27), v3(0.66, 0.44, 0.13), {
    r: 0.06,
    seg: 3,
    pitch: -0.2,
  });
  for (const sx of [-1, 1]) {
    b.rbox("oak", v3(sx * 0.35, 0.52, 0.02), v3(0.05, 0.035, 0.6), {
      r: 0.012,
    });
    for (const sz of [-1, 1])
      b.rbox("oak", v3(sx * 0.33, 0.17, sz * 0.24), v3(0.04, 0.34, 0.04), {
        r: 0.012,
        roll: sx * 0.08,
        pitch: -sz * 0.08,
      });
  }
};

/** Open shelving: black frame, oak shelves, vertex-painted books, ceramics. */
const shelves: Builder = (b) => {
  const w = 1.0;
  const h = 1.85;
  const d = 0.36;
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      b.rbox(
        "blackMetal",
        v3(sx * (w / 2 - 0.012), h / 2, sz * (d / 2 - 0.012)),
        v3(0.022, h, 0.022),
        {
          r: 0.004,
        },
      );
  const levels = [0.06, 0.48, 0.9, 1.32, 1.74];
  let k = 0;
  levels.forEach((y, li) => {
    b.rbox("oak", v3(0, y, 0), v3(w - 0.03, 0.026, d), { r: 0.005 });
    if (li === levels.length - 1) return;
    let x = -w / 2 + 0.06;
    while (x < w / 2 - 0.1) {
      k += 1;
      if ((k * 5) % 13 === 3) {
        // Ceramic vase / object gap
        b.paint = paintOf("#E6E3DE");
        b.cylinder(
          "paint",
          v3(x + 0.06, y + 0.013 + 0.09, 0.02),
          0.18,
          0.07,
          0.1,
          18,
        );
        x += 0.16;
        continue;
      }
      if ((k * 7) % 17 === 5) {
        // Lying stack
        for (let s = 0; s < 3; s++) {
          b.paint = paintOf(BOOK_COLORS[(k + s) % BOOK_COLORS.length]);
          b.rbox(
            "paint",
            v3(x + 0.1, y + 0.025 + s * 0.026, 0.02),
            v3(0.2, 0.024, d * 0.66),
            {
              r: 0.003,
              yaw: (s - 1) * 0.06,
            },
          );
        }
        x += 0.24;
        continue;
      }
      const bw = 0.024 + ((k * 7) % 5) * 0.007;
      const bh = 0.2 + ((k * 13) % 7) * 0.018;
      b.paint = paintOf(BOOK_COLORS[(k * 3) % BOOK_COLORS.length]);
      const lean = (k * 11) % 9 === 0 ? 0.12 : 0;
      b.rbox(
        "paint",
        v3(x + bw / 2, y + 0.013 + bh / 2, 0.02),
        v3(bw, bh, d * 0.7),
        {
          r: 0.003,
          roll: lean,
        },
      );
      x += bw + 0.003 + lean * 0.1;
    }
  });
  b.paint = null;
  b.paint = paintOf("#3B3C3E");
  b.cylinder("paint", v3(0.3, 1.753 + 0.07, 0), 0.14, 0.13, 0.11, 18);
  b.paint = paintOf("#4E7A45");
  b.sphere("paint", v3(0.3, 1.93, 0), 0.24, v3(1, 0.75, 1), 10);
  b.paint = paintOf("#2F5A32");
  b.sphere("paint", v3(0.24, 1.97, 0.03), 0.16, v3(1, 0.8, 1), 8);
  b.paint = null;
};

/** Coffee point: oak credenza with a quartz top, espresso machine, cups. */
const coffeeCart: Builder = (b) => {
  const w = 1.5;
  const d = 0.48;
  const h = 0.86;
  b.rbox("blackMetal", v3(0, 0.05, 0), v3(w - 0.06, 0.1, d - 0.06), {
    r: 0.006,
  });
  b.rbox("oak", v3(0, 0.1 + (h - 0.13) / 2, 0), v3(w, h - 0.13, d), {
    r: 0.008,
  });
  for (const x of [-w / 4, 0, w / 4])
    b.rbox(
      "blackMetal",
      v3(x, 0.1 + (h - 0.13) / 2, -d / 2 - 0.001),
      v3(0.006, h - 0.17, 0.004),
      {
        r: 0,
      },
    );
  b.rbox("quartz", v3(0, h - 0.015, 0), v3(w + 0.02, 0.03, d + 0.02), {
    r: 0.006,
  });
  // Espresso machine
  b.rbox("aluminium", v3(-0.35, h + 0.19, 0.04), v3(0.36, 0.38, 0.34), {
    r: 0.025,
    seg: 2,
  });
  b.rbox("blackMetal", v3(-0.35, h + 0.12, -0.14), v3(0.24, 0.05, 0.05), {
    r: 0.01,
  });
  b.rbox("blackMetal", v3(-0.35, h + 0.016, -0.06), v3(0.26, 0.02, 0.16), {
    r: 0.006,
  });
  b.cylinder("blackMetal", v3(-0.35, h + 0.39, 0.09), 0.02, 0.2, 0.2, 20);
  // Cups + grinder + kettle
  for (let i = 0; i < 4; i++) mug(b, 0.05 + i * 0.1, h, -0.1, i);
  b.cylinder("blackMetal", v3(0.5, h + 0.12, 0.08), 0.24, 0.13, 0.15, 20);
  b.cylinder("aluminium", v3(0.18, h + 0.14, 0.12), 0.26, 0.11, 0.11, 18);
};

const laptop: Builder = (b) => {
  b.rbox("aluminium", v3(0, 0.0075, 0), v3(0.31, 0.015, 0.215), { r: 0.006 });
  b.paint = paintOf("#1E1F22");
  b.rbox("paint", v3(0, 0.0152, -0.025), v3(0.27, 0.001, 0.1), { r: 0.0005 });
  b.paint = null;
  b.rbox("aluminium", v3(0, 0.112, 0.112), v3(0.31, 0.205, 0.007), {
    r: 0.006,
    pitch: -0.22,
  });
  b.box("screenOff", v3(0, 0.114, 0.107), v3(0.285, 0.18, 0.002), {
    pitch: -0.22,
  });
};

/**
 * Matte fibre-clay planter: body, a rolled rim and a soil surface sunk
 * 2.5 cm below the rim (the scanned foliage's base sits ON the soil, see
 * PLANTER_SOIL_Y; stems below it disappear into the body).
 */
function planterBuilder(dia: number, h: number): Builder {
  return (b) => {
    const sunk = 0.025; // soil surface below the rim
    const body = h - sunk - 0.008;
    // Body up to just under the soil.
    b.cylinder(
      "planter",
      v3(0, body / 2, 0),
      body,
      dia * 0.985,
      dia * 0.86,
      40,
    );
    b.cylinder("planter", v3(0, 0.01, 0), 0.02, dia * 0.8, dia * 0.8, 32);
    // Rim ring: the pot wall standing proud of the soil.
    b.arc(
      "planter",
      v3(0, 0, 0),
      dia / 2 - 0.016,
      dia / 2,
      0,
      Math.PI * 2,
      body - 0.01,
      h,
      48,
    );
    // Soil disc, top surface `sunk` below the rim.
    b.cylinder(
      "soil",
      v3(0, h - sunk - 0.004, 0),
      0.008,
      dia - 0.03,
      dia - 0.03,
      32,
    );
  };
}

/** Planter heights (metres, scale 1). */
export const PLANTER_H = { planter: 0.46, planterTall: 0.62 } as const;

/**
 * Where scanned foliage is placed in each planter role (scale 1): its base
 * (the scan's original soil line) 5 mm under the soil surface, which is
 * 2.5 cm below the rim. Multiply by the planter's scale.
 */
export const PLANTER_SOIL_Y = {
  planter: PLANTER_H.planter - 0.03,
  planterTall: PLANTER_H.planterTall - 0.03,
} as const;

/** Floor lamp: black stem, glowing linen drum shade. */
const floorLamp: Builder = (b) => {
  b.cylinder("blackMetal", v3(0, 0.012, 0), 0.024, 0.3, 0.3, 32);
  b.cylinder("blackMetal", v3(0, 0.75, 0), 1.48, 0.022, 0.022, 10);
  b.cylinder("lampShade", v3(0, 1.48, 0), 0.32, 0.42, 0.46, 40);
};

/** Wall coat rail with hooks, a coat and a tote (faces -Z, hung by the rail). */
const coatHooks: Builder = (b) => {
  b.rbox("oak", v3(0, 1.72, 0.01), v3(0.9, 0.09, 0.022), { r: 0.006 });
  for (let i = 0; i < 4; i++) {
    const x = -0.33 + i * 0.22;
    b.rbox("blackMetal", v3(x, 1.72, -0.03), v3(0.014, 0.014, 0.06), {
      r: 0.004,
    });
  }
  // Coat
  b.rbox("fabricDark", v3(-0.11, 1.32, -0.06), v3(0.42, 0.8, 0.1), {
    r: 0.05,
    seg: 2,
    roll: 0.03,
  });
  b.rbox("fabricDark", v3(-0.11, 1.68, -0.07), v3(0.2, 0.08, 0.06), {
    r: 0.03,
    seg: 2,
  });
  // Tote bag
  b.paint = [3.2, 2.9, 2.5];
  b.rbox("fabricDark", v3(0.33, 1.42, -0.05), v3(0.32, 0.36, 0.06), {
    r: 0.02,
    seg: 2,
  });
  b.rbox("fabricDark", v3(0.33, 1.64, -0.05), v3(0.012, 0.16, 0.012), {
    r: 0.004,
  });
  b.paint = null;
};

const sideTable: Builder = (b) => {
  b.cylinder("quartz", v3(0, 0.52, 0), 0.025, 0.42, 0.42, 40);
  b.cylinder("blackMetal", v3(0, 0.26, 0), 0.5, 0.03, 0.03, 10);
  b.cylinder("blackMetal", v3(0, 0.008, 0), 0.016, 0.3, 0.3, 32);
};

const desk: Builder = workDesk;

function plantBuilder(
  potH: number,
  potD: number,
  foliage: number,
  height: number,
  tall = false,
): Builder {
  return (b) => {
    if (potH > 0)
      b.cylinder("planter", v3(0, potH / 2, 0), potH, potD, potD * 0.84, 32);
    if (potH > 0)
      b.cylinder(
        "soil",
        v3(0, potH - 0.01, 0),
        0.02,
        potD * 0.92,
        potD * 0.92,
        24,
      );
    if (tall)
      b.cylinder(
        "oakDark",
        v3(0, potH + (height - potH) * 0.35, 0),
        (height - potH) * 0.7,
        0.03,
        0.04,
        8,
      );
    const n = 11;
    for (let i = 0; i < n; i++) {
      const a = i * 2.39996;
      const t = i / (n - 1);
      const r = foliage * 0.32 * (0.4 + 0.6 * Math.sin(t * Math.PI));
      const y =
        potH + (height - potH) * (tall ? 0.45 + t * 0.5 : 0.25 + t * 0.6);
      b.sphere(
        i % 3 === 0 ? "plantLeafDark" : "plantLeaf",
        v3(Math.cos(a) * r, y, Math.sin(a) * r),
        foliage * (0.55 - t * 0.2),
        v3(1, 0.75, 1),
        10,
      );
    }
  };
}

const securityCamera: Builder = (b) => {
  b.rbox("quartz", v3(0, 0.05, 0), v3(0.08, 0.1, 0.08), { r: 0.01 });
  b.cylinder("quartz", v3(0, -0.02, 0.1), 0.24, 0.09, 0.08, 16, {
    pitch: Math.PI / 2 - 0.3,
  });
  b.cylinder("screenOff", v3(0, -0.05, 0.22), 0.01, 0.06, 0.06, 16, {
    pitch: Math.PI / 2 - 0.3,
  });
};

const projectorScreen: Builder = (b) => {
  b.box("ceramic", v3(0, 1.4, 0), v3(2, 1.3, 0.02));
  b.box("blackMetal", v3(0, 2.1, 0), v3(2.1, 0.1, 0.1));
};

const notepads: Builder = (b) => {
  b.paint = paintOf("#F1ECE4");
  b.rbox("paint", v3(0, 0.006, 0), v3(0.15, 0.012, 0.21), { r: 0.003 });
  b.paint = paintOf("#B8664A");
  b.rbox("paint", v3(0.18, 0.008, 0.02), v3(0.15, 0.016, 0.21), {
    r: 0.003,
    yaw: 0.2,
  });
  b.paint = null;
};

const fireAlarm: Builder = (b) => {
  b.paint = paintOf("#C0392B");
  b.rbox("paint", v3(0, 0, 0.02), v3(0.12, 0.12, 0.04), { r: 0.01 });
  b.paint = null;
};

/** Unused by the art direction (kept so the role still resolves). */
const wetFloorSign: Builder = (b) => {
  b.paint = paintOf("#F2C230");
  b.rbox("paint", v3(0, 0.32, -0.12), v3(0.3, 0.64, 0.02), {
    pitch: 0.2,
    r: 0.01,
  });
  b.rbox("paint", v3(0, 0.32, 0.12), v3(0.3, 0.64, 0.02), {
    pitch: -0.2,
    r: 0.01,
  });
  b.paint = null;
};

const BUILDERS: Record<PropRole, Builder> = {
  workDesk,
  taskChair,
  execDesk,
  artPrint,
  loungeTable,
  desk,
  chair,
  sofa,
  shelves,
  plant: plantBuilder(0.42, 0.38, 0.62, 1.15),
  plantSmall: plantBuilder(0.12, 0.13, 0.22, 0.32),
  plantTall: plantBuilder(0.5, 0.42, 0.7, 1.9, true),
  coffeeCart,
  laptop,
  securityCamera,
  projectorScreen,
  notepads,
  fireAlarm,
  wetFloorSign,
  planter: planterBuilder(0.5, PLANTER_H.planter),
  planterTall: planterBuilder(0.56, PLANTER_H.planterTall),
  floorLamp,
  coatHooks,
  sideTable,
};

/** Build the procedural parts for a role (merged per material, model space). */
export function buildProceduralProp(
  scene: Scene,
  materials: Materials,
  role: PropRole,
): Mesh[] {
  const b = new ArtBatcher(scene, materials, `proc:${role}`);
  BUILDERS[role](b);
  return b.build({ receiveShadows: true });
}

export interface PropTransform {
  x: number;
  y?: number;
  z: number;
  yaw?: number;
  scale?: number;
}

/**
 * Emit a procedural prop, transformed, into another batcher (prefab baking:
 * the room module merges its furniture with the architecture per material).
 * `seed` varies the per-piece jitter between placements. Returns the prop's
 * model-space size (for colliders).
 */
export function emitProp(
  target: ArtBatcher,
  scene: Scene,
  materials: Materials,
  role: PropRole,
  t: PropTransform,
  seed: number,
): Vector3 {
  const tmp = new ArtBatcher(scene, materials, `proc:${role}`, seed);
  BUILDERS[role](tmp);
  const meshes = tmp.build({});
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const m of meshes) {
    m.refreshBoundingInfo();
    const bb = m.getBoundingInfo().boundingBox;
    min.minimizeInPlace(bb.minimum);
    max.maximizeInPlace(bb.maximum);
  }
  const s = t.scale ?? 1;
  const xf = Matrix.Compose(
    new Vector3(s, s, s),
    Quaternion.RotationYawPitchRoll(t.yaw ?? 0, 0, 0),
    new Vector3(t.x, t.y ?? 0, t.z),
  );
  for (const m of meshes) {
    m.unfreezeWorldMatrix();
    m.bakeTransformIntoVertices(xf);
    target.addRaw(m.material as Material, m);
  }
  return Number.isFinite(min.x) ? max.subtract(min).scale(s) : Vector3.Zero();
}
