// GLSL for the piece (WebGL2, GLSL ES 3.00). Written for this site.

const NOISE = /* glsl */ `
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3. - 2. * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y); }
float fbm(vec2 p){ float a = .5, s = 0.; mat2 r = mat2(.8, .6, -.6, .8); for (int i = 0; i < FBM_OCT; i++){ s += a * vnoise(p); p = r * p * 2.03 + 1.7; a *= .5; } return s; }
`;

// The film every screen plays: the app's contour map, flowing, lit in the brand's colours, with the playhead
// sweeping across it. A screen at wall position w that is `t` seconds into the film shows film(w, t); a screen
// that is late shows an earlier t, so the bands and the playhead break at its edges.
const FILM = /* glsl */ `
const vec3 GROUND = vec3(.027, .016, .059);
const vec3 CYAN = vec3(0., .94, 1.);
const vec3 PINK = vec3(1., .165, .427);
const vec3 VIOLET = vec3(.706, .298, 1.);
uniform float uFilmHue, uCalm;
vec3 ramp(float x){
  x = clamp(x, 0., 1.);
  vec3 a = mix(GROUND, vec3(.13, .04, .27), smoothstep(.0, .3, x));
  a = mix(a, vec3(.33, .2, .78) * .8, smoothstep(.3, .5, x));
  a = mix(a, VIOLET * .8, smoothstep(.5, .62, x));
  a = mix(a, PINK * .95, smoothstep(.62, .74, x));
  a = mix(a, vec3(1., .62, .78), smoothstep(.7, .86, x));
  return mix(a, CYAN * 1.1, smoothstep(.86, 1., x));
}
vec3 film(vec2 w, float t){
  vec2 q = w * .0105;
  float tt = t * .038;
  vec2 o = vec2(fbm(q + vec2(0., tt)), fbm(q * 1.1 + vec2(5.2, 1.3) - vec2(tt * .7, 0.)));
  float f = fbm(q * 1.35 + o * 1.9 + vec2(tt * 1.4, -tt * .5));
  // a colour field through the brand's palette, slowly breathing
  float x = f * 1.1 - .3 + (o.x - .5) * .55 + .08 * sin(t * .21 + w.y * .01);
  vec3 c = ramp(x) * (.45 + .55 * smoothstep(.25, .8, o.y));
  // wide regions lean cool or warm, so the wall is not one colour
  float region = fbm(w * .0042 + vec2(3.1, t * .012));
  vec3 cool = vec3(.22 * c.r, .5 * c.g + .5 * c.b + .15 * c.r, c.b * .95 + .3 * c.r);
  c = mix(c, cool, smoothstep(.36, .58, region) * .85);
  // the contour map: thin bright lines, every fourth one stronger, drifting with time
  float k = f * 18. - t * .38;
  float fw = max(fwidth(k), 1e-4);
  float line = 1. - smoothstep(0., 1.3 * fw, abs(fract(k + .5) - .5));
  float major = 1. - smoothstep(0., 2. * fw, abs(fract(k * .25 + .5) - .5) * 4.);
  // calm (at the end, under the mark): the lines fade to a whisper and the playhead stops sweeping
  float lk = 1. - .85 * uCalm;
  c = mix(c, vec3(.82, .9, 1.) * 1.25, line * (.35 + .4 * smoothstep(.3, .7, f)) * lk);
  c += mix(CYAN, vec3(1.), .25) * major * .7 * lk;
  // a slow light travelling over the map
  vec2 lp = vec2(sin(t * .23) * 110., cos(t * .17) * 55.);
  c += mix(PINK, VIOLET, .5 + .5 * sin(t * .3)) * exp(-length(w - lp) * .02) * .6 * uFilmHue;
  // the playhead, and the late slice a step behind it
  float span = 330.;
  float px = mod(t * 26. + span * .5, span) - span * .5;
  float d = abs(w.x - px);
  c += CYAN * (exp(-d * 1.4) * 3.2 + exp(-d * .07) * .22) * (1. - uCalm);
  float d2 = abs(w.x - px + 9.);
  c += PINK * exp(-d2 * 2.4) * .9 * (1. - uCalm);
  return c;
}
`;

