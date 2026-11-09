"""
Bake one Claude Office lightmap set with Blender Cycles (tools/lightmaps).

Input: frontend/public/lightmaps/src/<set>.json written by
`frontend/scripts/export-bake.ts` (engine/bake/exportParts.ts):

  { set, frame, size, origin, sun, world, meshes{name: {...}},
    targets[{name, hash, vertexCount, matrix}],      # baked (hero copies)
    instances[{name, matrices[[16]]}],               # context (not baked)
    lights[{type, kind, pos, dir, color, intensity, range, size}], bounds }

Output (merged into <out>/manifest.json, see README.md "Lightmap contract"):
  <set>.png       RGBD 8-bit (Babylon toRGBD, gamma 2.2), irradiance only
  <set>_uv2.bin   float32 LE (u, v) per vertex, per part in manifest order

Units: Babylon PBR is radiometric (Lambert 1/pi; point/spot intensity =
radiant intensity W/sr; directional intensity = irradiance W/m2; IBL
irradiance normalised so a uniform sky of radiance L gives L). Cycles matches
with: point power = 4*pi*I, sun strength = I, world strength = Babylon
environmentIntensity. A DIFFUSE bake (direct + indirect, no colour) then gives
exactly the factor the runtime multiplies by the albedo (verified on a test
plane: 0.4368 vs 0.4377 analytic for I = 5.5 at 2 m).

Spot falloff reproduces Babylon's physical spot (angle pi):
2^(6.6439 * (cos(theta) - 1)) via a light node (Geometry > Normal is the
emission direction in Cycles light shaders).

Usage (WSL -> Windows Blender with GPU; one Blender at a time):

  flock ~/.local/share/claude-office-shot/.heavy.lock \
    "/mnt/c/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
    --background --factory-startup --python "$(wslpath -w tools/lightmaps/bake.py)" -- \
    --in "$(wslpath -w frontend/public/lightmaps/src/modules.json)" \
    --out "$(wslpath -w frontend/public/lightmaps)" \
    --public "$(wslpath -w frontend/public)" --samples 512

(`make bake-lightmaps` runs the export and all four sets.)
"""

import argparse
import datetime
import json
import math
import os
import struct
import sys
import time
import zlib

import bpy  # type: ignore
import numpy as np  # bundled with Blender
from mathutils import Matrix, Vector  # type: ignore

# Babylon (left-handed, Y up) -> Blender (right-handed, Z up): the same
# physical point is (x, z, y). P is its own inverse.
P3 = np.array([[1.0, 0, 0], [0, 0, 1.0], [0, 1.0, 0]])
P4 = np.eye(4)
P4[:3, :3] = P3

SPOT_KAPPA = 6.64385618977  # -log2(0.01), Babylon physical spot falloff
RGBD_MAX = 255.0
GAMMA = 2.2
MAX_IRRADIANCE = 64.0
PACK_SHAPE = os.environ.get("LIGHTMAP_PACK_SHAPE", "AABB")


def log(*a):
    print("[bake]", *a, flush=True)


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True, help="<set>.json")
    ap.add_argument("--out", required=True, help="frontend/public/lightmaps")
    ap.add_argument("--public", required=True, help="frontend/public (HDRIs)")
    ap.add_argument("--size", type=int, default=0, help="atlas edge (0 = set)")
    ap.add_argument("--samples", type=int, default=512)
    ap.add_argument("--margin", type=float, default=6.0, help="island gap, px")
    ap.add_argument("--dilate", type=int, default=8, help="edge dilation, px")
    ap.add_argument("--no-denoise", action="store_true")
    ap.add_argument("--cpu", action="store_true")
    ap.add_argument("--preview", default="", help="tonemapped PNG for review")
    ap.add_argument("--uv-report", action="store_true", help="log UV2 per part, stop")
    return ap.parse_args(argv)


# ---------------------------------------------------------------------------
# Scene
# ---------------------------------------------------------------------------


