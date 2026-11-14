// Original shader: three slow ribbons of light over a night sky.
// Pimi sets u_resolution, u_time, u_limit and u_light; u_base, u_ribbon_a and u_ribbon_b come from
// `uniforms` in index.client.ts. The last block is the legibility guard: no pixel is brighter
// than u_limit (dark themes) or darker than it (light themes), so text keeps its contrast.
precision highp float;

uniform vec2 u_resolution;
uniform float u_time;
uniform float u_limit;
uniform float u_light;
uniform vec3 u_base;
uniform vec3 u_ribbon_a;
uniform vec3 u_ribbon_b;

vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toSrgb(vec3 c) { return pow(max(c, vec3(0.0)), vec3(1.0 / 2.2)); }

float ribbon(vec2 p, float offset, float speed, float height) {
  float sway = sin(p.x * 2.3 + u_time * speed + offset) * 0.12
             + sin(p.x * 5.1 - u_time * speed * 0.7 + offset * 2.0) * 0.045;
  float d = p.y - (height + sway);
  float shimmer = 0.65 + 0.35 * sin(p.x * 3.0 + u_time * 0.25 + offset);
  return exp(-d * d * 38.0) * shimmer;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec2 p = vec2(uv.x * u_resolution.x / u_resolution.y, uv.y);

  vec3 color = toLinear(u_base) * (0.5 + 0.9 * uv.y);
  color += toLinear(u_ribbon_a) * ribbon(p, 0.0, 0.18, 0.66) * 1.3;
  color += toLinear(u_ribbon_b) * ribbon(p, 2.1, 0.13, 0.52) * 1.1;
  color += toLinear(u_ribbon_a) * ribbon(p, 4.2, 0.1, 0.78) * 0.7;

  float y = dot(color, vec3(0.2126, 0.7152, 0.0722));
  if (u_light < 0.5) {
    if (y > u_limit) color *= u_limit / y;
  } else if (y < u_limit) {
    color = mix(color, vec3(1.0), (u_limit - y) / (1.0 - y));
  }
  gl_FragColor = vec4(toSrgb(color), 1.0);
}