const TILE_COMMON = /* glsl */ `
uniform highp sampler2D uTiles;
uniform float uTime, uAssemble, uMerge, uOut, uHostGone, uWaveT, uWaveAmp, uJoin, uFill;
uniform float uArrive[8];
uniform vec2 uWaveO;
const vec3 AD[8] = vec3[8](vec3(0.), vec3(1., .25, -.3), vec3(-1., .55, -.2), vec3(.2, -1., -.4), vec3(-.8, -.7, .1), vec3(.9, .9, -.5), vec3(-1., -.1, .4), vec3(.3, 1., .2));
vec4 T(int i, int k){ return texelFetch(uTiles, ivec2(k, i), 0); }
mat3 rot(vec3 a){ vec3 s = sin(a), c = cos(a);
  mat3 rx = mat3(1, 0, 0, 0, c.x, s.x, 0, -s.x, c.x), ry = mat3(c.y, 0, -s.y, 0, 1, 0, s.y, 0, c.y), rz = mat3(c.z, s.z, 0, -s.z, c.z, 0, 0, 0, 1);
  return rz * ry * rx; }
struct Tile { vec3 c; vec2 hs; mat3 R; vec4 rect; float role, delay, off, flags, cut, seed, a, scale, wave, join, fill, fillT, arrive; };
Tile tile(int i){
  vec4 r0 = T(i, 0), r1 = T(i, 1), r2 = T(i, 2), r3 = T(i, 3), r4 = T(i, 4);
  Tile t;
  // the invite reaches each screen in turn; the film reaches it later, streamed from the host's screen
  t.join = smoothstep(r4.x - .015, r4.x + .04, uJoin);
  t.fillT = r4.y;
  t.fill = smoothstep(0., 1., clamp((uFill - r4.y) / .07, 0., 1.));
  t.role = r3.x; t.delay = r3.y; t.off = r3.z; t.flags = floor(r3.w + .001); t.cut = floor(fract(r3.w) * 10. + .5); t.seed = r2.w;
  t.rect = mix(r0, r1, t.role > .5 ? uMerge : 0.);
  float a = clamp(uAssemble * 1.8 - t.delay * .8, 0., 1.); a = a * a * (3. - 2. * a);
  t.a = a;
  float s = 1. - a, k = a * s * 60.;
  vec3 wall = vec3(t.rect.xy, 0.);
  vec3 sc = r2.xyz;
  vec3 swirl = vec3(sin(t.seed * 12.1 + uTime * .3), cos(t.seed * 7.3 + uTime * .27), sin(t.seed * 3.1 + uTime * .2)) * k;
  vec3 drift = vec3(sin(uTime * .12 + t.seed * 40.), cos(uTime * .1 + t.seed * 31.), 0.) * s * 3.;
  t.c = vec3(mix(sc.xy, wall.xy, a), sc.z * s) + swirl + drift;
  vec3 ang = (vec3(fract(t.seed * 13.7), fract(t.seed * 71.3), fract(t.seed * 29.1)) - .5) * vec3(2.6, 2.6, 1.2) * s
           + vec3(sin(uTime * .16 + t.seed * 9.), cos(uTime * .13 + t.seed * 5.), 0.) * .12 * s;
  t.scale = 1. + s * (fract(t.seed * 3.7) * .9 - .25);
  if (t.flags >= 3.) t.scale *= 1. + 2.2 * s; // the eight friends' screens are bigger while scattered, so they read as devices
  // the room's wave after the host leaves: a ripple out from where they were
  float age = uTime - uWaveT;
  t.wave = 0.;
  if (age > 0. && age < 8. && uWaveAmp > 0.){
    float d = length(t.rect.xy - uWaveO);
    float ph = d * .09 - age * 4.2;
    float env = exp(-age * .45) * smoothstep(0., .5, age) * exp(-abs(ph) * .5) * uWaveAmp;
    t.c.z += sin(ph) * 9. * env * a;
    ang.x += cos(ph) * .35 * env * a;
    t.wave = sin(ph) * env * a;
  }
  // the field leaves at the end: each screen falls back and shrinks
  if (t.role < .5){
    float o = clamp(uOut * 1.7 - fract(t.seed * 5.3) * .7, 0., 1.); o = o * o;
    t.c.z -= o * 260.; t.scale *= 1. - o;
  }
  // the host leaves: their screen comes off the wall and passes the viewer
  if (t.flags == 3.){
    float g = uHostGone;
    t.c.z += g * g * 420.; t.c.y += g * g * 30.;
    ang += vec3(g * 1.4, g * 2.2, g * .6);
    t.scale *= 1. + g * 1.5;
  }
  // the host is there from the start and has the film; the friends fly in from far away, each from its side
  t.arrive = 1.;
  if (t.flags == 3.) { t.join = 1.; t.fill = 1.; }
  else if (t.flags > 3.) {
    int k = int(t.flags) - 3; float r = 1. - uArrive[k]; t.arrive = uArrive[k];
    t.c += AD[k] * vec3(520., 520., 300.) * r * r;
    ang += vec3(1.2, -.8, .5) * r;
    t.join = uArrive[k];
  }
  t.R = rot(ang);
  t.hs = t.rect.zw * .5;
  return t;
}
`;