def setup_scene(samples, cpu):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    device = "CPU"
    if not cpu:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        for kind in ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL"):
            try:
                prefs.compute_device_type = kind
                prefs.get_devices()
                if any(d.type == kind for d in prefs.devices):
                    for d in prefs.devices:
                        d.use = d.type == kind
                    sc.cycles.device = "GPU"
                    device = kind
                    break
            except Exception:  # noqa: BLE001 - try the next backend
                continue
    c = sc.cycles
    c.samples = samples
    c.use_adaptive_sampling = False
    c.max_bounces = 8
    c.diffuse_bounces = 4
    c.glossy_bounces = 0
    c.transmission_bounces = 4
    c.transparent_max_bounces = 16
    c.volume_bounces = 0
    c.caustics_reflective = False
    c.caustics_refractive = False
    c.sample_clamp_indirect = 10.0
    sc.view_settings.view_transform = "Standard"
    log("device", device, "blender", bpy.app.version_string)
    return sc, device


def setup_world(sc, world, public):
    w = bpy.data.worlds.new("world")
    w.use_nodes = True
    nt = w.node_tree
    bg = nt.nodes["Background"]
    bg.inputs["Strength"].default_value = float(world["strength"])
    path = os.path.join(public, *world["hdri"].split("/"))
    if os.path.exists(path):
        env = nt.nodes.new("ShaderNodeTexEnvironment")
        env.image = bpy.data.images.load(path)
        tc = nt.nodes.new("ShaderNodeTexCoord")
        mp = nt.nodes.new("ShaderNodeMapping")
        # Babylon's equirect lookup is u = atan2(z, x): mirror x to match
        # Blender's atan2(y, -x); then Babylon's rotationY about up.
        mp.inputs["Scale"].default_value = (-1.0, 1.0, 1.0)
        mp.inputs["Rotation"].default_value = (0.0, 0.0, -float(world["rotationY"]))
        nt.links.new(tc.outputs["Generated"], mp.inputs["Vector"])
        nt.links.new(mp.outputs["Vector"], env.inputs["Vector"])
        mn = nt.nodes.new("ShaderNodeVectorMath")
        mn.operation = "MINIMUM"
        cl = float(world.get("clamp", 1e9))
        mn.inputs[1].default_value = (cl, cl, cl)
        nt.links.new(env.outputs["Color"], mn.inputs[0])
        nt.links.new(mn.outputs["Vector"], bg.inputs["Color"])
    else:
        log("WARNING: HDRI missing, grey world:", path)
        bg.inputs["Color"].default_value = (0.5, 0.5, 0.5, 1.0)
    sc.world = w


_materials = {}


def material_for(name, m):
    key = name
    if key in _materials:
        return _materials[key]
    mat = bpy.data.materials.new(name or "unnamed")
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = m.get("emissive")
    if m.get("transparent"):
        # Glass: light passes (thin panes barely tint daylight).
        sh = nt.nodes.new("ShaderNodeBsdfTransparent")
        t = max(0.0, 1.0 - 0.25 * float(m.get("alpha", 0.3)))
        sh.inputs["Color"].default_value = (t, t, t, 1.0)
    elif em is not None:
        sh = nt.nodes.new("ShaderNodeEmission")
        sh.inputs["Color"].default_value = (em[0], em[1], em[2], 1.0)
        sh.inputs["Strength"].default_value = 1.0
    else:
        sh = nt.nodes.new("ShaderNodeBsdfDiffuse")
        a = np.clip(np.array(m.get("albedo", [0.5, 0.5, 0.5]), dtype=float), 0.02, 0.85)
        if float(m.get("metallic", 0)) > 0.5:
            a = a * 0.5  # metals: specular bounce, roughly half as diffuse
        sh.inputs["Color"].default_value = (a[0], a[1], a[2], 1.0)
    nt.links.new(sh.outputs[0], out.inputs["Surface"])
    _materials[key] = mat
    return mat


