"""
Generate one realistic office character with MPFB2 (MakeHuman, CC0 assets) in
headless Blender and export it as a self-contained GLB (mesh + canonical
skeleton + retargeted clips).

    blender --background --python tools/mpfb/generate_cast.py -- \
        --id office_m01 [--out DIR] [--no-anim] [--list]

Everything is deterministic: character definitions live in CAST below, there is
no randomness. See README.md for the full pipeline and the licence table.
"""

import json
import math
import os
import sys

import bpy
from mathutils import Matrix, Quaternion, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

CACHE = os.environ.get("MPFB_CACHE", os.path.expanduser("~/.cache/mpfb"))
UAL_GLB = os.path.join(
    CACHE, "ual", "Universal Animation Library[Standard]", "Unreal-Godot", "UAL1_Standard.glb"
)
M2M_DIR = os.path.join(CACHE, "m2m_raw")  # meshopt-decompressed Mesh2Motion clips

# ---------------------------------------------------------------------------
# Cast definition (all assets are CC0, see README licence table)
# ---------------------------------------------------------------------------

# age in years -> MPFB macro slider (0.5 == 25 y, 1.0 == 90 y)
def age_slider(years):
    return 0.5 + (years - 25.0) / 65.0 * 0.5 if years >= 25 else 0.1875 + (years - 11) / 14.0 * 0.3125


CAST = [
    dict(id="office_m01", sex="m", age=34, height=1.84, race=(0.05, 0.9, 0.05), weight=0.52, muscle=0.55,
         skin="young_caucasian_male", eyes="brown", brows="eyebrow002", lashes="eyelashes02", hair="short02",
         hair_tint=(0.16, 0.10, 0.06), clothes=["male_elegantsuit01"], shoes="shoes03"),
    dict(id="office_m02", sex="m", age=47, height=1.78, race=(0.0, 0.1, 0.9), weight=0.62, muscle=0.5,
         skin="middleage_african_male", eyes="brown", brows="eyebrow005", lashes="eyelashes02", hair="short04",
         hair_tint=(0.05, 0.05, 0.05), clothes=["male_casualsuit01"], shoes="shoes05"),
    dict(id="office_m03", sex="m", age=29, height=1.72, race=(0.9, 0.1, 0.0), weight=0.42, muscle=0.45,
         skin="young_asian_male", eyes="brown", brows="eyebrow003", lashes="eyelashes02", hair="short01",
         hair_tint=(0.03, 0.03, 0.035), clothes=["male_casualsuit03"], shoes="shoes01"),
    dict(id="office_m04", sex="m", age=58, height=1.80, race=(0.0, 1.0, 0.0), weight=0.7, muscle=0.5,
         skin="old_caucasian_male", eyes="grey", brows="eyebrow008", lashes="eyelashes02", hair="short03", hair_desat=(0.05, 1.6),
         hair_tint=(0.9, 0.9, 0.92), clothes=["toigo_male_double-breasted_suit"], shoes="shoes06"),
    dict(id="office_m05", sex="m", age=38, height=1.92, race=(0.0, 0.5, 0.5), weight=0.6, muscle=0.62,
         skin="middleage_african_male", eyes="brownlight", brows="eyebrow010", lashes="eyelashes02", hair="short01",
         hair_tint=(0.03, 0.03, 0.03), clothes=["toigo_male_suit_3"], shoes="shoes03"),
    dict(id="office_f01", sex="f", age=31, height=1.68, race=(0.05, 0.9, 0.05), weight=0.45, muscle=0.4,
         skin="young_caucasian_female", eyes="bluegreen", brows="eyebrow004", lashes="eyelashes01", hair="bob02",
         hair_tint=(0.35, 0.2, 0.09), clothes=["toigo_female_double-breasted_suit"], shoes="shoes03"),
    dict(id="office_f02", sex="f", age=44, height=1.62, race=(0.0, 0.05, 0.95), weight=0.55, muscle=0.4,
         skin="middleage_african_female", eyes="brown", brows="eyebrow006", lashes="eyelashes01", hair="ponytail01",
         hair_tint=(0.04, 0.035, 0.03), clothes=["toigo_basic_tucked_t-shirt", "toigo_wool_pants"], shoes="toigo_ballet_flats"),
    dict(id="office_f03", sex="f", age=27, height=1.70, race=(0.95, 0.05, 0.0), weight=0.4, muscle=0.4,
         skin="young_asian_female", eyes="brown", brows="eyebrow004", lashes="eyelashes01", hair="long01",
         hair_tint=(0.03, 0.03, 0.035), clothes=["toigo_female_suit"], shoes="toigo_flats"),
    dict(id="office_f04", sex="f", age=55, height=1.65, race=(0.0, 1.0, 0.0), weight=0.62, muscle=0.4,
         skin="middleage_caucasian_female", eyes="blue", brows="eyebrow007", lashes="eyelashes01", hair="toigo_blunt_bob", hair_desat=(0.05, 1.7),
         hair_tint=(0.75, 0.75, 0.78), clothes=["female_elegantsuit01"], shoes="toigo_stiletto_booties"),
    dict(id="office_f05", sex="f", age=36, height=1.75, race=(0.3, 0.4, 0.3), weight=0.5, muscle=0.45,
         skin="young_asian_female", eyes="green", brows="eyebrow004", lashes="eyelashes01", hair="bob02",
         hair_tint=(0.08, 0.05, 0.03), clothes=["toigo_female_suit_2"], clothes_tint=(0.3, 0.42, 0.38), shoes="toigo_flats"),
]

