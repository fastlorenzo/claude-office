/**
 * The ONLY import point for Babylon.js in the app.
 *
 * Deep imports keep the bundle tree-shaken; the side-effect imports below
 * register the scene components that the deep classes need at runtime
 * (Babylon throws "component not registered" errors without them).
 *
 * Add new exports here (additive edits only) rather than importing
 * `@babylonjs/*` directly from engine files.
 */

// ---------------------------------------------------------------------------
// Side effects (scene components / loaders)
// ---------------------------------------------------------------------------
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent"; // scene.enablePhysics
import "@babylonjs/core/Physics/v2/physicsEngineComponent"; // v2 observables
import "@babylonjs/core/Collisions/collisionCoordinator"; // moveWithCollisions fallback
import "@babylonjs/core/Culling/ray"; // scene.pick / pickWithRay
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent"; // shadow render step
import "@babylonjs/core/Layers/effectLayerSceneComponent"; // Glow / Highlight layers
import "@babylonjs/core/PostProcesses/RenderPipeline/postProcessRenderPipelineManagerSceneComponent";
import "@babylonjs/core/Rendering/geometryBufferRendererSceneComponent"; // SSAO2
import "@babylonjs/core/Rendering/prePassRendererSceneComponent"; // SSAO2 prepass
import "@babylonjs/core/Rendering/depthRendererSceneComponent";
import "@babylonjs/core/Rendering/outlineRenderer";
import "@babylonjs/core/Materials/Textures/Loaders/hdrTextureLoader";
import "@babylonjs/core/Materials/Textures/Loaders/envTextureLoader";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import "@babylonjs/core/Meshes/instancedMesh";
import "@babylonjs/core/Animations/animatable";
import "@babylonjs/core/Engines/Extensions/engine.renderTarget";
import "@babylonjs/core/Misc/screenshotTools";
import "@babylonjs/core/Helpers/sceneHelpers";
import "@babylonjs/loaders/glTF/2.0";

