"""
QA renders of the exported cast (imports the final GLBs, so what you see is what ships).

    blender --background --python tools/mpfb/render_qa.py -- --dir DIR --out out.png \
        [--clip idle|type|...] [--frame N] [--angle DEG] [--seated] [--ids a,b] [--rocketbox GLB]
        [--res 1600x900] [--engine EEVEE|CYCLES] [--closeup]
"""

import math
import os
import sys

import bpy
from mathutils import Euler, Vector


def arg(name, default=None, flag=False):
    a = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if name in a:
        return True if flag else a[a.index(name) + 1]
    return default


def mat(name, col, rough=0.8):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*col, 1)
    b.inputs["Roughness"].default_value = rough
    return m


def box(name, loc, size, color):
    bpy.ops.mesh.primitive_cube_add(location=loc)
    o = bpy.context.active_object
    o.name = name
    o.scale = (size[0] / 2, size[1] / 2, size[2] / 2)
    o.data.materials.append(mat(name, color))
    return o


def main():
    d = arg("--dir")
    out = arg("--out", "/tmp/qa.png")
    clip = arg("--clip", "idle")
    frame = int(arg("--frame", "1"))
    angle = math.radians(float(arg("--angle", "0")))
    seated = arg("--seated", flag=True)
    closeup = arg("--closeup", flag=True)
    res = [int(x) for x in arg("--res", "1600x900").split("x")]
    ids = arg("--ids")
    rocket = arg("--rocketbox")
    engine = arg("--engine", "EEVEE")

    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.fps = 24
    files = sorted(f for f in os.listdir(d) if f.endswith(".glb") and f != "animations.glb")
    if ids:
        want = ids.split(",")
        files = [f for f in files if f[:-4] in want]
    n = len(files) + (1 if rocket else 0)
    cols = min(n, 5) if not seated and not closeup else n
    rows = math.ceil(n / cols)
    spacing = 1.15 if not seated else 2.2
    if closeup:
        spacing = 0.7
    all_roots = []
    todo = [(os.path.join(d, f), f[:-4]) for f in files]
    if rocket:
        todo.append((rocket, "rocketbox"))
    for i, (p, name) in enumerate(todo):
        before_o, before_a = set(bpy.data.objects), set(bpy.data.actions)
        bpy.ops.import_scene.gltf(filepath=p)
        new = [o for o in bpy.data.objects if o not in before_o]
        arms = [o for o in new if o.type == "ARMATURE"]
        acts = {a.name.split(".")[0]: a for a in bpy.data.actions if a not in before_a}
        root = arms[0]
        top = [o for o in new if o.parent is None]
        r, c = divmod(i, cols)
        # place on the grid (empty parent so imported transforms are untouched)
        e = bpy.data.objects.new(name + "_slot", None)
        sc.collection.objects.link(e)
        e.location = ((c - (cols - 1) / 2) * spacing, -r * spacing * 1.0 + (rows - 1) * spacing / 2 * 0, 0)
        e.rotation_euler = Euler((0, 0, angle), "XYZ")
        for o in top:
            o.parent = e
        if root.animation_data is None:
            root.animation_data_create()
        a = acts.get(clip)
        if a is not None and name != "rocketbox":
            root.animation_data.action = a
        elif name == "rocketbox":
            pass
        sc.frame_set(frame)
        bpy.context.view_layer.update()
        if seated:
            # chair under the pelvis
            pel = root.pose.bones.get("pelvis")
            if pel:
                pz = (root.matrix_world @ pel.head).z
                py = (root.matrix_world @ pel.head).y
                seat = pz - 0.09
                cx = e.location.x
                box(name + "_chair", (cx, py + 0.02 - 0.0, seat - 0.02), (0.46, 0.46, 0.04), (0.12, 0.12, 0.14))
                box(name + "_chairback", (cx, py + 0.24, seat + 0.25), (0.44, 0.04, 0.5), (0.12, 0.12, 0.14))
                box(name + "_desk", (cx, py - 0.62, seat + 0.29 - 0.02), (0.9, 0.7, 0.04), (0.55, 0.42, 0.3))
                box(name + "_kbd", (cx, py - 0.5, seat + 0.29 + 0.01), (0.42, 0.14, 0.02), (0.05, 0.05, 0.06))
                box(name + "_deskleg", (cx, py - 0.62, seat / 2 + 0.1), (0.8, 0.6, 0.02), (0.3, 0.3, 0.3))
                box(name + "_floor", (cx, py - 0.3, -0.02), (2.4, 2.4, 0.02), (0.3, 0.3, 0.32))
        all_roots.append(e)

    # floor + backdrop
    box("floor", (0, 0, -0.025), (cols * spacing + 6, rows * spacing + 6, 0.05), (0.22, 0.22, 0.24))
    box("wall", (0, 3.2, 1.5), (cols * spacing + 8, 0.05, 4), (0.5, 0.5, 0.52))

    # world ambient (office-ish, slightly cool)
    w = bpy.data.worlds.new("w")
    sc.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.75, 0.8, 0.88, 1)
    bg.inputs["Strength"].default_value = 0.35

    def light(name, kind, loc, energy, size=2.0, rot=None, color=(1, 1, 1)):
        ld = bpy.data.lights.new(name, kind)
        ld.energy = energy
        if kind == "AREA":
            ld.size = size
        ld.color = color
        o = bpy.data.objects.new(name, ld)
        sc.collection.objects.link(o)
        o.location = loc
        if rot:
            o.rotation_euler = rot
        return o

    span = cols * spacing
    light("key", "AREA", (-span * 0.3, -4.5, 4.2), 380 * max(1, span / 4), size=4.0, rot=(math.radians(60), 0, math.radians(-20)),
          color=(1.0, 0.96, 0.9))
    light("fill", "AREA", (span * 0.4, -4.0, 2.2), 110 * max(1, span / 4), size=5.0, rot=(math.radians(80), 0, math.radians(25)),
          color=(0.85, 0.9, 1.0))
    light("rim", "AREA", (0, 3.0, 3.5), 150, size=3.0, rot=(math.radians(-120), 0, 0))

    cam = bpy.data.cameras.new("cam")
    cam.lens = 50 if not closeup else 85
    co = bpy.data.objects.new("cam", cam)
    sc.collection.objects.link(co)
    sc.camera = co
    h = float(arg("--cam-h", 0.95 if not closeup else 1.6))
    width = float(arg("--cam-w", cols * spacing + 0.5))
    dist = width / (36.0 / cam.lens)
    co.location = (0, -dist, h + (0.0 if not seated else -0.05))
    direction = Vector((0, 0, h)) - co.location
    co.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()

    sc.render.filepath = out
    sc.render.image_settings.file_format = "PNG"
    sc.view_settings.view_transform = "Standard"
    if engine == "CYCLES":
        sc.render.engine = "CYCLES"
        sc.cycles.samples = 24
        sc.cycles.use_denoising = True
    else:
        sc.render.engine = "BLENDER_EEVEE_NEXT"
        sc.eevee.taa_render_samples = 24
    bpy.ops.render.render(write_still=True)
    print("rendered", out)


main()