export const TILE_VS = /* glsl */ `#version 300 es
precision highp float;
#define FBM_OCT 1
${TILE_COMMON}
uniform mat4 uVP;
uniform sampler2D uFluid;
uniform float uDesync, uFluidK, uFrag, uBuffer;
uniform vec3 uHostPos;
layout(location = 0) in vec2 aCorner;
out vec2 vLocal; out vec2 vWall; out vec2 vHs;
flat out float vOff; flat out float vRole; flat out float vFlags; flat out float vCut; flat out float vA; flat out float vWave;
flat out float vJoin; flat out float vFill; flat out float vLate; flat out float vFragU;
out float vDepth; out float vSeed;
void main(){
  Tile t = tile(gl_InstanceID);
  vec4 pc = uVP * vec4(t.c, 1.);
  // the pointer is a late station: the screens it passes slip out of time and fall back into phase behind it
  vec2 suv = clamp(pc.xy / max(pc.w, 1e-3) * .5 + .5, 0., 1.);
  float lateF = clamp(texture(uFluid, suv).x * uFluidK, 0., 1.) * t.fill;
  vec3 c = t.c + vec3(0., 0., lateF * 4.);
  vFragU = -1.;
  if (uFrag > .5) {
    // the film streaming out from the one screen that has it: a fragment flies to each screen just before it fills
    float u = clamp((uFill - (t.fillT - .1)) / .1, 0., 1.);
    if (u <= 0. || u >= 1. || t.flags == 3. || t.arrive < .99) { gl_Position = vec4(2., 2., 2., 1.); return; }
    float e = u * u * (3. - 2. * u);
    vec3 side = normalize(cross(t.c - uHostPos + vec3(.001), vec3(0., 0., 1.)) + vec3(.0001));
    c = mix(uHostPos, t.c, e) + side * sin(3.14159 * u) * (8. + 14. * fract(t.seed * 9.1));
    vec2 p = aCorner * vec2(3.2, .9) * (.7 + .8 * fract(t.seed * 3.3));
    gl_Position = uVP * vec4(c + vec3(p, 0.), 1.);
    vFragU = u; vLocal = aCorner; vHs = vec2(1.); vWall = mix(uHostPos.xy, t.c.xy, e);
    vRole = 0.; vFlags = 0.; vCut = 0.; vA = 1.; vSeed = t.seed; vJoin = 1.; vFill = 1.; vLate = 0.; vOff = 0.; vWave = 0.;
    vDepth = gl_Position.w; return;
  }
  if (t.arrive < .001) { gl_Position = vec4(2., 2., 2., 1.); return; }
  // a screen about to pass the viewer shrinks away instead of filling the frame with one dark slab
  float nearK = .08 + .92 * smoothstep(14., 75., pc.w);
  vec2 p = aCorner * t.hs * t.scale * (t.flags == 3. ? 1. : nearK);
  vec3 wp = c + t.R * vec3(p, 0.);
  gl_Position = uVP * vec4(wp, 1.);
  vLocal = aCorner * t.hs; vHs = t.hs; vWall = t.rect.xy + aCorner * t.hs;
  float late = clamp(uDesync * 1.25 - t.delay * .25, 0., 1.);
  // the wave is a hiccup: the screens it passes slip a moment out of time, then catch up
  vOff = t.off * late + t.wave * .5 + lateF * .35;
  // the slowest screen, buffering, stutters
  if (t.flags == 9.) vOff -= uBuffer * (.4 + fract(floor(uTime * 6.) * .37) * .5);
  vWave = t.wave; vJoin = t.join; vFill = t.fill; vLate = lateF;
  vRole = t.role; vFlags = t.flags; vCut = t.cut; vA = t.a; vSeed = t.seed;
  vDepth = gl_Position.w;
}`;

