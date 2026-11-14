import type { LiveBackdrop } from "./backdrops";
import { WAVES_FRAGMENT } from "./waves.frag";

// One WebGL context renders the whole viewport; every visible backdrop container shows its own
// crop of that frame through a 2D canvas. The engine is a module singleton so it outlives screens:
// a freshly mounted target is filled from the last frame before it paints (no flash on navigation).

const VERTEX = "attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}";
const MAX_WIDTH = 2560;
const MAX_HEIGHT = 1600;
/** The shader is smooth by design, so it renders below Retina density and is upscaled by the copy. */
const MAX_SCALE = 1.25;
/** Fixed shader time for the single reduced-motion frame, and the start time of the animation. */
const START_TIME = 14;
/** Fraction of the theme's luminance limit the shader aims at, leaving margin for dither and rounding. */
const LIMIT_MARGIN = 0.85;
const IDLE_RELEASE_MS = 30_000;
const SLOW_WINDOW_FRAMES = 120;
const SLOW_MEAN_MS = 20;
const SCALE_STEPS = [1, 0.75, 0.5625];
const FRAME_MS_60 = 16;
const FRAME_MS_30 = 33;
/** Longest time step accepted per frame, so a stall or resume never makes the waves jump. */
const MAX_STEP_S = 0.1;

interface Program {
  gl: WebGLRenderingContext;
  resolution: WebGLUniformLocation | null;
  time: WebGLUniformLocation | null;
  limit: WebGLUniformLocation | null;
  light: WebGLUniformLocation | null;
  colors: Record<keyof LiveBackdrop["colors"], WebGLUniformLocation | null>;
}

const COLOR_UNIFORMS: Record<keyof LiveBackdrop["colors"], string> = {
  skyTop: "u_sky_top",
  skyLow: "u_sky_low",
  glow: "u_glow",
  far: "u_far",
  near: "u_near",
  crest: "u_crest",
};

function parseHex(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error("[live-backdrop] shader compile failed", gl.getShaderInfoLog(shader));
    return null;
  }
  return shader;
}

function buildProgram(gl: WebGLRenderingContext): Program | null {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, WAVES_FRAGMENT);
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.bindAttribLocation(program, 0, "a");
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error("[live-backdrop] program link failed", gl.getProgramInfoLog(program));
    return null;
  }
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const at = (name: string) => gl.getUniformLocation(program, name);
  const colors = {} as Program["colors"];
  for (const key of Object.keys(COLOR_UNIFORMS) as (keyof typeof COLOR_UNIFORMS)[]) {
    colors[key] = at(COLOR_UNIFORMS[key]);
  }
  return {
    gl,
    resolution: at("u_resolution"),
    time: at("u_time"),
    limit: at("u_limit"),
    light: at("u_light"),
    colors,
  };
}

class LiveBackdropEngine {
  private glCanvas: HTMLCanvasElement | null = null;
  private program: Program | null = null;
  private readonly targets = new Set<HTMLCanvasElement>();
  private readonly contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
  private readonly observer: ResizeObserver;
  private backdrop: LiveBackdrop | null = null;
  private lost = false;
  private failed = false;
  private hasFrame = false;

  private time = START_TIME;
  private rafId = 0;
  private lastTick = 0;
  private lastRender = 0;
  private scaleStep = 0;
  private minInterval = FRAME_MS_60;
  private slowSum = 0;
  private slowCount = 0;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private reducedMotion: MediaQueryList;
  private listening = false;

  constructor() {
    this.observer = new ResizeObserver(() => this.invalidate());
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  }

  attach(target: HTMLCanvasElement, backdrop: LiveBackdrop): void {
    this.cancelRelease();
    this.targets.add(target);
    this.observer.observe(target);
    this.listen();
    this.setBackdrop(backdrop);
    if (!this.ensureContext()) return;
    if (this.lost) {
      target.style.visibility = "hidden";
      return;
    }
    // Fill the new target from the last frame before it paints. The very first frame is rendered here.
    if (!this.hasFrame) this.render();
    else this.paint(target);
    this.sync();
  }

  detach(target: HTMLCanvasElement): void {
    this.targets.delete(target);
    this.observer.unobserve(target);
    if (this.targets.size === 0) {
      this.stop();
      this.scheduleRelease();
    }
  }

