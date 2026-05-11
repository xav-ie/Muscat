// Shared WebGPU plumbing.  Lazy device init + helpers for two flavors:
//   * `renderFragmentToCanvas` — one fullscreen-triangle fragment shader
//     (lava, water).
//   * `renderMultiDrawToCanvas` — multiple instanced draws in one render
//     pass (grass).  Each draw can have its own shader, topology, and
//     uniform/storage buffers.

let devicePromise: Promise<GPUDevice> | undefined;

// Returns the shared GPUDevice, initializing it on first call.  Throws if
// the browser doesn't expose WebGPU or no adapter is available — callers
// treat both as hard errors rather than silently degrading.
function getGpuDevice(): Promise<GPUDevice> {
  devicePromise ??= (async () => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!navigator.gpu) {
      throw new Error(
        "WebGPU not available — needs a modern browser (Firefox 141+, Chrome 113+, Safari 18+).",
      );
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("WebGPU adapter unavailable on this device.");
    return adapter.requestDevice();
  })();
  return devicePromise;
}

// 4x MSAA is applied to every render so triangle edges and instanced
// quads get the same anti-aliasing Canvas2D paths had.  Each render
// allocates a multisampled render-target texture and resolves it to the
// canvas's swap-chain texture at the end of the pass.
const SAMPLE_COUNT = 4;

// Pipeline cache keyed by (device, shader source, target format, topology).
// Pipelines are size-agnostic — only canvas configuration is per-render —
// so each unique (shader, topology) combo gets cached and reused.
const pipelineCache = new WeakMap<GPUDevice, Map<string, GPURenderPipeline>>();

function deviceCache(device: GPUDevice): Map<string, GPURenderPipeline> {
  const existing = pipelineCache.get(device);
  if (existing) return existing;
  const fresh = new Map<string, GPURenderPipeline>();
  pipelineCache.set(device, fresh);
  return fresh;
}

function blendedTarget(format: GPUTextureFormat): GPUColorTargetState {
  return {
    format,
    blend: {
      color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    },
  };
}

function getPipeline(
  device: GPUDevice,
  wgsl: string,
  format: GPUTextureFormat,
  topology: GPUPrimitiveTopology,
  alphaBlend: boolean,
): GPURenderPipeline {
  const cache = deviceCache(device);
  const key = `${format}::${topology}::${alphaBlend ? "blend" : "opaque"}::${wgsl}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const module = device.createShaderModule({ code: wgsl });
  const target: GPUColorTargetState = alphaBlend ? blendedTarget(format) : { format };
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs_main" },
    fragment: { module, entryPoint: "fs_main", targets: [target] },
    primitive: { topology },
    multisample: { count: SAMPLE_COUNT },
  });
  cache.set(key, pipeline);
  return pipeline;
}

export interface GpuFragmentJob {
  width: number;
  height: number;
  // WGSL source containing a vs_main and fs_main entry point.  vs_main
  // should emit a fullscreen triangle (3 vertices).  fs_main writes the
  // final color.
  wgsl: string;
  // Raw uniform bytes bound at @group(0) @binding(0).  Caller is
  // responsible for std140/std430-style layout matching the shader struct.
  uniforms: BufferSource;
  // Optional read-only storage buffer bound at @group(0) @binding(1).
  // Use for variable-length arrays (seed lists, etc.) that don't fit
  // uniform alignment rules.
  storage?: BufferSource;
}

// Run a fragment shader and return its canvas.  The returned canvas is an
// HTMLCanvasElement backed by a WebGPU context; `toDataURL` works on it
// the same way it works on a 2D canvas, so it slots into
// `embedCanvasAsImage` without changes.
export async function renderFragmentToCanvas(job: GpuFragmentJob): Promise<HTMLCanvasElement> {
  const device = await getGpuDevice();
  const { canvas, context, msaaView } = configureCanvas(device, job.width, job.height);
  const pipeline = getPipeline(device, job.wgsl, "rgba8unorm", "triangle-list", false);
  const bindGroup = createBindGroup(device, pipeline, job.uniforms, job.storage);

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: msaaView,
        resolveTarget: context.getCurrentTexture().createView(),
        loadOp: "clear",
        clearValue: [0, 0, 0, 1],
        storeOp: "discard",
      },
    ],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3, 1, 0, 0);
  pass.end();
  device.queue.submit([encoder.finish()]);
  return canvas;
}

// One draw within a multi-draw pass.  Each draw has its own pipeline
// (selected by shader + topology) and bind group.
export interface GpuDraw {
  wgsl: string;
  topology?: GPUPrimitiveTopology;
  // SDF-style draws that `discard` outside-pixel fragments need alpha
  // blending so the discard reveals what's already on the framebuffer
  // instead of leaving a transparent hole.
  alphaBlend?: boolean;
  uniforms: BufferSource;
  storage?: BufferSource;
  vertexCount: number;
  instanceCount?: number;
}

export interface GpuMultiDrawJob {
  width: number;
  height: number;
  // Clear color applied at the start of the render pass.  Defaults to opaque
  // black if omitted.
  clearColor?: [number, number, number, number];
  draws: GpuDraw[];
}

function encodeDraw(device: GPUDevice, pass: GPURenderPassEncoder, draw: GpuDraw): void {
  const pipeline = getPipeline(
    device,
    draw.wgsl,
    "rgba8unorm",
    draw.topology ?? "triangle-list",
    draw.alphaBlend ?? false,
  );
  const bindGroup = createBindGroup(device, pipeline, draw.uniforms, draw.storage);
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(draw.vertexCount, draw.instanceCount ?? 1, 0, 0);
}

// Run multiple instanced draws within a single render pass and return the
// rendered canvas.  Draws execute in array order — primitives from later
// draws layer over earlier ones, no depth test.
export async function renderMultiDrawToCanvas(job: GpuMultiDrawJob): Promise<HTMLCanvasElement> {
  const device = await getGpuDevice();
  const { canvas, context, msaaView } = configureCanvas(device, job.width, job.height);

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: msaaView,
        resolveTarget: context.getCurrentTexture().createView(),
        loadOp: "clear",
        clearValue: job.clearColor ?? [0, 0, 0, 1],
        storeOp: "discard",
      },
    ],
  });
  for (const draw of job.draws) encodeDraw(device, pass, draw);
  pass.end();
  device.queue.submit([encoder.finish()]);
  return canvas;
}

interface ConfiguredCanvas {
  canvas: HTMLCanvasElement;
  context: GPUCanvasContext;
  msaaView: GPUTextureView;
}

function configureCanvas(device: GPUDevice, width: number, height: number): ConfiguredCanvas {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("WebGPU canvas context unavailable.");
  context.configure({
    device,
    format: "rgba8unorm",
    alphaMode: "opaque",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  // Multisampled render-target texture — pipelines render to this 4x
  // texture; the render pass resolves it down to the canvas's swap-chain
  // texture so `toDataURL` reads anti-aliased pixels.
  const msaa = device.createTexture({
    size: { width, height },
    format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
    sampleCount: SAMPLE_COUNT,
  });
  return { canvas, context, msaaView: msaa.createView() };
}

function createBindGroup(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  uniforms: BufferSource,
  storage: BufferSource | undefined,
): GPUBindGroup {
  const uniformBuffer = device.createBuffer({
    size: uniforms.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(uniformBuffer, 0, uniforms);
  const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: uniformBuffer } }];
  if (storage) {
    const storageBuffer = device.createBuffer({
      size: storage.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(storageBuffer, 0, storage);
    entries.push({ binding: 1, resource: { buffer: storageBuffer } });
  }
  return device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries,
  });
}