def build_mesh(name, m):
    pos = np.asarray(m["positions"], dtype=np.float64).reshape(-1, 3) @ P3.T
    nor = np.asarray(m["normals"], dtype=np.float64).reshape(-1, 3)
    if len(nor) != len(pos):
        nor = np.zeros_like(pos)
    nor = nor @ P3.T
    tri = np.asarray(m["indices"], dtype=np.int64).reshape(-1, 3)
    ok = (tri[:, 0] != tri[:, 1]) & (tri[:, 1] != tri[:, 2]) & (tri[:, 0] != tri[:, 2])
    tri = tri[ok]
    # Winding: face normal must agree with the exported vertex normals.
    if len(tri):
        a, b, c = pos[tri[:, 0]], pos[tri[:, 1]], pos[tri[:, 2]]
        fn = np.cross(b - a, c - a)
        vn = nor[tri[:, 0]] + nor[tri[:, 1]] + nor[tri[:, 2]]
        flip = np.einsum("ij,ij->i", fn, vn) < 0
        tri[flip] = tri[flip][:, [0, 2, 1]]
    me = bpy.data.meshes.new(name)
    me.from_pydata(pos.tolist(), [], tri.tolist())
    me.update()
    if len(me.polygons):
        me.polygons.foreach_set("use_smooth", np.ones(len(me.polygons), dtype=bool))
        try:
            n = nor / np.maximum(np.linalg.norm(nor, axis=1, keepdims=True), 1e-9)
            me.normals_split_custom_set_from_vertices(n.tolist())
        except Exception as e:  # noqa: BLE001 - shading normals are optional
            log("custom normals skipped for", name, e)
    me.materials.append(material_for(m.get("material", ""), m))
    return me


def to_blender_matrix(m16):
    a = np.asarray(m16, dtype=np.float64).reshape(4, 4).T  # column-vector form
    return Matrix((P4 @ a @ P4).tolist())


def add_object(name, me, m16):
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.matrix_world = to_blender_matrix(m16)
    return ob


def add_light(i, L):
    pos = P3 @ np.asarray(L["pos"], dtype=float)
    col = L["color"]
    ld = bpy.data.lights.new(f"L{i}_{L['kind']}", "POINT")
    ld.color = (col[0], col[1], col[2])
    ld.energy = 4.0 * math.pi * float(L["intensity"])
    size = L.get("size")
    if L["kind"] == "window":
        ld.shadow_soft_size = 0.3
    elif size:
        ld.shadow_soft_size = min(0.25, max(size["w"], size["d"]) / 4.0)
    else:
        ld.shadow_soft_size = 0.06
    try:
        ld.use_soft_falloff = False
    except AttributeError:
        pass
    if L.get("dir"):
        axis = P3 @ np.asarray(L["dir"], dtype=float)
        axis = axis / max(np.linalg.norm(axis), 1e-9)
        ld.use_nodes = True
        nt = ld.node_tree
        em = nt.nodes["Emission"]
        geo = nt.nodes.new("ShaderNodeNewGeometry")
        dot = nt.nodes.new("ShaderNodeVectorMath")
        dot.operation = "DOT_PRODUCT"
        dot.inputs[1].default_value = tuple(axis)
        nt.links.new(geo.outputs["Normal"], dot.inputs[0])
        ma = nt.nodes.new("ShaderNodeMath")
        ma.operation = "MULTIPLY_ADD"
        ma.inputs[1].default_value = SPOT_KAPPA
        ma.inputs[2].default_value = -SPOT_KAPPA
        nt.links.new(dot.outputs["Value"], ma.inputs[0])
        pw = nt.nodes.new("ShaderNodeMath")
        pw.operation = "POWER"
        pw.inputs[0].default_value = 2.0
        nt.links.new(ma.outputs[0], pw.inputs[1])
        nt.links.new(pw.outputs[0], em.inputs["Strength"])
    ob = bpy.data.objects.new(ld.name, ld)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = tuple(pos)


def add_sun(sun):
    d = Vector(tuple(P3 @ np.asarray(sun["dir"], dtype=float))).normalized()
    ld = bpy.data.lights.new("sun", "SUN")
    ld.energy = float(sun["intensity"])
    c = sun["color"]
    ld.color = (c[0], c[1], c[2])
    ld.angle = math.radians(1.2)
    ob = bpy.data.objects.new("sun", ld)
    bpy.context.scene.collection.objects.link(ob)
    ob.rotation_mode = "QUATERNION"
    ob.rotation_quaternion = d.to_track_quat("-Z", "Y")


