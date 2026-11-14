import type { LiveBackdrop } from "./backdrops";

// The live backdrop is one WebGL canvas behind the whole window shell: every region of the app
// shows the same frame, so there is nothing to copy and no edge between regions.

const VERTEX = "attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}";
const MAX_WIDTH = 2560;
const MAX_HEIGHT = 1600;
/** The shader is smooth by design, so it renders below Retina density and the compositor upscales it. */
const MAX_SCALE = 1.25;
/** Fixed shader time for the single reduced-motion frame, and the start time of the animation. */
const START_TIME = 14;
/** Fraction of the theme's luminance limit the shader aims at, leaving margin for dither and rounding. */
const LIMIT_MARGIN = 0.85;
const SLOW_WINDOW_FRAMES = 120;
const SLOW_MEAN_MS = 20;
/** Sustained slow frames shrink the render buffer. The frame rate is never lowered. */
const SCALE_STEPS = [1, 0.75, 0.5625, 0.42];
const FRAME_MS = 16;
/** Longest time step accepted per frame, so a stall or resume never makes the waves jump. */
const MAX_STEP_S = 0.1;

interface Program {
  gl: WebGLRenderingContext;
  handle: WebGLProgram;
  resolution: WebGLUniformLocation | null;
  time: WebGLUniformLocation | null;
  limit: WebGLUniformLocation | null;
  light: WebGLUniformLocation | null;
}

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
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/**
 * Why this fragment source does not compile and link on this machine, or null when it does. Null
 * as well when WebGL is unavailable: there is nothing to check against, and nothing will draw.
 */
export function findFragmentProblem(source: string): string | null {
  const gl = document.createElement("canvas").getContext("webgl");
  if (!gl) return null;
  const vertex = gl.createShader(gl.VERTEX_SHADER);
  const fragment = gl.createShader(gl.FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) return "WebGL could not create a shader";
  gl.shaderSource(vertex, VERTEX);
  gl.compileShader(vertex);
  gl.shaderSource(fragment, source);
  gl.compileShader(fragment);
  let problem: string | null = null;
  if (!gl.getShaderParameter(fragment, gl.COMPILE_STATUS)) {
    problem = gl.getShaderInfoLog(fragment)?.trim() || "compile failed";
  } else {
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      problem = gl.getProgramInfoLog(program)?.trim() || "link failed";
    }
  }
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return problem;
}

function buildProgram(gl: WebGLRenderingContext, source: string): Program | null {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, source);
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
  return {
    gl,
    handle: program,
    resolution: at("u_resolution"),
    time: at("u_time"),
    limit: at("u_limit"),
    light: at("u_light"),
  };
}

class LiveBackdropEngine {
  private program: Program | null = null;
  private readonly observer: ResizeObserver;
  private readonly reducedMotion: MediaQueryList;
  private lost = false;

