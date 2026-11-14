// Original procedural shader (no third-party art). Six-plus layers of drifting swell lit from a
// moon at upper right. The final block is the legibility guard: no pixel exceeds the theme limit.
export const WAVES_FRAGMENT = `precision highp float;

uniform vec2 u_resolution; // drawing-buffer pixels of the whole viewport
uniform float u_time;      // seconds of running time
uniform float u_limit;     // luminance cap (dark) or floor (light), already scaled below the true limit
uniform float u_light;     // 0 = dark theme, 1 = light theme
uniform vec3 u_sky_top;
uniform vec3 u_sky_low;
uniform vec3 u_glow;
uniform vec3 u_far;
uniform vec3 u_near;
uniform vec3 u_crest;

const int LAYERS = 7;

float sq(float x) { return x * x; }

float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}

vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 toSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// Height of layer i at x (viewport heights). Skewed sines give steeper fronts than backs.
float surface(float x, float i, float t, out float amp) {
  float depth = i / float(LAYERS - 1);          // 0 far .. 1 near
  float d = pow(depth, 1.35);
  float base = mix(0.47, 0.035, d);             // perspective: far layers pile up near the horizon
  amp = mix(0.010, 0.080, d);
  float freq = mix(4.4, 1.15, d);
  float speed = mix(0.018, 0.060, depth);
  float phase = i * 2.39996;
  float drift = t * speed;
  float a1 = (x + drift) * freq + phase;
  float a2 = (x - drift * 0.6) * freq * 2.13 + phase * 1.7;
  float a3 = (x + drift * 1.4) * freq * 3.71 + phase * 0.6;
  float env = 0.72 + 0.28 * sin(x * 0.9 + phase * 2.0 + t * 0.03);
  float h = env * sin(a1 + 0.55 * sin(a1 * 0.5 + t * 0.05))
          + 0.42 * sin(a2)
          + 0.18 * sin(a3);
  float bob = mix(0.003, 0.009, depth) * sin(t * 0.21 + phase);   // the layer floats, period ~30 s
  return base + bob + amp * h;
}

void main() {
  vec2 pixel = gl_FragCoord.xy;
  float px = 1.0 / u_resolution.y;
  vec2 p = pixel * px;
  float aspect = u_resolution.x / u_resolution.y;

  vec3 cTop = toLinear(u_sky_top);
  vec3 cLow = toLinear(u_sky_low) * 0.5;
  vec3 cGlow = toLinear(u_glow) * 0.07;
  vec3 cFar = toLinear(u_far) * 0.45;
  vec3 cNear = toLinear(u_near) * 0.6;
  vec3 cCrest = toLinear(u_crest) * 0.30;

  // Light source: a soft moon low in the sky on the right.
  vec2 lamp = vec2(aspect * 0.80, 0.80);
  float lampX = lamp.x;

  // Sky: vertical wash, haze at the horizon, a broad halo and a small bright core around the lamp.
  float sky = smoothstep(0.30, 1.0, p.y);
  vec3 col = mix(cLow, cTop, sky);
  vec2 dl = p - lamp;
  float r2 = dot(dl, dl);
  col += cGlow * (0.75 * exp(-r2 * 3.2) + 0.55 * exp(-r2 * 38.0)) + cCrest * (3.0 * exp(-r2 * 2600.0) + 0.5 * exp(-r2 * 420.0));
  vec3 haze = mix(cLow, cGlow, 0.35);
  col += haze * 0.45 * exp(-sq((p.y - 0.46) * 5.0));

  for (int n = 0; n < LAYERS; n++) {
    float i = float(n);
    float depth = i / float(LAYERS - 1);
    float amp;
    float h = surface(p.x, i, u_time, amp);
    float e = 0.004;
    float amp2;
    float slope = (surface(p.x + e, i, u_time, amp2) - surface(p.x - e, i, u_time, amp2)) / (2.0 * e);
    float sl = clamp(slope / (amp * 3.2), -1.0, 1.0);
    float lit = smoothstep(-0.8, 0.8, -sl);              // faces the lamp (right)

    float below = h - p.y;                               // > 0 inside the wave
    float inside = smoothstep(-px, px, below);
    float bodyDepth = max(below, 0.0);
    float above = max(-below, 0.0);

    // Lamp reflection path: wide soft lift plus a narrow glitter column under the lamp.
    float wide = exp(-sq((p.x - lampX) / 0.55));
    float narrow = exp(-sq((p.x - lampX) / 0.16));
    float path = 0.28 + 0.72 * wide;
    float nearness = mix(0.35, 1.0, depth);

    // Glow halo spilling above the crest onto what lies behind.
    float halo = exp(-above * mix(120.0, 45.0, depth)) * (1.0 - inside);
    col += cCrest * halo * 0.5 * path * nearness;

    // Body: far water carries the horizon haze, near water is deep; light pools under lamp-facing crests.
    float tone = pow(depth, 0.8);
    vec3 top = mix(cFar, cNear * 2.0, tone);
    vec3 deep = mix(cNear * 1.5, cNear * 0.35, tone);
    vec3 body = mix(top, deep, smoothstep(0.0, 0.07 + 0.20 * depth, bodyDepth));
    float under = exp(-bodyDepth * mix(60.0, 22.0, depth));
    body += cGlow * under * (0.10 + 0.45 * lit) * nearness * (0.5 + 0.5 * path);

    // Rim light on the crest, broad sheen beneath it.
    float rim = exp(-bodyDepth * mix(420.0, 160.0, depth)) + 0.25 * exp(-bodyDepth * mix(90.0, 38.0, depth));
    float sheen = exp(-bodyDepth * 18.0);
    vec3 spec = cCrest * (rim * (0.35 + 0.9 * lit) * (0.35 + 0.9 * path) * nearness * 0.9 + sheen * 0.06 * lit * path);

    // Glitter on the crests under the lamp: slow interference of two sine trains, smooth and soft.
    float g = sin(p.x * 71.0 + u_time * (0.30 + 0.4 * depth) + i * 2.1)
            * sin(p.x * 29.0 - u_time * 0.21 + i * 4.7);
    float glint = pow(max(g, 0.0), 5.0) * exp(-bodyDepth * 520.0) * (0.25 * wide + 0.75 * narrow);
    spec += cCrest * glint * 5.0 * nearness;

    vec3 wave = body + spec;

    // Atmospheric depth: far layers dissolve into the haze.
    vec3 fog = mix(cLow, cGlow, 0.5) * 0.9;
    wave = mix(fog + (wave - fog) * 0.5, wave, smoothstep(0.0, 0.75, depth));
    // Contact shadow on the layer behind.
    col *= 1.0 - 0.35 * depth * exp(-above * 45.0) * (1.0 - inside);

    col = mix(col, wave, inside);
  }

  // Left side stays quieter: that is where the sidebar and the text column sit.
  col *= mix(0.62, 1.0, smoothstep(0.0, aspect * 0.75, p.x));
  // Gentle vignette.
  vec2 v = p / vec2(aspect, 1.0) - 0.5;
  col *= 1.0 - 0.35 * dot(v, v);

  // Legibility guard: text contrast is computed against u_limit, so no pixel may cross it.
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  if (u_light > 0.5) {
    col += (1.0 - col) * clamp((u_limit - lum) / max(1.0 - lum, 1e-4), 0.0, 1.0);
  } else {
    // Linear below the knee, asymptotic to the cap above it; hue is preserved.
    float k = 0.4 * u_limit;
    float mapped = lum < k ? lum : k + (u_limit - k) * (1.0 - exp(-(lum - k) / (u_limit - k)));
    col *= mapped / max(lum, 1e-6);
  }

  vec3 srgb = toSrgb(col);
  // Triangular-PDF dither, static: no banding in the dark ramps, no shimmer.
  float dn = hash(pixel) + hash(pixel + 71.7) - 1.0;
  srgb += dn / 255.0;
  gl_FragColor = vec4(srgb, 1.0);
}
`;
