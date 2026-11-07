/**
 * Procedural stand-ins for every manifest model role, used when the glTF is
 * missing (assets not downloaded) or fails to load. Built in the canonical
 * prop frame: origin on the floor at the footprint centre, metres, and the
 * *user* of the prop faces +Z (they stand/sit on the -Z side of desks, the
 * backrest of chairs/sofas is at -Z, shelves open towards -Z).
 */
import type { Mesh, Scene } from "@/engine/babylon";
import type { ModelRole } from "@/engine/assets/manifest";
import type { Materials } from "@/engine/materials/Materials";
import { MeshBatcher, v3 } from "@/engine/util/MeshBatcher";

type Builder = (b: MeshBatcher) => void;

/** Procedural-only roles (always built in code, never loaded). */
export type ProceduralRole =
  "workDesk" | "taskChair" | "execDesk" | "artPrint" | "loungeTable";
export type PropRole = ModelRole | ProceduralRole;
export const PROCEDURAL_ROLES: readonly ProceduralRole[] = [
  "workDesk",
  "taskChair",
  "execDesk",
  "artPrint",
  "loungeTable",
];

/** Modern bench desk: oak top, white A-frame legs, cable tray, felt privacy screen. */
const workDesk: Builder = (b) => {
  const w = 1.4;
  const d = 0.72;
  const h = 0.74;
  const top = 0.025;
  b.box("oak", v3(0, h - top / 2, 0), v3(w, top, d));
  // Edge band (darker oak) for a crafted look
  b.box("oakDark", v3(0, h - top / 2, -d / 2 + 0.004), v3(w, top, 0.008));
  const white = b.materials.color("#E9E8E4", 0.45, 0.2);
  for (const sx of [-1, 1]) {
    const x = sx * (w / 2 - 0.08);
    b.box(white, v3(x, (h - top) / 2, -d / 2 + 0.09), v3(0.04, h - top, 0.04), {
      pitch: 0.12,
    });
    b.box(white, v3(x, (h - top) / 2, d / 2 - 0.09), v3(0.04, h - top, 0.04), {
      pitch: -0.12,
    });
    b.box(white, v3(x, h - top - 0.03, 0), v3(0.05, 0.04, d - 0.12));
  }
  b.box(white, v3(0, h - top - 0.05, d / 2 - 0.2), v3(w - 0.24, 0.03, 0.04));
  b.box("charcoal", v3(0, h - 0.14, d / 2 - 0.16), v3(w - 0.4, 0.06, 0.16)); // cable tray
  // Felt privacy screen along the far edge
  b.box(
    b.materials.color("#8C948C", 0.97),
    v3(0, h + 0.2, d / 2 - 0.015),
    v3(w - 0.04, 0.4, 0.024),
  );
  // Keyboard + mouse
  b.box("charcoal", v3(-0.05, h + 0.008, -0.12), v3(0.42, 0.014, 0.13));
  b.box("charcoal", v3(0.28, h + 0.01, -0.12), v3(0.06, 0.02, 0.1));
  // Mug
  b.cylinder("ceramic", v3(-0.5, h + 0.05, 0.05), 0.095, 0.08, 0.075, 14);
};

/** Ergonomic task chair: mesh back, padded seat, 5-star base. */
const taskChair: Builder = (b) => {
  const fabric = b.materials.color("#3B3E44", 0.92);
  const mesh = b.materials.color("#2A2C30", 0.8);
  b.box(fabric, v3(0, 0.47, 0.03), v3(0.48, 0.07, 0.46));
  b.box("charcoal", v3(0, 0.425, 0.03), v3(0.36, 0.03, 0.34));
  b.box(mesh, v3(0, 0.84, -0.22), v3(0.44, 0.52, 0.035), { pitch: -0.14 });
  b.box("charcoal", v3(0, 0.84, -0.24), v3(0.47, 0.55, 0.02), { pitch: -0.14 });
  b.box("charcoal", v3(0, 0.6, -0.25), v3(0.06, 0.26, 0.04), { pitch: -0.1 });
  b.cylinder("chrome", v3(0, 0.27, 0), 0.3, 0.045);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    b.box(
      "charcoal",
      v3(Math.sin(a) * 0.15, 0.08, Math.cos(a) * 0.15),
      v3(0.035, 0.03, 0.3),
      { yaw: a },
    );
    b.sphere(
      "rubber",
      v3(Math.sin(a) * 0.29, 0.03, Math.cos(a) * 0.29),
      0.055,
      v3(1, 1, 1),
      8,
    );
  }
  for (const sx of [-1, 1]) {
    b.box("charcoal", v3(sx * 0.26, 0.58, 0.02), v3(0.025, 0.2, 0.025));
    b.box("rubber", v3(sx * 0.26, 0.69, 0.04), v3(0.06, 0.02, 0.24));
  }
};