# ---------------------------------------------------------------------------
# UV2
# ---------------------------------------------------------------------------


def _components(tri, nv):
    """Connected components of a triangle list (shared vertex indices)."""
    lab = np.arange(nv, dtype=np.int64)
    if not len(tri):
        return lab
    while True:
        m = lab[tri].min(axis=1)
        new = lab.copy()
        for k in range(3):
            np.minimum.at(new, tri[:, k], m)
        new = new[new]
        while True:
            nn = new[new]
            if np.array_equal(nn, new):
                break
            new = nn
        if np.array_equal(new, lab):
            return lab
        lab = new


def fix_uvs(ob):
    """Per connected component: planar projection where the component is a
    height field over its mean normal (box faces, rounded-box faces, flat
    slabs: exact, no distortion); Blender's conformal unwrap elsewhere
    (cylinder sides, spheres), unless it came out degenerate or split a
    vertex — then the projection anyway (folds, but stays per-vertex)."""
    me = ob.data
    nv = len(me.vertices)
    nl = len(me.loops)
    if not nl:
        return 0, 0
    co = np.empty(nv * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    vi = np.empty(nl, dtype=np.int64)
    me.loops.foreach_get("vertex_index", vi)
    tri = vi.reshape(-1, 3)  # every polygon is a triangle (from_pydata)
    uvl = np.empty(nl * 2)
    me.uv_layers["lightmap"].data.foreach_get("uv", uvl)
    uvl = uvl.reshape(-1, 2)
    lab = _components(tri, nv)
    _, comp_of_v = np.unique(lab, return_inverse=True)
    nc = int(comp_of_v.max()) + 1
    fc = comp_of_v[tri[:, 0]]
    fn = np.cross(co[tri[:, 1]] - co[tri[:, 0]], co[tri[:, 2]] - co[tri[:, 0]])
    area = np.linalg.norm(fn, axis=1) / 2
    avg = np.zeros((nc, 3))
    np.add.at(avg, fc, fn)
    avg /= np.maximum(np.linalg.norm(avg, axis=1, keepdims=True), 1e-12)
    unit = fn / np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-12)
    facing = np.einsum("ij,ij->i", unit, avg[fc])
    bad_face = (facing < 0.05) & (area > 1e-10)
    projectable = np.bincount(fc, weights=bad_face.astype(float), minlength=nc) == 0
    # Projection basis per component.
    n = avg
    helper = np.where(np.abs(n[:, 1:2]) < 0.9, [[0.0, 1.0, 0.0]], [[1.0, 0.0, 0.0]])
    t = np.cross(helper, n)
    t /= np.maximum(np.linalg.norm(t, axis=1, keepdims=True), 1e-12)
    b = np.cross(n, t)
    proj = np.stack(
        [np.einsum("ij,ij->i", co, t[comp_of_v]), np.einsum("ij,ij->i", co, b[comp_of_v])],
        axis=1,
    )
    # Blender's result: per-vertex consistency + sane area ratio.
    per_v = np.zeros((nv, 2))
    per_v[vi] = uvl
    split = np.abs(per_v[vi] - uvl).max(axis=1) > 1e-6
    comp_split = np.bincount(fc.repeat(3), weights=split.astype(float), minlength=nc) > 0
    ut = uvl.reshape(-1, 3, 2)
    uarea = np.abs(
        (ut[:, 1, 0] - ut[:, 0, 0]) * (ut[:, 2, 1] - ut[:, 0, 1])
        - (ut[:, 2, 0] - ut[:, 0, 0]) * (ut[:, 1, 1] - ut[:, 0, 1])
    ) / 2
    ca = np.bincount(fc, weights=area, minlength=nc)
    cu = np.bincount(fc, weights=uarea, minlength=nc)
    ratio = cu / np.maximum(ca, 1e-12)
    ok = (ca > 1e-9) & (cu > 0) & np.isfinite(ratio)
    med = np.median(ratio[ok]) if ok.any() else 1.0
    sane = ok & (ratio < med * 8) & (ratio > med / 8) & np.isfinite(per_v).all(axis=1)[
        np.unique(comp_of_v, return_index=True)[1]
    ]
    use_proj = projectable | comp_split | ~sane
    final = np.where(use_proj[comp_of_v][:, None], proj * med, per_v)
    me.uv_layers["lightmap"].data.foreach_set("uv", final[vi].astype(np.float32).ravel())
    return int(use_proj.sum()), nc


