precision mediump float;
/** @resolution */
uniform vec2 u_resolution;
/** @label Backdrop @mipmap */
uniform sampler2D u_background;
/** @label Corner radius @default 16 @range 0, 40 */
uniform float u_radius;
/** @label Refraction @default 6 @range 0, 18 */
uniform float u_refraction;
/** @label Tint @color @default #9CCBFF */
uniform vec3 u_tint;
/** @label Tint strength @default 0.14 @range 0, 1 */
uniform float u_tintAmount;
/** @label Rim light @default 0.22 @range 0, 1 */
uniform float u_shine;
float shape(vec2 p) {
  float r = min(u_radius, min(u_resolution.x, u_resolution.y)*0.5);
  vec2 q = abs(p) - u_resolution*0.5 + r;
  return length(max(q,0.0)) + min(max(q.x,q.y),0.0) - r;
}
void main() {
  vec2 uv = gl_FragCoord.xy/u_resolution;
  vec2 p = gl_FragCoord.xy-u_resolution*0.5;
  float d = shape(p);
  vec2 n = normalize(vec2(shape(p+vec2(0.5,0.0))-shape(p-vec2(0.5,0.0)),shape(p+vec2(0.0,0.5))-shape(p-vec2(0.0,0.5)))+vec2(0.0001));
  float edge = 1.0-smoothstep(0.0,11.0,-d);
  vec2 ray = uv-n*edge*edge*u_refraction/u_resolution;
  vec2 soft = vec2(0.5)/u_resolution;
  vec3 color = texture2D(u_background,ray).rgb*0.6;
  color += texture2D(u_background,ray+soft).rgb*0.2;
  color += texture2D(u_background,ray-soft).rgb*0.2;
  color = mix(color,u_tint,u_tintAmount);
  float top = pow(max(0.0,dot(n,normalize(vec2(-0.5,0.86)))),3.0);
  float rim = exp(-abs(d+1.0)*0.75);
  color += vec3(rim*top*u_shine);
  color += vec3(0.025,0.04,0.065)*edge;
  color -= vec3(rim*(1.0-top)*0.025);
  float caustic = exp(-abs(d+5.0)*0.55)*pow(max(0.0,dot(n,normalize(vec2(0.5,-0.86)))),4.0);
  color += vec3(0.65,0.8,1.0)*caustic*u_shine*0.22;
  gl_FragColor = vec4(clamp(color,0.0,1.0),1.0);
}