export const TILE_FS = /* glsl */ `#version 300 es
precision highp float;
#define FBM_OCT FBM_N
${NOISE}
${FILM}
uniform float uTime, uMark, uFilmT, uFog, uHostGone, uNewHost, uLock, uBuffer, uIdent, uIdentMode;
in vec2 vLocal; in vec2 vWall; in vec2 vHs;
flat in float vOff; flat in float vRole; flat in float vFlags; flat in float vCut; flat in float vA; flat in float vWave;
flat in float vJoin; flat in float vFill; flat in float vLate; flat in float vFragU;
in float vDepth; in float vSeed;
out vec4 o;
void main(){
  if (vFragU >= 0.) {
    // a fragment of the film on its way: a short bright streak, fading in and out along the trip
    vec3 c = film(vWall, uFilmT) * .6 + mix(CYAN, vec3(1.), .35) * 1.6;
    float a = sin(3.14159 * vFragU) * (1. - smoothstep(.6, 1., abs(vLocal.x)));
    o = vec4(c * a, a * .9); return;
  }
  // cut corners, top right and bottom left, like every screen in the mark
  float cs = min(min(vHs.x, vHs.y) * .32, vRole > .5 ? 3. : 1.3);
  vec2 p = vLocal;
  float e = vHs.x + vHs.y - cs;
  float dTR = (p.x + p.y - e) * .7071, dBL = (-p.x - p.y - e) * .7071;
  float d = max(abs(p.x) - vHs.x, abs(p.y) - vHs.y);
  if (mod(vCut, 2.) > .5) d = max(d, dTR);
  if (vCut > 1.5) d = max(d, dBL);
  float aa = fwidth(d);
  float cov = 1. - smoothstep(-aa, aa, d);
  if (cov < .01) discard;
  float edge = 1. - smoothstep(0., aa * 1.5 + .06, -d);
  // a screen without the film yet is a real screen, switched off: dark glass with a faint sheen, and a bezel that
  // lights when the invite reaches it
  vec2 lq0 = vLocal / max(vHs, vec2(1e-3));
  float fr = 1. - smoothstep(aa * 1.2, aa * 2.4 + .1, -d); // the bezel, at least a pixel or two wide, however far
  vec3 glass = vec3(.036, .03, .065) + vec3(.035, .035, .07) * smoothstep(-.2, 1.2, lq0.y - lq0.x * .4) * (.6 + .4 * vJoin);
  vec3 bezel = mix(vec3(.34, .3, .5), vec3(.7, .92, 1.), vJoin) * (.42 + .4 * vJoin) + PINK * 1.6 * vJoin * (1. - vJoin) * 4.;
  vec3 off = mix(glass, bezel, fr);
  if (vFill < .02) {
    off = mix(GROUND, off, exp(-max(vDepth - 260., 0.) * uFog));
    o = vec4(off * cov, cov); return;
  }
  vec3 c = mix(off, film(vWall, uFilmT + vOff), vFill);
  // a screen: a little darker toward its corners, a hairline of light at its edge
  vec2 lq = vLocal / max(vHs, vec2(1e-3));
  c *= 1. - .22 * dot(lq, lq) * .5;
  // the ripple catches the light as it passes
  c *= 1. + vWave * .7;
  c += vec3(1., .16, .43) * max(vWave, 0.) * .25;
  // a screen alone in the dark glows: brighter the farther it is from its place on the wall
  c *= 1. + (1. - vA) * .9;
  c += mix(vec3(.45, .32, .75), vec3(.6, 1., 1.), fract(vSeed * 7.)) * edge * (.12 + .3 * (1. - vA));
  // the mark: lit screens stay bright, dim screens sink toward the ground, the playhead and the late dot glow
  if (uMark > 0.){
    vec3 m = c;
    if (vRole < 1.5) m = mix(vec3(dot(c, vec3(.3, .5, .2))) * vec3(.62, .55, .85) + vec3(.16, .14, .24), GROUND, .58);
    else if (vRole < 2.5) m = mix(c, vec3(.62, .57, .8), .45) * 1.25;
    else if (vRole < 3.5) m = CYAN * 2.2 + c * .2;
    else m = PINK * 2. + c * .2;
    c = mix(c, m, uMark);
  }
  // the pointer's late screens: their edge runs pink while they are behind, cyan as they catch up
  c += mix(CYAN * .5, PINK * 1.4, smoothstep(.15, .6, vLate)) * edge * smoothstep(.02, .2, vLate);
  // the wall holds its breath while one screen buffers; that one pulses pink at its edge
  if (vFlags == 9.) c += PINK * edge * 2.5 * uBuffer * (.6 + .4 * sin(uTime * 9.));
  else c *= 1. - .22 * uBuffer;
  // the moment the room locks: a scatter of screens flashes white, a few frames each
  float fl = step(1. - .07 * uLock, fract(sin(vSeed * 91.7 + floor(uTime * 14.) * 3.1) * 43758.5));
  c += vec3(.9, .97, 1.) * fl * 1.1 * uLock;
  // the host's screen, and who takes over when they leave
  if (vFlags == 3.) c += PINK * edge * 2. * (1. - uHostGone);
  if (vFlags == 4.) c += PINK * edge * 2. * uNewHost;
  // the opening: the mark's screens light in order, the playhead first, the late dot last, on the second hit
  if (uIdentMode > 0.) {
    float ord = vRole > 3.5 ? .97 : vRole > 2.5 ? .06 : vRole > 1.5 ? .25 + fract(vSeed * 7.3) * .3 : .45 + fract(vSeed * 3.7) * .45;
    float on = smoothstep(ord - .04, ord + .03, uIdent);
    float flash = vRole > 3.5 ? exp(-max(0., uIdent - .97) * 18.) * step(.97, uIdent) : 0.;
    c = mix(c, c * on + PINK * flash * 2., uIdentMode);
  }
  c = mix(GROUND, c, exp(-max(vDepth - 260., 0.) * uFog));
  o = vec4(c * cov, cov);
}`;