TEX = dict(skin=2048, cloth=1024, hair=1024, eyes=512, small=512)

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def log(*a):
    print("[cast]", *a, flush=True)


def data_root():
    from bl_ext.user_default.mpfb.services.locationservice import LocationService

    return os.path.dirname(os.path.normpath(LocationService.get_user_data(".")))  # .../mpfb/data -> parent


def user_data():
    from bl_ext.user_default.mpfb.services.locationservice import LocationService

    return os.path.normpath(LocationService.get_user_data("."))


def find_asset(subdir, basename):
    from bl_ext.user_default.mpfb.services.assetservice import AssetService

    p = AssetService.find_asset_absolute_path(basename, asset_subdir=subdir)
    if p is None:
        raise RuntimeError(f"asset not found: {subdir}/{basename}")
    return p


def parse_header(path):
    """author/license/homepage from the leading comment block of a mhclo/mhmat."""
    out = {}
    with open(path, encoding="utf-8", errors="ignore") as fh:
        for line in fh:
            if not line.startswith(("#", "//")) and line.strip():
                break
            t = line.lstrip("#/ ").strip()
            for k in ("author", "license", "homepage", "copyright"):
                if t.lower().startswith(k + " "):
                    out.setdefault(k, t[len(k) + 1:].strip())
    return out


def parse_mhmat(path):
    d = dict(textures={}, transparent=False, diffuse_color=(1, 1, 1), path=path)
    base = os.path.dirname(path)
    with open(path, encoding="utf-8", errors="ignore") as fh:
        for line in fh:
            p = line.split()
            if len(p) >= 2:
                k = p[0]
                if k.endswith("Texture"):
                    d["textures"][k] = os.path.join(base, " ".join(p[1:]))
                elif k == "transparent":
                    d["transparent"] = p[1].lower() == "true"
                elif k == "diffuseColor" and len(p) >= 4:
                    d["diffuse_color"] = tuple(float(x) for x in p[1:4])
    return d


# ---------------------------------------------------------------------------
# Height calibration
# ---------------------------------------------------------------------------


def measure_height(pheno):
    from bl_ext.user_default.mpfb.services.humanservice import HumanService

    mesh = HumanService.create_human(mask_helpers=False, detailed_helpers=False, extra_vertex_groups=False,
                                     feet_on_ground=True, scale=0.1, macro_detail_dict=pheno)
    ys = [v.co.z for v in mesh.data.vertices]
    # head top = highest vertex of the skin (helpers excluded: use dimensions of the body group)
    h = mesh.dimensions.z
    bpy.data.objects.remove(mesh, do_unlink=True)
    return h


def calibrate(spec):
    from bl_ext.user_default.mpfb.services.targetservice import TargetService

    ph = TargetService.get_default_macro_info_dict()
    ph.update(gender=1.0 if spec["sex"] == "m" else 0.0, age=age_slider(spec["age"]), weight=spec["weight"],
              muscle=spec["muscle"], proportions=0.5, cupsize=0.5, firmness=0.5)
    a, c, af = spec["race"]
    ph["race"] = dict(asian=a, caucasian=c, african=af)
    lo, hi = 0.0, 1.0
    for _ in range(9):
        mid = (lo + hi) / 2
        ph["height"] = mid
        # create_human reads macro dict values
        h = measure_height(json.loads(json.dumps(ph)))
        if h < spec["height"]:
            lo = mid
        else:
            hi = mid
    ph["height"] = (lo + hi) / 2
    return ph


# ---------------------------------------------------------------------------
# Character construction
# ---------------------------------------------------------------------------


def select_only(obj):
    for o in list(bpy.context.view_layer.objects):
        if o is not None:
            o.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def build_human(spec):
    from bl_ext.user_default.mpfb.services.humanservice import HumanService

    pheno = calibrate(spec)
    info = HumanService._create_default_human_info_dict()
    info["phenotype"] = pheno
    info.update(
        rig="game_engine",
        eyes="low-poly.mhclo",
        eyebrows=spec["brows"] + ".mhclo",
        eyelashes=spec["lashes"] + ".mhclo",
        hair=spec["hair"] + ".mhclo",
        clothes=[c + ".mhclo" for c in spec["clothes"]] + [spec["shoes"] + ".mhclo"],
        skin_mhmat=spec["skin"] + ".mhmat",
        skin_material_type="MAKESKIN",
        name=spec["id"],
    )
    s = HumanService.get_default_deserialization_settings()
    s["subdiv_levels"] = 0
    body = HumanService.deserialize_from_dict(info, s)
    return body, pheno