def unwrap(targets, size, margin_px):
    """Seamless islands (one per connected component: no vertex gets two
    UVs, so the UV2 stays per original vertex), equal texel density, packed."""
    for ob in targets:
        uv = ob.data.uv_layers.new(name="lightmap")
        ob.data.uv_layers.active = uv
    bpy.ops.object.select_all(action="DESELECT")
    for ob in targets:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = targets[0]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.mark_seam(clear=True)
    bpy.ops.uv.select_all(action="SELECT")
    bpy.ops.uv.unwrap(method="CONFORMAL", fill_holes=False, correct_aspect=False, margin=0.0)
    bpy.ops.object.mode_set(mode="OBJECT")
    projected = 0
    comps = 0
    for ob in targets:
        p, c = fix_uvs(ob)
        projected += p
        comps += c
    log(f"islands: {comps} ({projected} planar-projected)")
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.select_all(action="SELECT")
    bpy.ops.uv.average_islands_scale()
    kw = dict(rotate=True, margin=margin_px / size)
    try:
        bpy.ops.uv.pack_islands(
            shape_method=PACK_SHAPE,
            rotate_method="AXIS_ALIGNED",
            margin_method="FRACTION",
            **kw,
        )
    except TypeError:
        bpy.ops.uv.pack_islands(**kw)
    bpy.ops.object.mode_set(mode="OBJECT")


def texel_cm(ob, size):
    """World size of one lightmap texel on this part (cm)."""
    me = ob.data
    mw = ob.matrix_world
    uvl = me.uv_layers["lightmap"].data
    wa = 0.0
    ua = 0.0
    for poly in me.polygons:
        wa += poly.area
        li = list(poly.loop_indices)
        if len(li) == 3:
            a, b, c = (uvl[i].uv for i in li)
            ua += abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2
    scale = abs(mw.determinant()) ** (2.0 / 3.0)
    if ua <= 0:
        return float("inf")
    return 100.0 * math.sqrt(wa * scale / (ua * size * size))


def vertex_uvs(ob):
    me = ob.data
    nl = len(me.loops)
    uv = np.empty(nl * 2, dtype=np.float32)
    me.uv_layers["lightmap"].data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)
    vi = np.empty(nl, dtype=np.int64)
    me.loops.foreach_get("vertex_index", vi)
    out = np.zeros((len(me.vertices), 2), dtype=np.float32)
    out[vi] = uv
    # Seamless check: every loop of a vertex carries the same UV.
    err = float(np.abs(out[vi] - uv).max()) if nl else 0.0
    return out, err


# ---------------------------------------------------------------------------
# Bake, denoise, encode
# ---------------------------------------------------------------------------


def bake(targets, img, dilate, clear=True):
    for ob in targets:
        for mat in ob.data.materials:
            nt = mat.node_tree
            node = nt.nodes.get("__lightmap")
            if node is None:
                node = nt.nodes.new("ShaderNodeTexImage")
                node.name = "__lightmap"
            node.image = img
            nt.nodes.active = node
    bpy.ops.object.select_all(action="DESELECT")
    for ob in targets:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = targets[0]
    sc = bpy.context.scene
    b = sc.render.bake
    b.use_pass_direct = True
    b.use_pass_indirect = True
    b.use_pass_color = False
    b.margin = dilate
    try:
        b.margin_type = "EXTEND"
    except Exception:  # noqa: BLE001 - older Blender
        pass
    b.use_clear = clear
    bpy.ops.object.bake(type="DIFFUSE", uv_layer="lightmap", margin=dilate, use_clear=clear)