// Links between screens: a quad per link, drawn in screen space, with pulses running along it.
export const LINK_VS = /* glsl */ `#version 300 es
precision highp float;
${TILE_COMMON}
uniform mat4 uVP;
uniform vec2 uRes;
uniform float uPx;
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec3 aLink;
out float vU; out float vSeed; out float vW; flat out float vNamed;
void main(){
  Tile A = tile(int(aLink.x)), B = tile(int(aLink.y));
  vec4 pa = uVP * vec4(A.c, 1.), pb = uVP * vec4(B.c, 1.);
  float u = aCorner.x * .5 + .5;
  vec4 pc = mix(pa, pb, u);
  vec2 sa = pa.xy / max(pa.w, .1) * uRes, sb = pb.xy / max(pb.w, .1) * uRes;
  vec2 dir = normalize(sb - sa + 1e-4);
  vec2 nrm = vec2(-dir.y, dir.x);
  pc.xy += nrm * aCorner.y * uPx / uRes * pc.w;
  gl_Position = (pa.w < .5 || pb.w < .5) ? vec4(2., 2., 2., 1.) : pc;
  vU = u; vSeed = aLink.z; vW = aCorner.y;
  vNamed = (A.flags >= 3. && B.flags >= 3.) ? 1. : 0.;
  // links to the host fall away when the host leaves
  if (A.flags == 3. || B.flags == 3.) vSeed = -1. - uHostGone;
}`;