/** Executive desk: walnut top + modesty panel, charcoal frame. */
const execDesk: Builder = (b) => {
  const w = 1.9;
  const d = 0.85;
  const h = 0.75;
  b.box("wood", v3(0, h - 0.02, 0), v3(w, 0.04, d));
  b.box("wood", v3(0, h * 0.55, d / 2 - 0.06), v3(w - 0.12, h * 0.6, 0.03));
  for (const sx of [-1, 1]) {
    b.box(
      "charcoal",
      v3(sx * (w / 2 - 0.04), (h - 0.04) / 2, 0),
      v3(0.05, h - 0.04, d - 0.04),
    );
  }
  // Return pedestal (drawers) on the right
  b.box("charcoal", v3(w / 2 - 0.3, 0.3, -0.05), v3(0.42, 0.6, 0.6));
  b.box("aluminium", v3(w / 2 - 0.3, 0.45, -0.355), v3(0.2, 0.012, 0.01));
  b.box("aluminium", v3(w / 2 - 0.3, 0.22, -0.355), v3(0.2, 0.012, 0.01));
  // Desk accessories: keyboard, lamp, notebook
  b.box("charcoal", v3(-0.05, h + 0.008, -0.15), v3(0.44, 0.014, 0.14));
  b.cylinder("charcoal", v3(-0.72, h + 0.01, 0.18), 0.02, 0.14, 0.14, 18);
  b.cylinder("charcoal", v3(-0.72, h + 0.2, 0.2), 0.38, 0.015, 0.015, 8, {
    pitch: 0.2,
  });
  b.cylinder("aluminium", v3(-0.66, h + 0.38, 0.12), 0.1, 0.08, 0.13, 16, {
    roll: 0.9,
  });
  b.box(
    b.materials.color("#D97757", 0.8),
    v3(0.45, h + 0.008, -0.1),
    v3(0.16, 0.016, 0.22),
    { yaw: 0.25 },
  );
};

/** Framed abstract print (1.0 × 0.75 m), hung by its centre. */
const artPrint: Builder = (b) => {
  const w = 0.8;
  const h = 1.0;
  b.box("charcoal", v3(0, 0, 0.012), v3(w + 0.04, h + 0.04, 0.024));
  b.box(
    b.materials.color("#F1ECE4", 0.9),
    v3(0, 0, 0),
    v3(w - 0.06, h - 0.06, 0.02),
  );
  b.box(
    b.materials.color("#D97757", 0.85),
    v3(-0.08, 0.12, -0.012),
    v3(0.34, 0.34, 0.004),
  );
  b.box(
    b.materials.color("#2F4858", 0.85),
    v3(0.12, -0.12, -0.012),
    v3(0.3, 0.42, 0.004),
  );
  b.box(
    b.materials.color("#C9B79C", 0.85),
    v3(0.0, -0.3, -0.013),
    v3(0.5, 0.06, 0.004),
  );
};

const loungeTable: Builder = (b) => {
  b.cylinder("oak", v3(0, 0.42, 0), 0.03, 0.6, 0.6, 32);
  b.cylinder("charcoal", v3(0, 0.21, 0), 0.4, 0.04, 0.04, 10);
  b.cylinder("charcoal", v3(0, 0.01, 0), 0.02, 0.4, 0.4, 24);
};

const desk: Builder = (b) => {
  const w = 1.4;
  const d = 0.72;
  const h = 0.74;
  b.box("oak", v3(0, h - 0.015, 0), v3(w, 0.03, d));
  // Charcoal sled legs
  for (const sx of [-1, 1]) {
    const x = sx * (w / 2 - 0.06);
    b.box(
      "charcoal",
      v3(x, (h - 0.03) / 2, -d / 2 + 0.05),
      v3(0.04, h - 0.03, 0.04),
    );
    b.box(
      "charcoal",
      v3(x, (h - 0.03) / 2, d / 2 - 0.05),
      v3(0.04, h - 0.03, 0.04),
    );
    b.box("charcoal", v3(x, h - 0.05, 0), v3(0.04, 0.03, d - 0.1));
    b.box("charcoal", v3(x, 0.012, 0), v3(0.05, 0.024, d - 0.06));
  }
  b.box("charcoal", v3(0, h - 0.06, d / 2 - 0.08), v3(w - 0.16, 0.05, 0.03));
  // Modesty panel (felt)
  b.box("fabric", v3(0, h * 0.62, d / 2 - 0.06), v3(w - 0.2, 0.32, 0.015));
};