def dilate(px, n):
    """Grow baked texels (alpha > 0) outwards by n px (mean of 8 neighbours)."""
    px = px.copy()
    filled = px[..., 3] > 0
    px[~filled] = 0.0
    for _ in range(n):
        acc = np.zeros_like(px[..., :3])
        cnt = np.zeros(px.shape[:2])
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                f = np.roll(np.roll(filled, dy, 0), dx, 1)
                c = np.roll(np.roll(px[..., :3], dy, 0), dx, 1)
                acc += c * f[..., None]
                cnt += f
        grow = (~filled) & (cnt > 0)
        if not grow.any():
            break
        px[grow, :3] = acc[grow] / cnt[grow][:, None]
        px[grow, 3] = 1.0
        filled = filled | grow
    return px


def read_pixels(img):
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    return px.reshape(h, w, 4)


def denoise(img, tmpdir):
    """OIDN through the compositor (Denoise node on the baked image)."""
    sc = bpy.context.scene
    w, h = img.size
    # (Never touch the colour space of a generated image after writing it:
    # Blender regenerates the buffer — blank.)
    for ob in sc.objects:
        ob.hide_render = True
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    sc.collection.objects.link(cam)
    sc.camera = cam
    keep = sc.cycles.samples
    sc.cycles.samples = 1
    sc.render.resolution_x = w
    sc.render.resolution_y = h
    sc.render.resolution_percentage = 100
    sc.render.use_compositing = True
    sc.render.image_settings.file_format = "OPEN_EXR"
    sc.render.image_settings.color_depth = "32"
    try:
        sc.render.image_settings.color_management = "FOLLOW_SCENE"
    except Exception:  # noqa: BLE001
        pass
    if bpy.app.version >= (5, 0, 0):
        tree = bpy.data.node_groups.new("denoise", "CompositorNodeTree")
        sc.compositing_node_group = tree
        tree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
        out = tree.nodes.new("NodeGroupOutput")
        out_in = out.inputs[0]
    else:
        sc.use_nodes = True
        tree = sc.node_tree
        for n in list(tree.nodes):
            tree.nodes.remove(n)
        out = tree.nodes.new("CompositorNodeComposite")
        out_in = out.inputs["Image"]
    inode = tree.nodes.new("CompositorNodeImage")
    inode.image = img
    dn = tree.nodes.new("CompositorNodeDenoise")
    for attr, val in (("prefilter", "ACCURATE"), ("use_hdr", True)):
        try:
            setattr(dn, attr, val)
        except Exception:  # noqa: BLE001 - 5.x moved these to inputs
            pass
    for sock, val in (("HDR", True),):
        if sock in dn.inputs:
            dn.inputs[sock].default_value = val
    tree.links.new(inode.outputs["Image"], dn.inputs["Image"])
    tree.links.new(dn.outputs["Image"], out_in)
    path = os.path.join(tmpdir, "denoised.exr")
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    sc.cycles.samples = keep
    res = bpy.data.images.load(path)
    px = read_pixels(res)
    try:
        os.remove(path)
    except OSError:
        pass
    return px


def to_rgbd(lin):
    """Babylon toRGBD (helperFunctions.fx), gamma 2.2: rgb*D in [0,1], a = D."""
    rgb = np.maximum(lin[..., :3], 0.0)
    m = np.maximum(rgb.max(axis=-1), 1e-6)
    d = np.maximum(RGBD_MAX / m, 1.0)
    d = np.clip(np.floor(d) / 255.0, 0.0, 1.0)
    enc = np.clip(rgb * d[..., None], 0.0, 1.0) ** (1.0 / GAMMA)
    out = np.empty(lin.shape[:2] + (4,), dtype=np.uint8)
    out[..., :3] = np.round(enc * 255.0).astype(np.uint8)
    out[..., 3] = np.round(d * 255.0).astype(np.uint8)
    return out


def from_rgbd(px):
    f = px.astype(np.float64) / 255.0
    return (f[..., :3] ** GAMMA) / np.maximum(f[..., 3:4], 1e-6)