export const LINK_FS = /* glsl */ `#version 300 es
precision highp float;
uniform float uTime, uMesh, uHostGone;
in float vU; in float vSeed; in float vW; flat in float vNamed;
out vec4 o;
void main(){
  float hostLink = vSeed < 0. ? 1. : 0.;
  float seed = hostLink > 0. ? .5 : vSeed;
  float fade = hostLink > 0. ? (1. - smoothstep(0., .25, uHostGone)) + smoothstep(.0, .08, uHostGone) * (1. - smoothstep(.08, .3, uHostGone)) * 3. : 1.;
  float sp = .18 + seed * .35;
  float ph = fract(uTime * sp + seed * 13.);
  float dir = fract(seed * 7.) > .5 ? vU : 1. - vU;
  float pulse = exp(-abs(dir - ph) * 30.) * step(vNamed > .5 ? .3 : .82, fract(seed * 31. + floor(uTime * sp + seed * 13.) * .37));
  float w = 1. - abs(vW);
  float base = vNamed * .22;
  float pul = pulse * (vNamed > .5 ? 1.8 : 1.1);
  vec3 c = mix(vec3(.55, .3, 1.), vec3(0., .94, 1.), pulse) * (base + pul) * w * uMesh * fade;
  o = vec4(c, 0.);
}`;

// The ground behind everything: the contour map, still, a little parallax.
export const QUAD_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aP;
out vec2 vUv;
void main(){ vUv = aP * .5 + .5; gl_Position = vec4(aP, 0., 1.); }`;

export const GROUND_FS = /* glsl */ `#version 300 es
precision highp float;
#define FBM_OCT 3
${NOISE}
uniform vec2 uRes, uPar;
uniform float uTime, uGlow;
in vec2 vUv; out vec4 o;
void main(){
  vec2 p = (vUv - .5) * vec2(uRes.x / uRes.y, 1.) * 2.2 + uPar;
  float f = fbm(p * 1.3 + vec2(uTime * .004, 0.));
  float k = f * 14.;
  float fw = max(fwidth(k), 1e-4);
  float iso = 1. - smoothstep(0., fw * 1.2, abs(fract(k + .5) - .5));
  vec3 c = vec3(.027, .016, .059);
  c += vec3(.16, .09, .3) * iso * .22;
  float v = length(vUv - .5);
  c += vec3(.1, .03, .2) * (1. - smoothstep(0., .75, v)) * .35 * uGlow;
  o = vec4(c, 1.);
}`;

// The pointer's trail: a field of lateness. Each frame it fades, and the pointer's path since the last frame is
// drawn into it (a line, so a fast move leaves no gaps). Screens read it and slip out of time where it is high.
export const FIELD_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform vec2 uA, uB; uniform float uDecay, uAmt, uRadius, uAspect;
in vec2 vUv; out vec4 o;
float seg(vec2 p, vec2 a, vec2 b){ vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0., 1.); return length(pa - ba * h); }
void main(){
  vec2 p = vUv, a = uA, b = uB; p.x *= uAspect; a.x *= uAspect; b.x *= uAspect;
  float d = seg(p, a, b);
  float v = texture(uSrc, vUv).x * uDecay;
  o = vec4(max(v, uAmt * exp(-d * d / uRadius)), 0., 0., 1.);
}`;