def classify(obj, spec):
    n = obj.name
    if n.endswith(".body"):
        return "body"
    if n.endswith(spec["hair"]):
        return "hair"
    if n.endswith("low-poly"):
        return "eyes"
    if n.endswith(spec["brows"]):
        return "brows"
    if n.endswith(spec["lashes"]):
        return "lashes"
    if n.endswith(spec["shoes"]):
        return "shoes"
    return "clothes"


def asset_dir_for(kind, spec):
    return dict(hair=("hair", spec["hair"]), eyes=("eyes", "low-poly"), brows=("eyebrows", spec["brows"]),
                lashes=("eyelashes", spec["lashes"]), shoes=("clothes", spec["shoes"]))[kind]


def bake_shape_keys_and_masks(obj):
    select_only(obj)
    if obj.data.shape_keys:
        bpy.ops.object.shape_key_remove(all=True, apply_mix=True)
    for md in list(obj.modifiers):
        if md.type in {"MASK"}:
            bpy.ops.object.modifier_apply(modifier=md.name)


def strip_vertex_groups(obj, arm):
    keep = {b.name for b in arm.data.bones}
    for vg in list(obj.vertex_groups):
        if vg.name not in keep:
            obj.vertex_groups.remove(vg)


def tris(obj):
    m = obj.data
    m.calc_loop_triangles()
    return len(m.loop_triangles)


def decimate(obj, target, protect_groups=None, protect=0.0):
    n = tris(obj)
    if n <= target:
        return n
    select_only(obj)
    md = obj.modifiers.new("dec", "DECIMATE")
    md.decimate_type = "COLLAPSE"
    md.ratio = max(0.02, target / n)
    md.use_collapse_triangulate = True
    md.delimit = {"MATERIAL", "UV"} if False else set()
    if protect_groups:
        vg = obj.vertex_groups.new(name="_protect")
        for g in protect_groups:
            src = obj.vertex_groups.get(g)
            if not src:
                continue
            for v in obj.data.vertices:
                for ge in v.groups:
                    if ge.group == src.index and ge.weight > 0.3:
                        vg.add([v.index], 1.0, "REPLACE")
        md.vertex_group = vg.name
        md.vertex_group_factor = 10.0
    bpy.ops.object.modifier_apply(modifier=md.name)
    obj.vertex_groups.remove(obj.vertex_groups["_protect"]) if protect_groups and "_protect" in obj.vertex_groups else None
    return tris(obj)


def load_image(path, size, alpha_keep=True):
    img = bpy.data.images.load(path, check_existing=True)
    if max(img.size) > size:
        img.scale(size, size) if img.size[0] == img.size[1] else img.scale(size, max(1, int(size * img.size[1] / img.size[0])))
    return img


