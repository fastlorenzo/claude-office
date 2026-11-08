/**
 * Parked-car body variants (pure): real-world proportions of modern European
 * cars and the deterministic pick per car-park spot. The geometry is built
 * from these numbers in world/exterior/cars.ts; colliders and the plan's
 * keep-out rects read the same footprints.
 *
 * Local frame of a car: origin on the ground under the body centre, +z toward
 * the nose, +x across. Exterior places it rotated by −yaw (Babylon terms).
 */
import type { CarSpot } from "./exteriorPlan";

export type CarKind = "hatch" | "saloon" | "suv" | "estate" | "van";

export interface CarModel {
  kind: CarKind;
  /** Overall body length / width (without mirrors) / height (m). */
  length: number;
  width: number;
  height: number;
  /** Axle to axle. */
  wheelbase: number;
  /** Wheel centre to wheel centre across an axle. */
  track: number;
  /** Nose to front axle. */
  front: number;
  /** Tyre outer radius and section width. */
  tyreR: number;
  tyreW: number;
}

/**
 * Golf/Clio-class hatch, 3-series-class saloon, Tiguan-class SUV,
 * Octavia-Combi-class estate, Transporter-class van (tyres: 205/55 R16,
 * 225/45 R18, 235/55 R19, 225/50 R17, 215/65 R16).
 */
export const CAR_MODELS: Readonly<Record<CarKind, CarModel>> = {
  hatch: {
    kind: "hatch",
    length: 4.1,
    width: 1.8,
    height: 1.48,
    wheelbase: 2.6,
    track: 1.54,
    front: 0.8,
    tyreR: 0.316,
    tyreW: 0.205,
  },
  saloon: {
    kind: "saloon",
    length: 4.7,
    width: 1.85,
    height: 1.45,
    wheelbase: 2.85,
    track: 1.58,
    front: 0.84,
    tyreR: 0.33,
    tyreW: 0.225,
  },
  suv: {
    kind: "suv",
    length: 4.6,
    width: 1.9,
    height: 1.7,
    wheelbase: 2.75,
    track: 1.62,
    front: 0.92,
    tyreR: 0.37,
    tyreW: 0.235,
  },
  estate: {
    kind: "estate",
    length: 4.68,
    width: 1.83,
    height: 1.48,
    wheelbase: 2.69,
    track: 1.56,
    front: 0.93,
    tyreR: 0.328,
    tyreW: 0.225,
  },
  van: {
    kind: "van",
    length: 4.9,
    width: 1.9,
    height: 1.97,
    wheelbase: 3.0,
    track: 1.62,
    front: 0.93,
    tyreR: 0.343,
    tyreW: 0.215,
  },
};

/** Deterministic body pick per spot (vans stay vans); no rng draw. */
export function carKind(c: CarSpot): CarKind {
  if (c.van) return "van";
  let h =
    Math.imul(Math.round(c.x * 10), 73856093) ^
    Math.imul(Math.round(c.z * 10), 19349663) ^
    Math.imul(c.color + 1, 83492791);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  h ^= h >>> 15;
  const u = (h >>> 0) / 4294967296;
  return u < 0.34 ? "hatch" : u < 0.58 ? "saloon" : u < 0.84 ? "suv" : "estate";
}

export function carModel(c: CarSpot): CarModel {
  return CAR_MODELS[carKind(c)];
}

/** Wheel centres in the car's local frame (y = tyre radius: on the ground). */
export function carWheels(m: CarModel): [number, number, number][] {
  const zf = m.length / 2 - m.front;
  const zr = zf - m.wheelbase;
  const out: [number, number, number][] = [];
  for (const z of [zf, zr])
    for (const sx of [-1, 1]) out.push([(sx * m.track) / 2, m.tyreR, z]);
  return out;
}