// Bloom: a bright pass into half size, then dual-filter blurs down and back up.
export const BRIGHT_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform float uThresh;
in vec2 vUv; out vec4 o;
void main(){ vec3 c = texture(uSrc, vUv).rgb; float l = max(c.r, max(c.g, c.b));
  o = vec4(c * smoothstep(uThresh, uThresh + .6, l), 1.); }`;
export const DOWN_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform vec2 uTexel;
in vec2 vUv; out vec4 o;
void main(){ vec2 h = uTexel * .5;
  vec3 s = texture(uSrc, vUv).rgb * 4. + texture(uSrc, vUv - h).rgb + texture(uSrc, vUv + h).rgb
         + texture(uSrc, vUv + vec2(h.x, -h.y)).rgb + texture(uSrc, vUv - vec2(h.x, -h.y)).rgb;
  o = vec4(s / 8., 1.); }`;
export const UP_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uSrc, uBase; uniform vec2 uTexel;
in vec2 vUv; out vec4 o;
void main(){ vec2 h = uTexel * .5;
  vec3 s = texture(uSrc, vUv + vec2(-h.x * 2., 0.)).rgb + texture(uSrc, vUv + vec2(-h.x, h.y)).rgb * 2.
         + texture(uSrc, vUv + vec2(0., h.y * 2.)).rgb + texture(uSrc, vUv + vec2(h.x, h.y)).rgb * 2.
         + texture(uSrc, vUv + vec2(h.x * 2., 0.)).rgb + texture(uSrc, vUv + vec2(h.x, -h.y)).rgb * 2.
         + texture(uSrc, vUv + vec2(0., -h.y * 2.)).rgb + texture(uSrc, vUv + vec2(-h.x, -h.y)).rgb * 2.;
  o = vec4(s / 12. + texture(uBase, vUv).rgb, 1.); }`;

// The final picture: bloom, the split of colour that grows with how far apart the room is, the fluid's
// refraction, grain and a vignette, then a filmic tone curve.
export const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uScene, uBloom, uFluid, uStreakSrc;
uniform float uStreak;
uniform vec2 uRes;
uniform float uTime, uAberr, uBloomK, uGrain, uFade, uFluidK, uFlash;
in vec2 vUv; out vec4 o;
float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 aces(vec3 x){ return clamp((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14), 0., 1.); }
void main(){
  vec2 uv = vUv;
  vec2 fv = texture(uFluid, uv).xy * uFluidK;
  uv -= fv * .004;
  vec2 dc = uv - .5;
  vec2 ab = dc * uAberr;
  vec3 c;
  c.r = texture(uScene, uv + ab).r;
  c.g = texture(uScene, uv).g;
  c.b = texture(uScene, uv - ab).b;
  vec3 b = texture(uBloom, uv).rgb;
  c += b * uBloomK;
  // a lens streak: the brightest light smeared sideways, cyan-tinted
  vec3 sk = vec3(0.);
  if (uStreak > 0.) for (int i = 1; i <= 6; i++){ float o = float(i) * .022; float wgt = 1. - float(i) / 7.;
    sk += (texture(uStreakSrc, uv + vec2(o, 0.)).rgb + texture(uStreakSrc, uv - vec2(o, 0.)).rgb) * wgt; }
  c += sk * vec3(.35, .8, 1.) * uStreak;
  c += vec3(0., .94, 1.) * uFlash * .06;
  c = aces(c * 1.05);
  float v = smoothstep(1.1, .25, length(dc * vec2(uRes.x / uRes.y, 1.) * .9));
  c *= mix(.55, 1., v);
  c += (hash(gl_FragCoord.xy + fract(uTime * 61.) * 400.) - .5) * uGrain;
  c = pow(c, vec3(.96));
  o = vec4(c * uFade, 1.);
}`;