const chair: Builder = (b) => {
  // Task chair: seat, backrest, gas lift, 5-star base with casters
  b.box("fabric", v3(0, 0.47, 0.02), v3(0.5, 0.07, 0.48));
  b.box("charcoal", v3(0, 0.425, 0.02), v3(0.42, 0.03, 0.4));
  b.box("fabric", v3(0, 0.82, -0.24), v3(0.46, 0.5, 0.06), { pitch: -0.12 });
  b.box("charcoal", v3(0, 0.6, -0.24), v3(0.06, 0.28, 0.03), { pitch: -0.1 });
  b.cylinder("chrome", v3(0, 0.27, 0), 0.32, 0.05);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    b.box(
      "charcoal",
      v3(Math.sin(a) * 0.15, 0.08, Math.cos(a) * 0.15),
      v3(0.04, 0.035, 0.3),
      { yaw: a },
    );
    b.sphere("rubber", v3(Math.sin(a) * 0.29, 0.03, Math.cos(a) * 0.29), 0.06);
  }
  // Armrests
  for (const sx of [-1, 1]) {
    b.box("charcoal", v3(sx * 0.27, 0.58, 0.02), v3(0.03, 0.2, 0.03));
    b.box("rubber", v3(sx * 0.27, 0.68, 0.03), v3(0.06, 0.025, 0.24));
  }
};

const sofa: Builder = (b) => {
  const w = 2.0;
  const d = 0.88;
  b.box("fabricWarm", v3(0, 0.25, 0), v3(w, 0.22, d));
  for (const sx of [-1, 1]) {
    b.box("fabricWarm", v3(sx * 0.45, 0.42, 0.06), v3(0.88, 0.14, d - 0.2));
    b.box("fabricWarm", v3(sx * (w / 2 - 0.1), 0.4, 0), v3(0.2, 0.52, d));
  }
  b.box("fabricWarm", v3(0, 0.62, -d / 2 + 0.12), v3(w - 0.4, 0.5, 0.22), {
    pitch: -0.12,
  });
  // Accent cushions
  b.box("fabricAccent", v3(-0.62, 0.62, -d / 2 + 0.3), v3(0.4, 0.36, 0.12), {
    pitch: -0.3,
    yaw: 0.15,
  });
  b.box("fabric", v3(0.62, 0.62, -d / 2 + 0.3), v3(0.4, 0.36, 0.12), {
    pitch: -0.3,
    yaw: -0.12,
  });
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      b.cylinder(
        "oakDark",
        v3(sx * (w / 2 - 0.1), 0.07, sz * (d / 2 - 0.1)),
        0.14,
        0.04,
        0.03,
      );
};

const shelves: Builder = (b) => {
  const w = 1.0;
  const h = 1.85;
  const d = 0.36;
  for (const sx of [-1, 1])
    b.box("charcoal", v3(sx * (w / 2 - 0.015), h / 2, 0), v3(0.03, h, d));
  const levels = [0.04, 0.45, 0.86, 1.27, 1.68];
  const bookColors = [
    "#C9B79C",
    "#2F4858",
    "#D97757",
    "#E8E2D6",
    "#5C6B73",
    "#8C6646",
    "#3A3D42",
  ];
  levels.forEach((y, li) => {
    b.box("oak", v3(0, y, 0), v3(w - 0.03, 0.025, d));
    if (li === levels.length - 1) return;
    let x = -w / 2 + 0.06;
    let k = li * 3;
    while (x < w / 2 - 0.12) {
      const bw = 0.03 + ((k * 7) % 5) * 0.008;
      const bh = 0.2 + ((k * 13) % 7) * 0.02;
      if ((k * 5) % 11 === 3) {
        x += 0.12; // gap
      } else {
        const col = bookColors[k % bookColors.length];
        b.box(
          b.materials.color(col, 0.8),
          v3(x + bw / 2, y + 0.0125 + bh / 2, 0.02),
          v3(bw, bh, d * 0.7),
        );
        x += bw + 0.004;
      }
      k += 1;
    }
  });
  // Small plant + box on top shelf
  b.cylinder("ceramic", v3(0.28, 1.78, 0), 0.14, 0.14, 0.1);
  b.sphere("plantLeaf", v3(0.28, 1.9, 0), 0.22, v3(1, 0.8, 1));
};

