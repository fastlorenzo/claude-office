/** Decompress an EXT_meshopt_compression GLB (Mesh2Motion clips) so Blender can import it. */
import { NodeIO } from "@gltf-transform/core";
import { EXTMeshoptCompression } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression])
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
const [src, dst] = process.argv.slice(2);
const doc = await io.read(src);
doc.getRoot().listExtensionsUsed().forEach((e) => e.dispose());
await io.write(dst, doc);