def make_material(name, mh, size, *, rough=0.7, alpha=False, tint=None, desat=None, normal=True, metallic=0.0, spec=0.3,
                  clearcoat=0.0, extra=None):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Specular IOR Level"].default_value = spec
    if clearcoat:
        bsdf.inputs["Coat Weight"].default_value = clearcoat
        bsdf.inputs["Coat Roughness"].default_value = 0.03
    tex = mh["textures"].get("diffuseTexture")
    base_col = tint if tint else (1, 1, 1)
    if tex and os.path.exists(tex):
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = load_image(tex, size)
        t.image.colorspace_settings.name = "sRGB"
        colout = t.outputs["Color"]
        if desat is not None:
            hs = nt.nodes.new("ShaderNodeHueSaturation")
            hs.inputs["Saturation"].default_value = desat[0]
            hs.inputs["Value"].default_value = desat[1]
            nt.links.new(colout, hs.inputs["Color"])
            colout = hs.outputs["Color"]
        if tint:
            mix = nt.nodes.new("ShaderNodeMix")
            mix.data_type = "RGBA"
            mix.blend_type = "MULTIPLY"
            mix.inputs[0].default_value = 1.0
            mix.inputs[7].default_value = (*base_col, 1)
            nt.links.new(colout, mix.inputs[6])
            nt.links.new(mix.outputs[2], bsdf.inputs["Base Color"])
        else:
            nt.links.new(colout, bsdf.inputs["Base Color"])
        if alpha:
            nt.links.new(t.outputs["Alpha"], bsdf.inputs["Alpha"])
    else:
        bsdf.inputs["Base Color"].default_value = (*base_col, 1)
    ntex = mh["textures"].get("normalmapTexture")
    if normal and ntex and os.path.exists(ntex):
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = load_image(ntex, size)
        t.image.colorspace_settings.name = "Non-Color"
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.inputs["Strength"].default_value = 0.8
        nt.links.new(t.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    if alpha:
        mat.blend_method = "BLEND"
    return mat


def assign_single_material(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(mat)


def build_character(spec):
    body, pheno = build_human(spec)
    arm = body.parent
    arm.name = spec["id"] + "_rig"
    meshes = [o for o in bpy.data.objects if o.type == "MESH" and o.parent == arm]
    info = dict(id=spec["id"], parts=[], licenses=[])
    parts = {}
    for o in meshes:
        kind = classify(o, spec)
        bake_shape_keys_and_masks(o)
        strip_vertex_groups(o, arm)
        parts[o.name] = kind

    # eye colour/skin/etc materials
    for o in meshes:
        kind = parts[o.name]
        hdr = None
        if kind == "body":
            mp = find_asset("skins", spec["skin"] + ".mhmat")
            mh = parse_mhmat(mp)
            hdr = parse_header(mp)
            mat = make_material(spec["id"] + "_skin", mh, TEX["skin"], rough=0.52, spec=0.4)
            lic = (spec["skin"], "skins", hdr)
        elif kind == "eyes":
            mp = find_asset("eyes", spec["eyes"] + ".mhmat")
            mh = parse_mhmat(mp)
            hdr = parse_header(mp)
            mat = make_material(spec["id"] + "_eyes", mh, TEX["eyes"], rough=0.08, spec=0.9, clearcoat=1.0, normal=False)
            lic = ("eyes/" + spec["eyes"], "eyes", hdr)
        else:
            sub, base = ("clothes", None)
            if kind in ("hair", "brows", "lashes", "shoes"):
                sub, base = asset_dir_for(kind, spec)
            else:
                sub, base = "clothes", o.name.split(".", 1)[1]
            mhclo = find_asset(sub, base + ".mhclo")
            hdr = parse_header(mhclo)
            matfile = None
            with open(mhclo, encoding="utf-8", errors="ignore") as fh:
                for line in fh:
                    if line.startswith("material "):
                        matfile = line.split(None, 1)[1].strip()
                        break
            mp = os.path.join(os.path.dirname(mhclo), matfile)
            mh = parse_mhmat(mp)
            hdr = {**parse_header(mp), **hdr}
            if kind == "hair":
                mat = make_material(spec["id"] + "_hair", mh, TEX["hair"], rough=0.55, alpha=True, tint=spec.get("hair_tint"),
                                    desat=spec.get("hair_desat"), spec=0.3)
            elif kind in ("brows", "lashes"):
                mat = make_material(spec["id"] + "_" + kind, mh, TEX["small"], rough=0.8, alpha=True, normal=False,
                                    tint=spec.get("hair_tint") if kind == "brows" else None, spec=0.1)
            elif kind == "shoes":
                mat = make_material(spec["id"] + "_shoes", mh, TEX["cloth"], rough=0.45, spec=0.5)
            else:
                mat = make_material(spec["id"] + "_clothes_" + base, mh, TEX["cloth"], rough=0.8, spec=0.25,
                                    tint=spec.get("clothes_tint"))
            lic = (base, sub, hdr)
        assign_single_material(o, mat)
        info["licenses"].append(dict(asset=lic[0], type=lic[1], author=lic[2].get("author"), license=lic[2].get("license")))

    # Topology budget
    budget = dict(body=8000, clothes=6000 if len(spec["clothes"]) == 1 else 3600, shoes=1600, hair=3800, eyes=400, brows=300, lashes=300)
    for o in meshes:
        kind = parts[o.name]
        bud = budget[kind]
        if kind == "body":
            decimate(o, bud, protect_groups=["head", "neck_01"] + [b.name for b in arm.data.bones if b.name.split("_")[0] in
                     ("index", "middle", "ring", "pinky", "thumb", "hand")], protect=1)
        elif kind in ("clothes", "shoes", "hair"):
            decimate(o, bud)
        info["parts"].append(dict(name=o.name, kind=kind, tris=tris(o)))
    info["height"] = round(max(v.co.z for v in body.data.vertices if True), 4)
    return arm, meshes, parts, info, pheno


# ---------------------------------------------------------------------------
# Animation sources and retargeting
# ---------------------------------------------------------------------------

# runtime clip -> (source file, action name)
UAL_CLIPS = {
    "idle": "Idle_Loop",
    "walk": "Walk_Formal_Loop",
    "sitIdle": "Sitting_Idle_Loop",
    "talk": "Idle_Talking_Loop",
    "sitTalk": "Sitting_Talking_Loop",
}
M2M_CLIPS = {  # clip -> file basename (Mesh2Motion, CC0)
    "wave": "greeting",
    "cheer": "victory",
    "clap": "clapping",
    "nod": "head-nod",
    "listen": "idle-listening",
    "idleA": "idle-a",
    "idleSubtle": "idle-subtle",
    "walkRelaxed": "walk-relaxed",
    "walkM2M": "walk-formal",
}
BONE_ALIAS = {"root": "Root", "Head": "head"}  # UAL -> canonical (MPFB game_engine)


def fcurves_of(action):
    if hasattr(action, "fcurves"):
        try:
            return list(action.fcurves)
        except Exception:
            pass
    out = []
    for layer in action.layers:
        for strip in layer.strips:
            for cb in strip.channelbags:
                out.extend(cb.fcurves)
    return out


class Source:
    """One source clip: armature rest + sampled fcurves, evaluated with own FK."""

    def __init__(self, arm, action):
        self.arm = arm
        self.action = action
        self.bones = {b.name: b for b in arm.data.bones}
        self.rest = {n: (arm.matrix_world @ b.matrix_local) for n, b in self.bones.items()}
        self.curves = {}
        for fc in fcurves_of(action):
            if not fc.data_path.startswith("pose.bones["):
                continue
            bn = fc.data_path.split('"')[1]
            prop = fc.data_path.rsplit(".", 1)[1]
            self.curves.setdefault((bn, prop), {})[fc.array_index] = fc
        self.frame_start, self.frame_end = int(round(action.frame_range[0])), int(round(action.frame_range[1]))
        self.order = [b.name for b in arm.data.bones]  # parents before children

    def basis(self, bn, f):
        q = Quaternion((1, 0, 0, 0))
        loc = Vector((0, 0, 0))
        c = self.curves.get((bn, "rotation_quaternion"))
        if c:
            q = Quaternion([c[i].evaluate(f) if i in c else (1 if i == 0 else 0) for i in range(4)])
        c = self.curves.get((bn, "location"))
        if c:
            loc = Vector([c[i].evaluate(f) if i in c else 0 for i in range(3)])
        return Matrix.Translation(loc) @ q.to_matrix().to_4x4()

    def pose(self, f):
        """armature(world)-space pose matrix for every bone at frame f."""
        P = {}
        for n in self.order:
            b = self.bones[n]
            if b.parent is None:
                P[n] = self.rest[n] @ self.basis(n, f)
            else:
                pn = b.parent.name
                P[n] = P[pn] @ (self.rest[pn].inverted() @ self.rest[n]) @ self.basis(n, f)
        return P


class Target:
    def __init__(self, arm):
        self.arm = arm
        self.bones = {b.name: b for b in arm.data.bones}
        self.rest = {n: (arm.matrix_world @ b.matrix_local) for n, b in self.bones.items()}
        self.order = [b.name for b in arm.data.bones]
        self.height = self.rest["pelvis"].translation.z

    def dir_rest(self, n):
        return (self.rest[n].to_3x3() @ Vector((0, 1, 0))).normalized()


def swing_twist(q, axis):
    v = Vector((q.x, q.y, q.z))
    proj = axis * v.dot(axis)
    tw = Quaternion((q.w, proj.x, proj.y, proj.z))
    if tw.magnitude < 1e-8:
        return Quaternion((1, 0, 0, 0))
    tw.normalize()
    return tw


def retarget_frame(src, tgt, f, rest_src_pelvis_h):
    """Return {bone: (rot3x3 Quaternion in armature space)} and pelvis position."""
    Ps = src.pose(f)
    R = {}
    for tn in tgt.order:
        sn = None
        for cand in (tn, {v: k for k, v in BONE_ALIAS.items()}.get(tn, tn)):
            if cand in src.bones:
                sn = cand
                break
        if sn is None:
            R[tn] = None
            continue
        rs = src.rest[sn].to_3x3().normalized()
        rt = tgt.rest[tn].to_3x3().normalized()
        ps = Ps[sn].to_3x3().normalized()
        d = ps @ rs.inverted()  # world delta of the source bone
        dq = d.to_quaternion()
        a = (rs @ Vector((0, 1, 0))).normalized()  # source rest dir
        cur = (d @ a).normalized()
        tw = swing_twist(dq, a)
        angle = tw.angle if tw.axis.dot(a) >= 0 else -tw.angle
        rt_dir = tgt.dir_rest(tn)
        arc = rt_dir.rotation_difference(cur)
        twq = Quaternion(rt_dir, angle)
        R[tn] = (arc @ twq @ rt.to_quaternion())
    ppos = None
    if "pelvis" in src.bones:
        h = Ps["pelvis"].translation
        rest_h = src.rest["pelvis"].translation
        scale = tgt.height / rest_src_pelvis_h
        trest = tgt.rest["pelvis"].translation
        ppos = trest + Vector(((h.x - rest_h.x) * scale, (h.y - rest_h.y) * scale, (h.z - rest_h.z) * scale))
    return R, ppos


def fk_to_basis(tgt, R, ppos):
    """Turn absolute armature-space orientations into local pose basis (loc, quat) per bone."""
    P = {}
    out = {}
    for n in tgt.order:
        b = tgt.bones[n]
        q = R.get(n)
        rest = tgt.rest[n]
        if b.parent is None:
            parent_pose, parent_rest = None, None
            natural = rest.translation
        else:
            pn = b.parent.name
            parent_pose, parent_rest = P[pn], tgt.rest[pn]
            natural = (parent_pose @ (parent_rest.inverted() @ rest)).translation
        if q is None:
            # not driven: keep rest relation to parent
            if parent_pose is None:
                P[n] = rest
            else:
                P[n] = parent_pose @ (parent_rest.inverted() @ rest)
            out[n] = (Vector((0, 0, 0)), Quaternion((1, 0, 0, 0)))
            continue
        pos = natural
        if n == "pelvis" and ppos is not None:
            pos = ppos
        M = Matrix.Translation(pos) @ q.to_matrix().to_4x4()
        P[n] = M
        if parent_pose is None:
            local = rest.inverted() @ M
        else:
            local = (parent_pose @ (parent_rest.inverted() @ rest)).inverted() @ M
        loc, rot, _ = local.decompose()
        out[n] = (loc, rot)
    return out, P


def write_action(arm, name, frames_basis, fps=24):
    """frames_basis: list (per frame) of {bone: (loc, quat)}; written with keyframes."""
    arm.animation_data_create()
    act = bpy.data.actions.new(name)
    arm.animation_data.action = act
    for pb in arm.pose.bones:
        pb.rotation_mode = "QUATERNION"
    # make successive quaternions continuous
    prev = {}
    for i, fb in enumerate(frames_basis):
        f = i + 1
        for bn, (loc, q) in fb.items():
            pb = arm.pose.bones.get(bn)
            if pb is None:
                continue
            p = prev.get(bn)
            if p is not None and p.dot(q) < 0:
                q = Quaternion((-q.w, -q.x, -q.y, -q.z))
            prev[bn] = q
            pb.rotation_quaternion = q
            pb.keyframe_insert("rotation_quaternion", frame=f, group=bn)
            if bn in ("pelvis", "Root"):
                pb.location = loc
                pb.keyframe_insert("location", frame=f, group=bn)
    arm.animation_data.action = None
    track = arm.animation_data.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, 1, act)
    strip.name = name
    act.use_fake_user = True
    return act


def import_sources():
    """Import UAL + Mesh2Motion clips; return {clip: Source}. Mesh objects are deleted."""
    srcs = {}
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=UAL_GLB)
    new = [o for o in bpy.data.objects if o not in before]
    arm = [o for o in new if o.type == "ARMATURE"][0]
    for o in new:
        if o.type == "MESH":
            bpy.data.objects.remove(o, do_unlink=True)
    for clip, an in UAL_CLIPS.items():
        srcs[clip] = Source(arm, bpy.data.actions[an])
    ual_arm = arm
    for clip, fn in M2M_CLIPS.items():
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.join(M2M_DIR, fn + ".glb"))
        new = [o for o in bpy.data.objects if o not in before]
        arm = [o for o in new if o.type == "ARMATURE"][0]
        for o in new:
            if o.type == "MESH":
                bpy.data.objects.remove(o, do_unlink=True)
        act = arm.animation_data.action if arm.animation_data and arm.animation_data.action else None
        if act is None:
            act = [a for a in bpy.data.actions if a not in {s.action for s in srcs.values()}][-1]
        srcs[clip] = Source(arm, act)
    return srcs, ual_arm