  private time = START_TIME;
  private rafId = 0;
  private lastTick = 0;
  private scaleStep = 0;
  private slowSum = 0;
  private slowCount = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private backdrop: LiveBackdrop,
  ) {
    // A resize is drawn inside the observer callback, before the frame paints: no stretched frame.
    this.observer = new ResizeObserver(() => this.render());
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  }

  /** Builds the context and draws the first frame before the canvas paints. */
  start(): void {
    // The buffer is preserved so the held frame survives while the loop is paused.
    const gl = this.canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
      powerPreference: "low-power",
    });
    this.program = gl ? buildProgram(gl, this.backdrop.fragment) : null;
    if (!this.program) {
      // No WebGL, or a shader that does not build: the shell's static CSS backdrop stays visible.
      this.canvas.style.visibility = "hidden";
      return;
    }
    this.canvas.addEventListener("webglcontextlost", this.onContextLost);
    this.canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    window.addEventListener("focus", this.sync);
    window.addEventListener("blur", this.sync);
    document.addEventListener("visibilitychange", this.sync);
    this.reducedMotion.addEventListener("change", this.onMotionChange);
    this.observer.observe(this.canvas);
    this.applyUniforms();
    this.render();
    this.sync();
  }

  stop(): void {
    this.pause();
    this.observer.disconnect();
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    window.removeEventListener("focus", this.sync);
    window.removeEventListener("blur", this.sync);
    document.removeEventListener("visibilitychange", this.sync);
    this.reducedMotion.removeEventListener("change", this.onMotionChange);
    this.program = null;
  }

  /** Switching between themes that share a shader only changes uniforms. */
  setBackdrop(backdrop: LiveBackdrop): void {
    if (this.backdrop === backdrop) return;
    const rebuild = backdrop.fragment !== this.backdrop.fragment;
    this.backdrop = backdrop;
    if (rebuild) {
      const program = this.program ? buildProgram(this.program.gl, backdrop.fragment) : null;
      if (!program) {
        this.pause();
        this.program = null;
        this.canvas.style.visibility = "hidden";
        return;
      }
      this.program = program;
    }
    this.applyUniforms();
    if (this.rafId === 0) this.render();
  }

  private applyUniforms(): void {
    const { program, backdrop } = this;
    if (!program) return;
    const { gl } = program;
    gl.uniform1f(program.limit, backdrop.limit * LIMIT_MARGIN);
    gl.uniform1f(program.light, backdrop.scheme === "light" ? 1 : 0);
    for (const [name, value] of Object.entries(backdrop.uniforms)) {
      const location = gl.getUniformLocation(program.handle, name);
      if (typeof value === "number") gl.uniform1f(location, value);
      else if (typeof value === "string") gl.uniform3f(location, ...parseHex(value));
      else if (value.length === 2) gl.uniform2f(location, value[0], value[1]);
      else if (value.length === 3) gl.uniform3f(location, value[0], value[1], value[2]);
      else gl.uniform4f(location, value[0], value[1], value[2], value[3]);
    }
  }

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.lost = true;
    this.program = null;
    this.pause();
    this.canvas.style.visibility = "hidden";
  };

  private readonly onContextRestored = (): void => {
    const gl = this.canvas.getContext("webgl");
    const program = gl ? buildProgram(gl, this.backdrop.fragment) : null;
    if (!program) return;
    this.lost = false;
    this.program = program;
    this.applyUniforms();
    this.render();
    this.canvas.style.visibility = "";
    this.sync();
  };

  /** Renders one frame at the current time. The buffer is resized only here, right before drawing. */
  private render(): void {
    const { program, canvas } = this;
    if (!program || this.lost) return;
    const viewWidth = canvas.clientWidth;
    const viewHeight = canvas.clientHeight;
    if (viewWidth < 1 || viewHeight < 1) return;
    const scale = Math.min(
      Math.min(window.devicePixelRatio || 1, MAX_SCALE) * SCALE_STEPS[this.scaleStep],
      MAX_WIDTH / viewWidth,
      MAX_HEIGHT / viewHeight,
    );
    const width = Math.max(Math.round(viewWidth * scale), 1);
    const height = Math.max(Math.round(viewHeight * scale), 1);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const { gl } = program;
    gl.viewport(0, 0, width, height);
    gl.uniform2f(program.resolution, width, height);
    gl.uniform1f(program.time, this.time);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private isRunning(): boolean {
    return (
      this.program !== null &&
      !this.lost &&
      !this.reducedMotion.matches &&
      document.visibilityState === "visible" &&
      document.hasFocus()
    );
  }

  /** Starts or stops the loop to match the pause rules. A paused canvas keeps its last frame. */
  private readonly sync = (): void => {
    if (!this.isRunning()) {
      this.pause();
      return;
    }
    if (this.rafId !== 0) return;
    this.lastTick = 0;
    this.slowSum = 0;
    this.slowCount = 0;
    this.rafId = requestAnimationFrame(this.tick);
  };

  private pause(): void {
    if (this.rafId !== 0) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private readonly tick = (now: number): void => {
    this.rafId = 0;
    if (!this.isRunning()) return;
    this.rafId = requestAnimationFrame(this.tick);
    if (this.lastTick === 0) {
      this.lastTick = now;
      return;
    }
    const elapsed = now - this.lastTick;
    // ProMotion delivers 120 Hz callbacks: draw on every other one.
    if (elapsed < FRAME_MS - 1) return;
    this.lastTick = now;
    // Time follows the clock, so a late frame moves the water further instead of slowing it.
    this.time += Math.min(elapsed / 1000, MAX_STEP_S);
    this.trackFrameTime(elapsed);
    this.render();
  };

  private trackFrameTime(interval: number): void {
    if (this.scaleStep === SCALE_STEPS.length - 1) return;
    this.slowSum += interval;
    this.slowCount += 1;
    if (this.slowCount < SLOW_WINDOW_FRAMES) return;
    const mean = this.slowSum / this.slowCount;
    this.slowSum = 0;
    this.slowCount = 0;
    if (mean > SLOW_MEAN_MS) this.scaleStep += 1;
  }

  private readonly onMotionChange = (): void => {
    if (this.reducedMotion.matches) {
      this.time = START_TIME;
      this.pause();
      this.render();
      return;
    }
    this.sync();
  };
}

const engines = new WeakMap<HTMLCanvasElement, LiveBackdropEngine>();

export function attachLiveBackdrop(canvas: HTMLCanvasElement, backdrop: LiveBackdrop): void {
  const existing = engines.get(canvas);
  if (existing) {
    existing.setBackdrop(backdrop);
    return;
  }
  const engine = new LiveBackdropEngine(canvas, backdrop);
  engines.set(canvas, engine);
  engine.start();
}

export function detachLiveBackdrop(canvas: HTMLCanvasElement): void {
  engines.get(canvas)?.stop();
  engines.delete(canvas);
}
