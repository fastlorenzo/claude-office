"""
Bake a lightmap for one Claude Office building module with Blender Cycles.

Status: tooling scaffold (export -> bake -> uv2 + PNG). The runtime does not
consume the output yet; without lightmaps the engine stays fully realtime
(clustered fixture lights + static daylight shadows + probes). See README.md.

Usage (WSL -> Windows Blender with GPU, one Blender at a time):

  flock ~/.local/share/claude-office-shot/.heavy.lock \
    "/mnt/c/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
    --background --python "$(wslpath -w tools/lightmaps/bake.py)" -- \
    --in  "$(wslpath -w frontend/public/assets/lightmaps/room.json)" \
    --out "$(wslpath -w frontend/public/assets/lightmaps)" \
    --size 1024 --samples 256

Input JSON (from `globalThis.__claudeOfficeExportRoom()` in the browser):
  { module, version, parts: [{ name, material, emissive, transparent,
                               positions[], normals[], indices[] }] }
Babylon is left-handed Y-up; Blender is right-handed Z-up: (x, y, z) -> (x, -z, y).

Output:
  <module>_lightmap.png   irradiance (diffuse direct + indirect, no albedo),
                          to be used as PBR lightmapTexture on UV2
  <module>_uv2.json       { parts: { <name>: [u, v, ...] } } per-vertex UV2,
                          in the original vertex order (Babylon boxes do not
                          share vertices between faces, so it is 1:1)
"""

import argparse
import json
import os
import sys

import bpy  # type: ignore
import bmesh  # type: ignore


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--size", type=int, default=1024)
    ap.add_argument("--samples", type=int, default=256)
    ap.add_argument("--margin", type=float, default=0.004)
    return ap.parse_args(argv)


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons.get("cycles")
    if prefs:
        cp = prefs.preferences
        for kind in ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL"):
            try:
                cp.compute_device_type = kind
                cp.get_devices()
                if any(d.type == kind for d in cp.devices):
                    for d in cp.devices:
                        d.use = d.type == kind
                    scene.cycles.device = "GPU"
                    break
            except Exception:  # noqa: BLE001 - try the next backend
                continue
    # Exterior sky as a dim world (windows) — the interior is lit by the panels.
    world = bpy.data.worlds.new("sky")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.75, 0.82, 0.95, 1.0)
    bg.inputs[1].default_value = 0.6
    scene.world = world
    return scene


def make_material(name, emissive, transparent):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    low = name.lower()
    if emissive:
        # Luminaires: warm 3500 K diffusers.
        bsdf.inputs["Emission Color"].default_value = (1.0, 0.86, 0.7, 1.0)
        bsdf.inputs["Emission Strength"].default_value = 18.0
        bsdf.inputs["Base Color"].default_value = (0, 0, 0, 1)
    elif transparent:
        bsdf.inputs["Transmission Weight"].default_value = 1.0
        bsdf.inputs["Roughness"].default_value = 0.05
    else:
        # Neutral bounce albedo per family (the lightmap stores irradiance only).
        grey = 0.7
        if "floorroom" in low or "rug" in low or "blackmetal" in low:
            grey = 0.12
        elif "oak" in low or "felt" in low:
            grey = 0.4
        bsdf.inputs["Base Color"].default_value = (grey, grey, grey, 1)
        bsdf.inputs["Roughness"].default_value = 0.8
    return mat


def build_part(part):
    pos = part["positions"]
    idx = part["indices"]
    n = len(pos) // 3
    verts = [(pos[i * 3], -pos[i * 3 + 2], pos[i * 3 + 1]) for i in range(n)]
    # Babylon winding is clockwise when seen from the front; flip for Blender.
    faces = [(idx[i], idx[i + 2], idx[i + 1]) for i in range(0, len(idx), 3)]
    mesh = bpy.data.meshes.new(part["name"])
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(part["name"], mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.data.materials.append(
        make_material(part["material"], part["emissive"], part["transparent"])
    )
    return obj


def main():
    args = parse_args()
    with open(args.inp, "r", encoding="utf-8") as f:
        data = json.load(f)
    reset_scene()
    module = data.get("module", "module")
    objs = [build_part(p) for p in data["parts"]]
    bakeable = [
        o
        for o, p in zip(objs, data["parts"])
        if not p["emissive"] and not p["transparent"]
    ]

    # One shared lightmap atlas: second UV layer, packed across all parts.
    for o in bakeable:
        o.data.uv_layers.new(name="lightmap")
        o.data.uv_layers.active = o.data.uv_layers["lightmap"]
    bpy.ops.object.select_all(action="DESELECT")
    for o in bakeable:
        o.select_set(True)
    bpy.context.view_layer.objects.active = bakeable[0]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.lightmap_pack(PREF_CONTEXT="ALL_FACES", PREF_MARGIN_DIV=0.2)
    bpy.ops.object.mode_set(mode="OBJECT")

    img = bpy.data.images.new(f"{module}_lightmap", args.size, args.size, float_buffer=True)
    for o in bakeable:
        for mat in o.data.materials:
            node = mat.node_tree.nodes.new("ShaderNodeTexImage")
            node.image = img
            mat.node_tree.nodes.active = node

    scene = bpy.context.scene
    scene.cycles.samples = args.samples
    scene.cycles.use_denoising = True
    scene.render.bake.use_pass_direct = True
    scene.render.bake.use_pass_indirect = True
    scene.render.bake.use_pass_color = False
    scene.render.bake.margin = int(args.size * args.margin) + 2
    bpy.ops.object.bake(type="DIFFUSE")

    os.makedirs(args.out, exist_ok=True)
    png = os.path.join(args.out, f"{module}_lightmap.png")
    img.filepath_raw = png
    img.file_format = "PNG"
    img.save()

    # Per-vertex UV2 in the original vertex order (loops -> vertex index).
    uv2 = {}
    for o in bakeable:
        layer = o.data.uv_layers["lightmap"].data
        per_vertex = [0.0] * (len(o.data.vertices) * 2)
        for poly in o.data.polygons:
            for li in poly.loop_indices:
                vi = o.data.loops[li].vertex_index
                u, v = layer[li].uv
                per_vertex[vi * 2] = u
                per_vertex[vi * 2 + 1] = 1.0 - v
        uv2[o.name] = per_vertex
    with open(os.path.join(args.out, f"{module}_uv2.json"), "w", encoding="utf-8") as f:
        json.dump({"module": module, "size": args.size, "parts": uv2}, f)
    print(f"[bake] {module}: {png} ({len(bakeable)} parts)")


if __name__ == "__main__":
    main()