def frames_for(src, tgt, src_pelvis_h):
    out = []
    for f in range(src.frame_start, src.frame_end + 1):
        R, ppos = retarget_frame(src, tgt, f, src_pelvis_h)
        out.append((R, ppos))
    return out


# ----- procedural poses (typing / thinking / raise hand) ---------------------------------

def aim(tgt, bone, direction, roll_ref=None):
    """Absolute orientation of `bone` whose rest axis rotates (shortest arc) to `direction`."""
    rt = tgt.rest[bone].to_3x3().normalized().to_quaternion()
    arc = tgt.dir_rest(bone).rotation_difference(Vector(direction).normalized())
    return arc @ rt


def side_vec(side, x, y, z):
    """character space: forward = -Y, up = +Z, left (l) = +X, right (r) = -X"""
    s = 1 if side == "l" else -1
    return Vector((s * x, -y, z))


def relax_stand(tgt, frames, curl_axis, arms=False):
    """Standing clips: straight legs at hip width, flat feet, pelvis at rest height (the UAL idle is an
    action-game crouch). With arms=True the arms hang relaxed (office idle)."""
    out = []
    for R0, ppos in frames:
        over = {}
        extra = {}
        for s in ("l", "r"):
            over[f"thigh_{s}"] = aim(tgt, f"thigh_{s}", side_vec(s, 0.045, -0.01, -1.0))
            over[f"calf_{s}"] = aim(tgt, f"calf_{s}", side_vec(s, 0.0, 0.02, -1.0))
            over[f"foot_{s}"] = tgt.rest[f"foot_{s}"].to_3x3().normalized().to_quaternion()
            over[f"ball_{s}"] = tgt.rest[f"ball_{s}"].to_3x3().normalized().to_quaternion()
            if arms:
                over[f"upperarm_{s}"] = aim(tgt, f"upperarm_{s}", side_vec(s, 0.16, -0.02, -1.0))
                over[f"lowerarm_{s}"] = aim(tgt, f"lowerarm_{s}", side_vec(s, 0.06, 0.28, -0.95))
                over[f"hand_{s}"] = aim(tgt, f"hand_{s}", side_vec(s, 0.02, 0.18, -0.98))
                for b in tgt.order:
                    nm = b.split("_")[0]
                    if b.endswith("_" + s) and nm in ("index", "middle", "ring", "pinky", "thumb"):
                        extra[b] = ("curl", 0.35)
        Rn = apply_overrides(tgt, R0, over, extra, curl_axis)
        p = ppos.copy()
        p.z = tgt.rest["pelvis"].translation.z
        out.append((Rn, p))
    return out