  private setBackdrop(backdrop: LiveBackdrop): void {
    if (this.backdrop === backdrop) return;
    this.backdrop = backdrop;
    this.applyUniforms();
    // Switching between live themes only changes uniforms; repaint the held frame.
    if (this.hasFrame) this.invalidate();
  }

  private applyUniforms(): void {
    const { program, backdrop } = this;
    if (!program || !backdrop) return;
    const { gl } = program;
    gl.uniform1f(program.limit, backdrop.limit * LIMIT_MARGIN);
    gl.uniform1f(program.light, backdrop.scheme === "light" ? 1 : 0);
    for (const key of Object.keys(COLOR_UNIFORMS) as (keyof typeof COLOR_UNIFORMS)[]) {
      const [r, g, b] = parseHex(backdrop.colors[key]);
      gl.uniform3f(program.colors[key], r, g, b);
    }
  }

  private ensureContext(): boolean {
    if (this.program || this.lost) return !this.failed;
    if (this.failed) return false;
    const canvas = this.glCanvas ?? document.createElement("canvas");
    this.glCanvas = canvas;
    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
      powerPreference: "low-power",
    });
    const program = gl ? buildProgram(gl) : null;
    if (!program) {
      this.failed = true;
      this.glCanvas = null;
      return false;
    }
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    this.program = program;
    this.hasFrame = false;
    this.applyUniforms();
    return true;
  }

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.lost = true;
    this.program = null;
    this.hasFrame = false;
    this.stop();
    for (const target of this.targets) target.style.visibility = "hidden";
  };

  private readonly onContextRestored = (): void => {
    this.lost = false;
    const canvas = this.glCanvas;
    const gl = canvas?.getContext("webgl");
    const program = gl ? buildProgram(gl) : null;
    if (!program) {
      this.failed = true;
      return;
    }
    this.program = program;
    this.applyUniforms();
    this.render();
    for (const target of this.targets) target.style.visibility = "";
    this.sync();
  };

  private renderScale(viewWidth: number, viewHeight: number): number {
    const base = Math.min(window.devicePixelRatio || 1, MAX_SCALE) * SCALE_STEPS[this.scaleStep];
    return Math.min(base, MAX_WIDTH / viewWidth, MAX_HEIGHT / viewHeight);
  }

  /** Renders one frame at the current time and copies it into every visible target. */
  private render(): void {
    const { program, glCanvas } = this;
    if (!program || !glCanvas || this.lost) return;
    const viewWidth = Math.max(window.innerWidth, 1);
    const viewHeight = Math.max(window.innerHeight, 1);
    const scale = this.renderScale(viewWidth, viewHeight);
    const width = Math.max(Math.round(viewWidth * scale), 1);
    const height = Math.max(Math.round(viewHeight * scale), 1);
    const { gl } = program;
    if (glCanvas.width !== width || glCanvas.height !== height) {
      glCanvas.width = width;
      glCanvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.uniform2f(program.resolution, width, height);
    gl.uniform1f(program.time, this.time);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.hasFrame = true;
    for (const target of this.targets) this.paint(target);
  }

  /** Copies this target's crop of the last frame into it. A resize happens only here, right before drawing. */
  private paint(target: HTMLCanvasElement): void {
    const { glCanvas } = this;
    if (!glCanvas || !this.hasFrame) return;
    const rect = target.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const sx = glCanvas.width / Math.max(window.innerWidth, 1);
    const sy = glCanvas.height / Math.max(window.innerHeight, 1);
    const width = Math.max(Math.round(rect.width * sx), 1);
    const height = Math.max(Math.round(rect.height * sy), 1);
    let ctx = this.contexts.get(target);
    if (!ctx) {
      const created = target.getContext("2d", { alpha: false });
      if (!created) return;
      ctx = created;
      this.contexts.set(target, ctx);
    }
    if (target.width !== width || target.height !== height) {
      target.width = width;
      target.height = height;
    }
    ctx.drawImage(
      glCanvas,
      rect.left * sx,
      rect.top * sy,
      rect.width * sx,
      rect.height * sy,
      0,
      0,
      width,
      height,
    );
  }

  /** Repaints the held frame (resize, theme change) without advancing time, when the loop is not running. */
  private invalidate(): void {
    if (this.rafId !== 0 || this.lost || !this.program) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      if (this.isRunning()) return;
      this.render();
    });
  }

  private isRunning(): boolean {
    return (
      this.targets.size > 0 &&
      !this.lost &&
      !this.reducedMotion.matches &&
      document.visibilityState === "visible" &&
      document.hasFocus()
    );
  }

  /** Starts or stops the loop to match the pause rules. */
  private sync = (): void => {
    if (this.isRunning()) this.start();
    else this.stop();
  };

  private start(): void {
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.lastTick = 0;
    this.lastRender = 0;
    this.slowSum = 0;
    this.slowCount = 0;
    this.rafId = requestAnimationFrame(this.tick);
  }

  private stop(): void {
    if (this.rafId !== 0) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private readonly tick = (now: number): void => {
    this.rafId = 0;
    if (!this.isRunning()) return;
    // ProMotion delivers 120 Hz callbacks: skip the ones that arrive before the frame budget.
    if (this.lastRender !== 0 && now - this.lastRender < this.minInterval - 1) {
      this.rafId = requestAnimationFrame(this.tick);
      return;
    }
    if (this.lastTick !== 0) {
      this.time += Math.min((now - this.lastTick) / 1000, MAX_STEP_S);
    }
    this.lastTick = now;
    if (this.lastRender !== 0) this.trackFrameTime(now - this.lastRender);
    this.lastRender = now;
    this.render();
    this.rafId = requestAnimationFrame(this.tick);
  };

  /** Sustained slow frames: shrink the render buffer twice, then fall back to 30 fps. */
  private trackFrameTime(interval: number): void {
    if (this.minInterval === FRAME_MS_30) return;
    this.slowSum += interval;
    this.slowCount += 1;
    if (this.slowCount < SLOW_WINDOW_FRAMES) return;
    const mean = this.slowSum / this.slowCount;
    this.slowSum = 0;
    this.slowCount = 0;
    if (mean <= SLOW_MEAN_MS) return;
    if (this.scaleStep < SCALE_STEPS.length - 1) this.scaleStep += 1;
    else this.minInterval = FRAME_MS_30;
  }

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener("focus", this.sync);
    window.addEventListener("blur", this.sync);
    window.addEventListener("resize", this.onResize);
    document.addEventListener("visibilitychange", this.sync);
    this.reducedMotion.addEventListener("change", this.onMotionChange);
  }

  private unlisten(): void {
    if (!this.listening) return;
    this.listening = false;
    window.removeEventListener("focus", this.sync);
    window.removeEventListener("blur", this.sync);
    window.removeEventListener("resize", this.onResize);
    document.removeEventListener("visibilitychange", this.sync);
    this.reducedMotion.removeEventListener("change", this.onMotionChange);
  }

  private readonly onResize = (): void => {
    if (!this.isRunning()) this.invalidate();
  };

  private readonly onMotionChange = (): void => {
    if (this.reducedMotion.matches) this.time = START_TIME;
    this.sync();
    if (!this.isRunning()) this.invalidate();
  };

  private cancelRelease(): void {
    if (this.releaseTimer !== null) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
  }

  private scheduleRelease(): void {
    this.cancelRelease();
    this.releaseTimer = setTimeout(() => this.release(), IDLE_RELEASE_MS);
  }

  /** After 30 s with no targets, give the GPU context back. The next attach rebuilds it. */
  private release(): void {
    this.releaseTimer = null;
    if (this.targets.size > 0) return;
    this.unlisten();
    const canvas = this.glCanvas;
    if (canvas) {
      canvas.removeEventListener("webglcontextlost", this.onContextLost);
      canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
      this.program?.gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    this.program = null;
    this.glCanvas = null;
    this.hasFrame = false;
  }
}

let engine: LiveBackdropEngine | null = null;

export function attachLiveBackdrop(target: HTMLCanvasElement, backdrop: LiveBackdrop): void {
  engine ??= new LiveBackdropEngine();
  engine.attach(target, backdrop);
}

export function detachLiveBackdrop(target: HTMLCanvasElement): void {
  engine?.detach(target);
}
