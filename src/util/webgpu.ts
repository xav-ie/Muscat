// Shared WebGPU plumbing.  Lazy device init + a small helper that runs a
// fragment shader over a fullscreen triangle and returns the rendered
// canvas.  Designed so terrain shaders can share one device/pipeline cache
// and reuse the same canvas-embedding flow used by the CPU rasterizers.

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

// Pipeline cache keyed by (device, shader source, target format).  Pipelines
// are size-agnostic — only canvas configuration is per-render — so a single
// pipeline serves every render of a given terrain.
const pipelineCache = new WeakMap<GPUDevice, Map<string, GPURenderPipeline>>();

function getPipeline(device: GPUDevice, wgsl: string, format: GPUTextureFormat): GPURenderPipeline {
  let cache = pipelineCache.get(device);
  if (!cache) {
    cache = new Map();
    pipelineCache.set(device, cache);
  }
  const key = `${format}::${wgsl}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const module = device.createShaderModule({ code: wgsl });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs_main" },
    fragment: { module, entryPoint: "fs_main", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
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
  uniforms: ArrayBuffer;
  // Optional read-only storage buffer bound at @group(0) @binding(1).
  // Use for variable-length arrays (seed lists, etc.) that don't fit
  // uniform alignment rules.
  storage?: ArrayBuffer;
}

// Run a fragment shader and return its canvas.  The returned canvas is an
// HTMLCanvasElement backed by a WebGPU context; `toDataURL` works on it
// the same way it works on a 2D canvas, so it slots into
// `embedCanvasAsImage` without changes.
export async function renderFragmentToCanvas(job: GpuFragmentJob): Promise<HTMLCanvasElement> {
  const device = await getGpuDevice();
  const canvas = document.createElement("canvas");
  canvas.width = job.width;
  canvas.height = job.height;
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("WebGPU canvas context unavailable.");
  const format: GPUTextureFormat = "rgba8unorm";
  context.configure({
    device,
    format,
    alphaMode: "opaque",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });

  const pipeline = getPipeline(device, job.wgsl, format);

  const uniformBuffer = device.createBuffer({
    size: job.uniforms.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(uniformBuffer, 0, job.uniforms);

  const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: uniformBuffer } }];
  if (job.storage) {
    const storageBuffer = device.createBuffer({
      size: job.storage.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(storageBuffer, 0, job.storage);
    entries.push({ binding: 1, resource: { buffer: storageBuffer } });
  }

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries,
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: context.getCurrentTexture().createView(),
        loadOp: "clear",
        clearValue: [0, 0, 0, 1],
        storeOp: "store",
      },
    ],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3, 1, 0, 0); // fullscreen triangle
  pass.end();
  device.queue.submit([encoder.finish()]);
  return canvas;
}