def procedural(tgt, base_frames, kind, n_frames=None):
    """base_frames: list of (R, ppos); returns list of (R, ppos) with arm overrides."""
    out = []
    n = n_frames or len(base_frames)
    fingers = [b for b in tgt.order if b.split("_")[0] in ("index", "middle", "ring", "pinky", "thumb")]
    for i in range(n):
        R0, ppos = base_frames[i % len(base_frames)]
        t = i / n  # 0..1 loop phase
        R = dict(R0)
        over = {}  # bone -> absolute quaternion
        extra = {}  # bone -> local extra quaternion (bone-local axes)
        if kind == "type":
            for s in ("l", "r"):
                bob = math.sin(2 * math.pi * (t * 2 + (0.0 if s == "l" else 0.37))) * 0.05
                over[f"upperarm_{s}"] = aim(tgt, f"upperarm_{s}", side_vec(s, 0.16, 0.22 + bob * 0.3, -0.96))
                over[f"lowerarm_{s}"] = aim(tgt, f"lowerarm_{s}", side_vec(s, -0.10, 0.95, 0.06 + bob))
                over[f"hand_{s}"] = aim(tgt, f"hand_{s}", side_vec(s, -0.10, 0.95, -0.10 + bob))
            for fb in fingers:
                parts = fb.split("_")
                nm, idx, s = parts[0], int(parts[1]), parts[2]
                if nm == "thumb":
                    continue
                k = {"index": 0, "middle": 1, "ring": 2, "pinky": 3}[nm]
                ph = 2 * math.pi * (t * 4 + k * 0.23 + (0 if s == "l" else 0.5))
                press = max(0.0, math.sin(ph)) ** 2
                curl = 0.30 + 0.22 * k * 0.0 + 0.34 * press
                extra[fb] = ("curl", curl * (1.0 if idx == 1 else 1.25))
            extra["head"] = ("tilt", -0.14)
        elif kind == "thinking":
            breathe = math.sin(2 * math.pi * t) * 0.02
            over["upperarm_r"] = aim(tgt, "upperarm_r", side_vec("r", 0.05, 0.55, -0.82))
            over["lowerarm_r"] = aim(tgt, "lowerarm_r", side_vec("r", -0.40, 0.30, 0.95 + breathe))
            over["hand_r"] = aim(tgt, "hand_r", side_vec("r", -0.55, 0.15, 0.9))
            over["upperarm_l"] = aim(tgt, "upperarm_l", side_vec("l", 0.10, 0.45, -0.89))
            over["lowerarm_l"] = aim(tgt, "lowerarm_l", side_vec("l", -0.95, 0.2, 0.1))
            over["hand_l"] = aim(tgt, "hand_l", side_vec("l", -0.95, 0.3, 0.1))
            extra["head"] = ("tilt", 0.12 + 0.05 * math.sin(2 * math.pi * t))
            for fb in fingers:
                if fb.endswith("_r") and not fb.startswith("thumb") and not fb.startswith("index"):
                    extra[fb] = ("curl", 1.1)
        elif kind == "raiseHand":
            sway = math.sin(2 * math.pi * t) * 0.08
            over["upperarm_r"] = aim(tgt, "upperarm_r", side_vec("r", 0.45, 0.10, 0.88))
            over["lowerarm_r"] = aim(tgt, "lowerarm_r", side_vec("r", 0.10 + sway, 0.12, 0.99))
            over["hand_r"] = aim(tgt, "hand_r", side_vec("r", 0.10 + sway * 1.4, 0.12, 0.99))
            for fb in fingers:
                if fb.endswith("_r"):
                    extra[fb] = ("curl", -0.2)
        out.append((R, ppos, over, extra))
    return out