// ---------------------------------------------------------------------------
// Engine / scene
// ---------------------------------------------------------------------------
export { Engine } from "@babylonjs/core/Engines/engine";
export { NullEngine } from "@babylonjs/core/Engines/nullEngine";
export { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
export { Scene } from "@babylonjs/core/scene";
export type { IDisposable } from "@babylonjs/core/scene";
export { Observable } from "@babylonjs/core/Misc/observable";
export type { Observer } from "@babylonjs/core/Misc/observable";
export { Tools } from "@babylonjs/core/Misc/tools";
export { Logger } from "@babylonjs/core/Misc/logger";
export { PerformanceMonitor } from "@babylonjs/core/Misc/performanceMonitor";
export { SceneInstrumentation } from "@babylonjs/core/Instrumentation/sceneInstrumentation";
export { EngineInstrumentation } from "@babylonjs/core/Instrumentation/engineInstrumentation";

// Maths
export {
  Vector2,
  Vector3,
  Vector4,
  Quaternion,
  Matrix,
} from "@babylonjs/core/Maths/math.vector";
export { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
export { Scalar } from "@babylonjs/core/Maths/math.scalar";
export { Viewport } from "@babylonjs/core/Maths/math.viewport";
export { Plane } from "@babylonjs/core/Maths/math.plane";
export { Axis, Space } from "@babylonjs/core/Maths/math.axis";

// Nodes / meshes
export { Node } from "@babylonjs/core/node";
export { TransformNode } from "@babylonjs/core/Meshes/transformNode";
export { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
export { Mesh } from "@babylonjs/core/Meshes/mesh";
export { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
export { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
export { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
export { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
export { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
export { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
export { CreateCylinder } from "@babylonjs/core/Meshes/Builders/cylinderBuilder";
export { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
export { CreateCapsule } from "@babylonjs/core/Meshes/Builders/capsuleBuilder";
export { CreateTorus } from "@babylonjs/core/Meshes/Builders/torusBuilder";
export { CreateDisc } from "@babylonjs/core/Meshes/Builders/discBuilder";
export { CreateTube } from "@babylonjs/core/Meshes/Builders/tubeBuilder";
export { CreateLathe } from "@babylonjs/core/Meshes/Builders/latheBuilder";
export { ExtrudePolygon } from "@babylonjs/core/Meshes/Builders/polygonBuilder";
export { CreateLines } from "@babylonjs/core/Meshes/Builders/linesBuilder";
export { BoundingInfo } from "@babylonjs/core/Culling/boundingInfo";
export { Ray } from "@babylonjs/core/Culling/ray";
export { PickingInfo } from "@babylonjs/core/Collisions/pickingInfo";

// Materials / textures
export { Material } from "@babylonjs/core/Materials/material";
export { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
export { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
export { PBRMetallicRoughnessMaterial } from "@babylonjs/core/Materials/PBR/pbrMetallicRoughnessMaterial";
export { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial";
export { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
export { Texture } from "@babylonjs/core/Materials/Textures/texture";
export { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
export { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
export { HDRCubeTexture } from "@babylonjs/core/Materials/Textures/hdrCubeTexture";
export { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
export { MirrorTexture } from "@babylonjs/core/Materials/Textures/mirrorTexture";
export { ReflectionProbe } from "@babylonjs/core/Probes/reflectionProbe";
export { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
export { ColorCurves } from "@babylonjs/core/Materials/colorCurves";
export { ImageProcessingPostProcess } from "@babylonjs/core/PostProcesses/imageProcessingPostProcess";

// Cameras
export { Camera } from "@babylonjs/core/Cameras/camera";
export { TargetCamera } from "@babylonjs/core/Cameras/targetCamera";
export { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
export { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
export { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";

// Lights / shadows
export { Light } from "@babylonjs/core/Lights/light";
export { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
export { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
export { PointLight } from "@babylonjs/core/Lights/pointLight";
export { SpotLight } from "@babylonjs/core/Lights/spotLight";
export { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
export { CascadedShadowGenerator } from "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator";

// Effects / post-processing
export { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
export { HighlightLayer } from "@babylonjs/core/Layers/highlightLayer";
export { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
export { SSAO2RenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssao2RenderingPipeline";
export { SSRRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssrRenderingPipeline";
export { FxaaPostProcess } from "@babylonjs/core/PostProcesses/fxaaPostProcess";
export { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";

// Animation
export { Animation } from "@babylonjs/core/Animations/animation";
export { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
export {
  CubicEase,
  SineEase,
  QuadraticEase,
  EasingFunction,
} from "@babylonjs/core/Animations/easing";
export { Skeleton } from "@babylonjs/core/Bones/skeleton";
export { Bone } from "@babylonjs/core/Bones/bone";

// Loading
export { AssetContainer } from "@babylonjs/core/assetContainer";
export type { InstantiatedEntries } from "@babylonjs/core/assetContainer";
export {
  LoadAssetContainerAsync,
  ImportMeshAsync,
} from "@babylonjs/core/Loading/sceneLoader";

// Physics (v2 + Havok)
export { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
export { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
export { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody";
export {
  PhysicsShape,
  PhysicsShapeBox,
  PhysicsShapeCylinder,
  PhysicsShapeCapsule,
  PhysicsShapeSphere,
} from "@babylonjs/core/Physics/v2/physicsShape";
export {
  PhysicsShapeType,
  PhysicsMotionType,
} from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
export {
  PhysicsCharacterController,
  CharacterSupportedState,
} from "@babylonjs/core/Physics/v2/characterController";

// GUI
export {
  AdvancedDynamicTexture,
  Control,
  Rectangle,
  TextBlock,
  StackPanel,
  Grid,
  Image as GuiImage,
  Ellipse,
} from "@babylonjs/gui";

// Characters / screens (actors agent)
export { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
export { TextWrapping } from "@babylonjs/gui";

// ---------------------------------------------------------------------------
// Added by the engine/world agent (additive)
// ---------------------------------------------------------------------------
export { Constants } from "@babylonjs/core/Engines/constants";
export type { CharacterSurfaceInfo } from "@babylonjs/core/Physics/v2/characterController";
export { PhysicsShapeContainer } from "@babylonjs/core/Physics/v2/physicsShape";

// ---------------------------------------------------------------------------
// Added by the graphics-controller agent (additive)
// ---------------------------------------------------------------------------
export { TAARenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/taaRenderingPipeline";
export { FSR1RenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/fsr1RenderingPipeline";
export { MotionBlurPostProcess } from "@babylonjs/core/PostProcesses/motionBlurPostProcess";
export { DepthOfFieldEffectBlurLevel } from "@babylonjs/core/PostProcesses/depthOfFieldEffect";
export { PostProcess } from "@babylonjs/core/PostProcesses/postProcess";

// ---------------------------------------------------------------------------
// Added by the art / lighting agent (additive)
// ---------------------------------------------------------------------------
export { ClusteredLightContainer } from "@babylonjs/core/Lights/Clustered/clusteredLightContainer";
export { RectAreaLight } from "@babylonjs/core/Lights/rectAreaLight";

// Added by the workpieces agent (additive)
export { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";

// ---------------------------------------------------------------------------
// Added by the factory pools agent (additive)
// ---------------------------------------------------------------------------
export { CreateBoxVertexData } from "@babylonjs/core/Meshes/Builders/boxBuilder";
export { CreateCylinderVertexData } from "@babylonjs/core/Meshes/Builders/cylinderBuilder";

// Added by the factory life agent (additive)
export { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