function plantBuilder(
  potH: number,
  potD: number,
  foliage: number,
  height: number,
  tall = false,
): Builder {
  return (b) => {
    b.cylinder("ceramic", v3(0, potH / 2, 0), potH, potD, potD * 0.82, 24);
    b.cylinder(
      "soil",
      v3(0, potH - 0.01, 0),
      0.02,
      potD * 0.92,
      potD * 0.92,
      20,
    );
    if (tall) {
      b.cylinder(
        "oakDark",
        v3(0, potH + (height - potH) * 0.35, 0),
        (height - potH) * 0.7,
        0.03,
        0.04,
        8,
      );
    }
    const n = 9;
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
        8,
      );
    }
  };
}

const coffeeCart: Builder = (b) => {
  const w = 1.1;
  const d = 0.55;
  b.box("oak", v3(0, 0.9, 0), v3(w, 0.04, d));
  b.box("wall", v3(0, 0.45, 0.02), v3(w - 0.04, 0.86, d - 0.06));
  b.box("charcoal", v3(0, 0.03, 0.02), v3(w - 0.06, 0.06, d - 0.08));
  for (const sx of [-0.5, 0, 0.5])
    b.box("charcoal", v3(sx * 0.5, 0.6, -d / 2 + 0.02), v3(0.01, 0.4, 0.01));
  // Espresso machine
  b.box("chrome", v3(-0.22, 1.12, 0.05), v3(0.36, 0.4, 0.34));
  b.box("charcoal", v3(-0.22, 1.0, -0.13), v3(0.22, 0.06, 0.04));
  // Cups + kettle
  for (let i = 0; i < 4; i++)
    b.cylinder(
      "ceramic",
      v3(0.12 + i * 0.09, 0.96, -0.1),
      0.08,
      0.07,
      0.06,
      12,
    );
  b.cylinder("charcoal", v3(0.38, 1.03, 0.1), 0.22, 0.12, 0.15, 16);
};

const laptop: Builder = (b) => {
  b.box("aluminium", v3(0, 0.008, 0), v3(0.32, 0.016, 0.22));
  b.box("charcoal", v3(0, 0.017, -0.02), v3(0.27, 0.002, 0.1));
  b.box("aluminium", v3(0, 0.115, 0.115), v3(0.32, 0.21, 0.008), {
    pitch: -0.2,
  });
  b.box("screenOff", v3(0, 0.115, 0.11), v3(0.29, 0.18, 0.002), {
    pitch: -0.2,
  });
};

const securityCamera: Builder = (b) => {
  b.box("wall", v3(0, 0.05, 0), v3(0.08, 0.1, 0.08));
  b.cylinder("wall", v3(0, -0.02, 0.1), 0.24, 0.09, 0.08, 16, {
    pitch: Math.PI / 2 - 0.3,
  });
  b.cylinder("screenOff", v3(0, -0.05, 0.22), 0.01, 0.06, 0.06, 16, {
    pitch: Math.PI / 2 - 0.3,
  });
};

const projectorScreen: Builder = (b) => {
  b.box("ceramic", v3(0, 1.4, 0), v3(2, 1.3, 0.02));
  b.box("charcoal", v3(0, 2.1, 0), v3(2.1, 0.1, 0.1));
};

const notepads: Builder = (b) => {
  b.box("ceramic", v3(0, 0.006, 0), v3(0.15, 0.012, 0.21));
  b.box("fabricAccent", v3(0.18, 0.008, 0.02), v3(0.15, 0.016, 0.21), {
    yaw: 0.2,
  });
};

const fireAlarm: Builder = (b) => {
  b.box(
    b.materials.color("#C0392B", 0.4),
    v3(0, 0, 0.02),
    v3(0.12, 0.12, 0.04),
  );
};

const wetFloorSign: Builder = (b) => {
  const y = b.materials.color("#F2C230", 0.45);
  b.box(y, v3(0, 0.32, -0.12), v3(0.3, 0.64, 0.02), { pitch: 0.2 });
  b.box(y, v3(0, 0.32, 0.12), v3(0.3, 0.64, 0.02), { pitch: -0.2 });
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
};

/** Build the procedural parts for a role (merged per material, model space). */
export function buildProceduralProp(
  scene: Scene,
  materials: Materials,
  role: PropRole,
): Mesh[] {
  const b = new MeshBatcher(scene, materials, `proc:${role}`);
  BUILDERS[role](b);
  return b.build({ receiveShadows: true });
}