def apply_overrides(tgt, R, over, extra, curl_axis):
    """Resolve overrides into a complete absolute-orientation dict (children keep their local relation)."""
    # Base absolute orientations R (some None); new absolute orientations Rn
    Rn = {}
    for n in tgt.order:
        b = tgt.bones[n]
        base = R.get(n)
        if base is None:
            Rn[n] = None
            continue
        if n in over:
            q = over[n]
        elif b.parent is not None and R.get(b.parent.name) is not None and Rn.get(b.parent.name) is not None:
            pn = b.parent.name
            rel = R[pn].inverted() @ base
            q = Rn[pn] @ rel
        else:
            q = base
        if n in extra:
            kind, val = extra[n]
            if kind == "curl":
                q = q @ Quaternion(curl_axis[n], val)
            elif kind == "tilt":
                q = q @ Quaternion(Vector((1, 0, 0)), val)
        Rn[n] = q
    return Rn


def finger_curl_axes(tgt):
    """Per finger bone: local axis (bone space) about which positive angle curls the finger towards the palm (down
    when hand is palm-down in the rest pose)."""
    axes = {}
    for n in tgt.order:
        p = n.split("_")
        if p[0] in ("index", "middle", "ring", "pinky", "thumb") and len(p) == 3:
            rest = tgt.rest[n].to_3x3()
            best = None
            for ax in (Vector((1, 0, 0)), Vector((-1, 0, 0)), Vector((0, 0, 1)), Vector((0, 0, -1))):
                q = Quaternion(ax, 0.6)
                newdir = (rest @ q.to_matrix() @ Vector((0, 1, 0)))
                drop = rest.col[1].normalized().z - newdir.normalized().z  # >0 => tip moves down
                if best is None or drop > best[0]:
                    best = (drop, ax)
            axes[n] = best[1]
    axes["head"] = Vector((1, 0, 0))
    return axes