def write_png(path, rgba_top_first):
    """Minimal RGBA8 PNG writer (filter Sub on every row), no colour chunks."""
    h, w, _ = rgba_top_first.shape
    flat = rgba_top_first.astype(np.int16).reshape(h, w * 4)
    filt = flat.copy()
    filt[:, 4:] = (flat[:, 4:] - flat[:, :-4]) & 0xFF
    raw = np.empty((h, w * 4 + 1), dtype=np.uint8)
    raw[:, 0] = 1
    raw[:, 1:] = filt.astype(np.uint8)

    def chunk(t, data):
        c = struct.pack(">I", len(data)) + t + data
        return c + struct.pack(">I", zlib.crc32(t + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw.tobytes(), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def write_preview(path, lin):
    """Reinhard-tonemapped sRGB preview (review only, not shipped)."""
    x = np.maximum(lin[..., :3], 0.0)
    x = x / (1.0 + x)
    x = x ** (1 / 2.2)
    rgba = np.empty(x.shape[:2] + (4,), dtype=np.uint8)
    rgba[..., :3] = np.round(x * 255).astype(np.uint8)
    rgba[..., 3] = 255
    write_png(path, rgba[::-1])


# ---------------------------------------------------------------------------


def main():
    args = parse_args()
    t0 = time.time()
    with open(args.inp, "r", encoding="utf-8") as f:
        data = json.load(f)
    setn = data["set"]
    size = args.size or int(data.get("size", 1024))
    sc, device = setup_scene(args.samples, args.cpu)
    setup_world(sc, data["world"], args.public)

    meshes = {}
    for name, m in data["meshes"].items():
        meshes[name] = build_mesh(name, m)
    targets = []
    for t in data["targets"]:
        ob = add_object(f"T:{t['name']}", meshes[t["name"]], t["matrix"])
        targets.append(ob)
    nctx = 0
    for inst in data["instances"]:
        for k, m16 in enumerate(inst["matrices"]):
            add_object(f"C:{inst['name']}#{k}", meshes[inst["name"]], m16)
            nctx += 1
    for i, L in enumerate(data["lights"]):
        add_light(i, L)
    if data.get("sun"):
        add_sun(data["sun"])
    log(f"{setn}: {len(targets)} targets, {nctx} context copies, "
        f"{len(data['lights'])} lights, sun={bool(data.get('sun'))}, "
        f"build {time.time() - t0:.1f}s")

    t1 = time.time()
    unwrap(targets, size, args.margin)
    biggest = max(targets, key=lambda o: sum(p.area for p in o.data.polygons))
    log(f"unwrap {time.time() - t1:.1f}s; texel {texel_cm(biggest, size):.2f} cm on {biggest.name}")
    if args.uv_report:
        for ob in targets:
            uv, err = vertex_uvs(ob)
            log(f"  {ob.name}: texel {texel_cm(ob, size):.2f} cm, seam {err:.4f}, "
                f"uv [{uv.min(0)}..{uv.max(0)}], faces {len(ob.data.polygons)}")
        return

    img = bpy.data.images.new(f"{setn}_lm", size, size, alpha=True, float_buffer=True)
    img.colorspace_settings.name = "Non-Color"
    t2 = time.time()
    passes = data.get("passes") or [{"targets": [""], "hide": []}]
    for k, ps in enumerate(passes):
        sel = [ob for ob, t in zip(targets, data["targets"])
               if any(t["name"].startswith(pfx) for pfx in ps["targets"])]
        hidden = []
        for ob in bpy.context.scene.objects:
            base = ob.name.split(":", 1)[1] if ob.name[:2] in ("T:", "C:") else ""
            if base and any(base.startswith(pfx) for pfx in ps["hide"]):
                ob.hide_render = True
                hidden.append(ob)
        if sel:
            # No Cycles margin: a later pass's margin would overwrite an
            # earlier pass's island edges. Dilation is done once, below.
            bake(sel, img, 0, clear=(k == 0))
        for ob in hidden:
            ob.hide_render = False
        log(f"pass {k + 1}/{len(passes)}: {len(sel)} targets, {len(hidden)} hidden")
    tb = time.time() - t2
    log(f"bake {tb:.1f}s ({args.samples} spp, {size}px, {device})")

    raw = read_pixels(img)
    used = raw[..., 3] > 0  # texels the bake wrote
    raw = dilate(raw, args.dilate)
    img.pixels.foreach_set(raw.astype(np.float32).ravel())
    img.update()
    log(f"raw: max {float(raw[..., :3].max()):.3f}, alpha>0 {float((raw[..., 3] > 0).mean()):.3f}")
    tmpdir = os.path.dirname(os.path.abspath(args.inp))
    if args.no_denoise:
        lin = raw
    else:
        try:
            lin = denoise(img, tmpdir)
        except Exception as e:  # noqa: BLE001 - keep the raw bake
            log("WARNING: denoise failed, raw bake kept:", e)
            lin = raw
    log(f"denoised: max {float(np.nanmax(lin[..., :3])):.3f}")
    bad = ~np.isfinite(lin[..., :3])
    nbad = int(bad.sum())
    lin = np.where(np.isfinite(lin), lin, 0.0)
    # Texels right next to a point light (luminaire housings) go to the
    # hundreds: cap them (RGBD tops out at 255 anyway).
    lin = np.clip(lin, 0.0, MAX_IRRADIANCE)

    os.makedirs(args.out, exist_ok=True)
    rgbd = to_rgbd(lin)
    png_name = f"{setn}.png"
    write_png(os.path.join(args.out, png_name), rgbd[::-1])  # PNG rows top-first
    if args.preview:
        write_preview(args.preview, lin)
    dec = from_rgbd(rgbd)
    rel = np.abs(dec - lin[..., :3]) / np.maximum(lin[..., :3], 1e-3)
    lit = used & (lin[..., :3].max(-1) > 0.01)

    parts = {}
    floats = []
    off = 0
    max_seam = 0.0
    for t, ob in zip(data["targets"], targets):
        uv, err = vertex_uvs(ob)
        max_seam = max(max_seam, err)
        n = len(uv)
        if n != t["vertexCount"]:
            raise RuntimeError(f"{t['name']}: {n} verts != {t['vertexCount']}")
        entry = {"hash": t["hash"], "vertexCount": n, "uv2Offset": off}
        for k in ("topoHash", "bbox"):
            if t.get(k) is not None:
                entry[k] = t[k]
        parts[t["name"]] = entry
        floats.append(uv.reshape(-1))
        off += n * 2
    uv2_name = f"{setn}_uv2.bin"
    allf = np.concatenate(floats).astype("<f4") if floats else np.zeros(0, "<f4")
    with open(os.path.join(args.out, uv2_name), "wb") as f:
        f.write(allf.tobytes())

    stats = {
        "texelsUsed": float(used.mean()),
        "p50": float(np.percentile(lin[..., :3][used].max(axis=-1), 50)) if used.any() else 0,
        "p99": float(np.percentile(lin[..., :3][used].max(axis=-1), 99)) if used.any() else 0,
        "max": float(lin[..., :3].max()),
        "nan": nbad,
        "rgbdRelErrP999": float(np.percentile(rel[lit], 99.9)) if lit.any() else 0,
        "seamUvErr": max_seam,
    }
    man_path = os.path.join(args.out, "manifest.json")
    man = {"version": 1, "sets": {}}
    if os.path.exists(man_path):
        with open(man_path, "r", encoding="utf-8") as f:
            try:
                man = json.load(f)
            except json.JSONDecodeError:
                pass
    man["version"] = 1
    man.setdefault("sets", {})
    man["sets"][setn] = {
        "image": png_name,
        "encoding": "rgbd",
        "rgbdGamma": GAMMA,
        "size": size,
        "gain": 1.0,
        "sun": bool(data.get("sun")),
        "frame": data["frame"],
        "origin": data["origin"],
        "verify": data.get("verify", "position"),
        "uv2": uv2_name,
        "uv2Unit": "float",
        "parts": parts,
        "bake": {
            "samples": args.samples,
            "device": device,
            "seconds": round(tb, 1),
            "denoised": not args.no_denoise,
            "layout": data.get("layout", ""),
            "date": datetime.date.today().isoformat(),
        },
    }
    man["sets"] = dict(sorted(man["sets"].items()))
    with open(man_path, "w", encoding="utf-8") as f:
        json.dump(man, f, indent=1)
        f.write("\n")
    log(f"{setn}: wrote {png_name} + {uv2_name}, {len(parts)} parts, stats {json.dumps(stats)}")
    log(f"total {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
