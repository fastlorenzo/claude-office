/**
 * Pure size / naming helpers for the offline KTX2 (Basis Universal) outputs.
 * No heavy imports so vitest can cover them (tests/ktxTiers.test.ts).
 */

export type Ktx2Tier = "hi" | "lo";
export type Ktx2Map = "albedo" | "normal" | "orm";

/** Edge (px) of every material2 KTX2 map per tier. */
export interface MaterialKtx2Edges {
  albedo: Record<Ktx2Tier, number>;
  normal: Record<Ktx2Tier, number>;
  orm: Record<Ktx2Tier, number>;
}

/** ambientCG source resolution; never upscale beyond it. */
export const MATERIAL_SOURCE_EDGE = 2048;

/**
 * `albedoEdge` is the WebP albedo edge from `textureEdge(asset, "albedo")`.
 *  - albedo: lo = current edge, hi = 2x (capped at the 2K source)
 *  - normal: hi 1024, lo 512 (capped at the source)
 *  - orm: half of albedo per tier, at least 256
 */
export function materialKtx2Edges(albedoEdge: number): MaterialKtx2Edges {
  const lo = Math.min(albedoEdge, MATERIAL_SOURCE_EDGE);
  const hi = Math.min(albedoEdge * 2, MATERIAL_SOURCE_EDGE);
  return {
    albedo: { hi, lo },
    normal: { hi: 1024, lo: 512 },
    orm: { hi: Math.max(256, hi / 2), lo: Math.max(256, lo / 2) },
  };
}

export function materialKtx2File(map: Ktx2Map, tier: Ktx2Tier): string {
  return `${map}.${tier}.ktx2`;
}

/** Relative filenames recorded in materials2/manifest.json `ktx2[id]`. */
export function materialKtx2Entry(): Record<Ktx2Map, Record<Ktx2Tier, string>> {
  const one = (m: Ktx2Map) => ({
    hi: materialKtx2File(m, "hi"),
    lo: materialKtx2File(m, "lo"),
  });
  return { albedo: one("albedo"), normal: one("normal"), orm: one("orm") };
}

/** `foo.glb` -> `foo.ktx2.glb`; `foo.gltf` -> `foo.ktx2.glb`. */
export function ktx2GlbName(file: string): string {
  return file.replace(/\.(glb|gltf)$/i, "") + ".ktx2.glb";
}

export type TextureRole = "color" | "normal" | "data";

/** Codec choice per glTF texture role (see WS-F1): colour ETC1S, data UASTC. */
export function codecFor(
  role: TextureRole,
  hasAlpha: boolean,
): { mode: "etc1s" | "uastc"; srgb: boolean } {
  if (role === "color")
    // ETC1S alpha is poor for alpha-tested cards (hair); use UASTC there.
    return { mode: hasAlpha ? "uastc" : "etc1s", srgb: true };
  return { mode: "uastc", srgb: false };
}

/** Largest pow2-agnostic size fitting `maxEdge`, preserving aspect. */
export function fitEdge(
  w: number,
  h: number,
  maxEdge: number,
): { width: number; height: number } {
  const s = Math.min(1, maxEdge / Math.max(w, h));
  return {
    width: Math.max(1, Math.round(w * s)),
    height: Math.max(1, Math.round(h * s)),
  };
}

/** Files the Babylon KhronosTextureContainer2 needs, with sha256 (Babylon 9.31.3). */
export const BASIS_TRANSCODER_VERSION = "9.31.3";
export const BASIS_TRANSCODER_FILES: ReadonlyArray<{
  file: string;
  cdnPath: string;
  sha256: string;
  urlConfigKey: string;
}> = [
  {
    file: "babylon.ktx2Decoder.js",
    cdnPath: "babylon.ktx2Decoder.js",
    sha256: "68a133785d2a7eaf548925cd349b2b904ea5cdb9f6e51e245e320ca700fc80e7",
    urlConfigKey: "jsDecoderModule",
  },
  {
    file: "msc_basis_transcoder.js",
    cdnPath: "ktx2Transcoders/1/msc_basis_transcoder.js",
    sha256: "b8906bae7e55606aba070642eb3bce790a2b5aea774874e120e9fd41f7c7d60b",
    urlConfigKey: "jsMSCTranscoder",
  },
  {
    file: "msc_basis_transcoder.wasm",
    cdnPath: "ktx2Transcoders/1/msc_basis_transcoder.wasm",
    sha256: "29becbf0eef2ce9f6d72109ad217704ec3799c432da0c26e3893b793ecab6bdc",
    urlConfigKey: "wasmMSCTranscoder",
  },
  {
    file: "uastc_astc.wasm",
    cdnPath: "ktx2Transcoders/1/uastc_astc.wasm",
    sha256: "6846c972b4a52d938866f43896fd2b2450052da807cdd1285e898be80614d612",
    urlConfigKey: "wasmUASTCToASTC",
  },
  {
    file: "uastc_bc7.wasm",
    cdnPath: "ktx2Transcoders/1/uastc_bc7.wasm",
    sha256: "be442ab8c0cbf734ded98e6ad38112aaba23c83bfeecac4213ded54631fc4eef",
    urlConfigKey: "wasmUASTCToBC7",
  },
  {
    file: "uastc_r8_unorm.wasm",
    cdnPath: "ktx2Transcoders/1/uastc_r8_unorm.wasm",
    sha256: "0467c98b150a630e5a51f7810843e8b7fd9aad22e3888baf70aad255c55d02bc",
    urlConfigKey: "wasmUASTCToR8_UNORM",
  },
  {
    file: "uastc_rg8_unorm.wasm",
    cdnPath: "ktx2Transcoders/1/uastc_rg8_unorm.wasm",
    sha256: "fb45a2c103c59cec21c3708a6534d43cd4381669f66d3292dd8a6e4e1956d773",
    urlConfigKey: "wasmUASTCToRG8_UNORM",
  },
  {
    file: "uastc_rgba8_srgb_v2.wasm",
    cdnPath: "ktx2Transcoders/1/uastc_rgba8_srgb_v2.wasm",
    sha256: "1f4d2e8bfef4e31679b23d473e1c410c29f7e485a739e76c5b357628f4190874",
    urlConfigKey: "wasmUASTCToRGBA_SRGB",
  },
  {
    file: "uastc_rgba8_unorm_v2.wasm",
    cdnPath: "ktx2Transcoders/1/uastc_rgba8_unorm_v2.wasm",
    sha256: "b7470b26a847994cdeb9226eeba1e3711688e378ee438b7dd941e83cb598b694",
    urlConfigKey: "wasmUASTCToRGBA_UNORM",
  },
  {
    file: "zstddec.wasm",
    cdnPath: "zstddec.wasm",
    sha256: "67d12d34f82ef700ec3a3795a77590252858c70330908a87ed1e73efc268cb4b",
    urlConfigKey: "wasmZSTDDecoder",
  },
];