def bake_all(arm, spec):
    tgt = Target(arm)
    srcs, ual_arm = import_sources()
    ual_pelvis_h = srcs["idle"].rest["pelvis"].translation.z
    clips = {}
    for clip, src in srcs.items():
        h = src.rest["pelvis"].translation.z
        clips[clip] = frames_for(src, tgt, h)
        log("retargeted", clip, len(clips[clip]), "frames")
    curl_axis = finger_curl_axes(tgt)
    final = {}
    for clip, fr in clips.items():
        final[clip] = [(R, p, {}, {}) for R, p in fr]
    # procedural clips on top of base clips
    rest_idle = relax_stand(tgt, clips["idleSubtle"], curl_axis, arms=True)
    for c in ("talk", "wave", "listen", "clap", "nod"):
        clips[c] = relax_stand(tgt, clips[c], curl_axis)
        final[c] = [(R, p, {}, {}) for R, p in clips[c]]
    clips["idle"] = rest_idle
    final["idle"] = [(R, p, {}, {}) for R, p in rest_idle]
    final["type"] = procedural(tgt, clips["sitIdle"], "type", n_frames=48)
    final["thinking"] = procedural(tgt, rest_idle, "thinking", n_frames=60)
    final["raiseHand"] = procedural(tgt, rest_idle, "raiseHand", n_frames=60)
    order = ["idle", "walk", "sitIdle", "type", "thinking", "talk", "wave", "cheer", "raiseHand", "sitTalk", "clap", "nod", "listen"]
    order += [c for c in final if c not in order]
    stats = {}
    extra_info = dict(pelvisHeightM=round(tgt.height, 4))
    for clip in order:
        frames = []
        feet = []
        pelv = []
        for R, ppos, over, extra in final[clip]:
            Rn = apply_overrides(tgt, R, over, extra, curl_axis) if (over or extra) else R
            basis, P = fk_to_basis(tgt, Rn, ppos)
            frames.append(basis)
            feet.append(P["ball_l"].translation.copy())
            pelv.append(P["pelvis"].translation.copy())
        write_action(arm, clip, frames)
        stats[clip] = len(frames)
        if clip == "sitIdle":
            extra_info["sitPelvisHeightM"] = round(sum(p.z for p in pelv) / len(pelv), 4)
            extra_info["sitPelvisForwardM"] = round(-sum(p.y for p in pelv) / len(pelv), 4)  # +Z in glTF
        if clip == "walk":
            # in-place walk: stance foot travel / stance time (stance: ball within 3 cm of lowest point)
            zmin = min(p.z for p in feet)
            st = [i for i, p in enumerate(feet) if p.z < zmin + 0.03]
            if len(st) >= 3:
                ys = [feet[i].y for i in st]
                extra_info["walkSpeedMps"] = round((max(ys) - min(ys)) / (len(st) / 24.0), 3)
    return stats, extra_info, ual_arm


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------


def export_glb(arm, meshes, path):
    for o in list(bpy.context.view_layer.objects):
        if o is not None:
            o.select_set(False)
    arm.select_set(True)
    for m in meshes:
        m.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=False,
        export_animations=True,
        export_animation_mode="NLA_TRACKS",
        export_nla_strips=True,
        export_force_sampling=True,
        export_optimize_animation_size=True,
        export_frame_step=1,
        export_skins=True,
        export_all_influences=False,
        export_image_format="AUTO",
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        export_def_bones=False,
        export_leaf_bone=False,
    )


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ids = []
    out = os.path.join(HERE, "..", "..", "frontend", "public", "assets", "characters-mpfb", "raw")
    anim = True
    for i, a in enumerate(argv):
        if a == "--id":
            ids.append(argv[i + 1])
        if a == "--out":
            out = argv[i + 1]
        if a == "--no-anim":
            anim = False
        if a == "--list":
            print("\n".join(c["id"] for c in CAST))
            return
    out = os.path.abspath(out)
    os.makedirs(out, exist_ok=True)
    bpy.ops.preferences.addon_enable(module="bl_ext.user_default.mpfb")
    for spec in CAST:
        if ids and spec["id"] not in ids:
            continue
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.preferences.addon_enable(module="bl_ext.user_default.mpfb")
        bpy.context.scene.render.fps = 24
        log("building", spec["id"])
        arm, meshes, parts, info, pheno = build_character(spec)
        stats = {}
        if anim:
            stats, extra_info, ual_arm = bake_all(arm, spec)
            info.update(extra_info)
            bpy.data.objects.remove(ual_arm, do_unlink=True)
        info["clips"] = stats
        info["spec"] = {k: v for k, v in spec.items()}
        info["phenotype"] = pheno
        path = os.path.join(out, spec["id"] + ".glb")
        export_glb(arm, meshes, path)
        with open(os.path.join(out, spec["id"] + ".info.json"), "w") as fh:
            json.dump(info, fh, indent=1, default=str)
        log("exported", path, os.path.getsize(path))


main()
