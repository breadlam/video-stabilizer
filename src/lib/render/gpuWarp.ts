import type { Affine } from '../geometry/affine'
import { blackLevels, planeSamplingMatrix, type YuvLayout } from '../media/pixels'

/**
 * High-quality frame warping on the GPU (WebGL2), for export.
 *
 * Frames are resampled with a Lanczos-3 kernel directly on their YUV planes at native bit depth, so
 * there is no colour-space round trip and no 8-bit bottleneck. Output is always 4:2:0. When a browser
 * only provides RGB (or opaque GPU) frames, they are warped in RGB and converted to YUV with the
 * source's own matrix instead.
 *
 * Results are written as packed bytes (four 8-bit or two 16-bit samples per RGBA8 texel) so the
 * read-back is exactly the plane data.
 */

const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID & 1) << 2) - 1.0, float((gl_VertexID & 2) << 1) - 1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`

const COMMON = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uPrev;     // previous output plane, for filling uncovered areas
uniform bool uHistory;
uniform float uFill;          // value for uncovered areas without history
uniform int uOutWidth;        // plane width in samples
uniform bool uSixteen;        // pack two 16-bit samples per texel instead of four 8-bit ones
uniform float uMax;
uniform vec3 uMx;             // output plane coords → source coords
uniform vec3 uMy;
uniform ivec2 uSrcSize;
out vec4 outColor;

const float PI = 3.141592653589793;
float lanczos3(float x) {
  x = abs(x);
  if (x < 1e-5) return 1.0;
  if (x >= 3.0) return 0.0;
  float a = PI * x;
  return 3.0 * sin(a) * sin(a / 3.0) / (a * a);
}

vec2 sourcePos(vec2 p) {
  return vec2(dot(uMx, vec3(p, 1.0)), dot(uMy, vec3(p, 1.0)));
}

bool outside(vec2 s) {
  return s.x < 0.0 || s.y < 0.0 || s.x > float(uSrcSize.x) || s.y > float(uSrcSize.y);
}

float uncovered(int x, int y) {
  return uHistory ? float(texelFetch(uPrev, ivec2(x, y), 0).r) : uFill;
}

float sampleOut(int x, int y);

void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  if (uSixteen) {
    int x0 = t.x * 2;
    float a = x0 < uOutWidth ? floor(clamp(sampleOut(x0, t.y), 0.0, uMax) + 0.5) : 0.0;
    float b = x0 + 1 < uOutWidth ? floor(clamp(sampleOut(x0 + 1, t.y), 0.0, uMax) + 0.5) : 0.0;
    outColor = vec4(mod(a, 256.0), floor(a / 256.0), mod(b, 256.0), floor(b / 256.0)) / 255.0;
  } else {
    int x0 = t.x * 4;
    float v[4];
    for (int k = 0; k < 4; k++) {
      int x = x0 + k;
      v[k] = x < uOutWidth ? floor(clamp(sampleOut(x, t.y), 0.0, uMax) + 0.5) : 0.0;
    }
    outColor = vec4(v[0], v[1], v[2], v[3]) / 255.0;
  }
}
`

/** Lanczos-3 on one channel of an integer YUV plane. */
const PLANAR = `${COMMON}
uniform usampler2D uSrc;
uniform int uChannel;     // 0 = first channel, 1 = second (NV12 V)
uniform float uScale;     // bit-depth conversion

float fetch(ivec2 p) {
  uvec4 t = texelFetch(uSrc, clamp(p, ivec2(0), uSrcSize - 1), 0);
  return float(uChannel == 0 ? t.r : t.g);
}

float sampleOut(int x, int y) {
  vec2 s = sourcePos(vec2(float(x) + 0.5, float(y) + 0.5));
  if (outside(s)) return uncovered(x, y);
  vec2 c = s - 0.5;
  vec2 b = floor(c);
  vec2 f = c - b;
  float wx[6];
  float wy[6];
  float sx = 0.0;
  float sy = 0.0;
  for (int i = 0; i < 6; i++) {
    wx[i] = lanczos3(f.x - float(i - 2));
    wy[i] = lanczos3(f.y - float(i - 2));
    sx += wx[i];
    sy += wy[i];
  }
  ivec2 base = ivec2(b) - 2;
  float acc = 0.0;
  for (int j = 0; j < 6; j++) {
    float row = 0.0;
    for (int i = 0; i < 6; i++) row += wx[i] * fetch(base + ivec2(i, j));
    acc += wy[j] * row;
  }
  return acc / (sx * sy) * uScale;
}
`

/** Lanczos-3 on an RGB frame, then conversion to one YUV plane (chroma box-averaged over 2×2). */
const RGB = `${COMMON}
uniform sampler2D uRgb;
uniform int uPlane;        // 0 = Y, 1 = U, 2 = V
uniform bool uSwapRB;      // BGR source
uniform vec3 uCoef;        // (Kr, Kg, Kb)
uniform vec4 uRange;       // (yScale, yOffset, cScale, cOffset), output code values

vec3 fetch(ivec2 p) {
  vec3 c = texelFetch(uRgb, clamp(p, ivec2(0), uSrcSize - 1), 0).rgb;
  return uSwapRB ? c.bgr : c;
}

vec3 rgbAt(vec2 s) {
  vec2 c = s - 0.5;
  vec2 b = floor(c);
  vec2 f = c - b;
  float wx[6];
  float wy[6];
  float sx = 0.0;
  float sy = 0.0;
  for (int i = 0; i < 6; i++) {
    wx[i] = lanczos3(f.x - float(i - 2));
    wy[i] = lanczos3(f.y - float(i - 2));
    sx += wx[i];
    sy += wy[i];
  }
  ivec2 base = ivec2(b) - 2;
  vec3 acc = vec3(0.0);
  for (int j = 0; j < 6; j++) {
    vec3 row = vec3(0.0);
    for (int i = 0; i < 6; i++) row += wx[i] * fetch(base + ivec2(i, j));
    acc += wy[j] * row;
  }
  return clamp(acc / (sx * sy), 0.0, 1.0);
}

float component(vec3 rgb) {
  float y = dot(uCoef, rgb);
  if (uPlane == 0) return uRange.x * y + uRange.y;
  float d = uPlane == 1 ? (rgb.b - y) / (2.0 * (1.0 - uCoef.z)) : (rgb.r - y) / (2.0 * (1.0 - uCoef.x));
  return uRange.z * d + uRange.w;
}

float sampleOut(int x, int y) {
  if (uPlane == 0) {
    vec2 s = sourcePos(vec2(float(x) + 0.5, float(y) + 0.5));
    return outside(s) ? uncovered(x, y) : component(rgbAt(s));
  }
  // Chroma: average the 2×2 luma positions it covers (uMx/uMy map luma coordinates here).
  vec2 centre = sourcePos(vec2(float(2 * x) + 1.0, float(2 * y) + 1.0));
  if (outside(centre)) return uncovered(x, y);
  vec3 sum = vec3(0.0);
  for (int j = 0; j < 2; j++)
    for (int i = 0; i < 2; i++) sum += rgbAt(sourcePos(vec2(float(2 * x + i) + 0.5, float(2 * y + j) + 0.5)));
  return component(sum * 0.25);
}
`

export interface OutputSpec {
  width: number
  height: number
  bits: 8 | 10 | 12
  fullRange: boolean
  fill: 'black' | 'history'
}

/** Byte layout of a tightly packed 4:2:0 frame. */
export function i420Layout(width: number, height: number, bits: number) {
  const bps = bits > 8 ? 2 : 1
  const cw = Math.ceil(width / 2)
  const ch = Math.ceil(height / 2)
  const ySize = width * height * bps
  const cSize = cw * ch * bps
  return {
    size: ySize + 2 * cSize,
    planes: [
      { offset: 0, stride: width * bps, width, height },
      { offset: ySize, stride: cw * bps, width: cw, height: ch },
      { offset: ySize + cSize, stride: cw * bps, width: cw, height: ch },
    ],
  }
}

interface Target {
  tex: WebGLTexture
  fbo: WebGLFramebuffer
  width: number
  height: number
}

export class GpuWarper {
  private readonly gl: WebGL2RenderingContext
  private readonly planar: WebGLProgram
  private readonly rgb: WebGLProgram
  private readonly srcTex: WebGLTexture[]
  private readonly prevTex: WebGLTexture[]
  private readonly rgbTex: WebGLTexture
  private readonly targets = new Map<string, Target>()
  private readonly uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>()
  private prev: Uint8Array | null = null
  private readBuf = new Uint8Array(0)

  constructor() {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2', {
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      powerPreference: 'high-performance',
    })
    if (!gl) throw new Error('Exporting needs WebGL2, which this browser does not provide.')
    this.gl = gl
    this.planar = this.program(PLANAR)
    this.rgb = this.program(RGB)
    this.srcTex = [0, 1, 2].map(() => this.texture())
    this.prevTex = [0, 1, 2].map(() => this.texture())
    this.rgbTex = this.texture()
    gl.bindVertexArray(gl.createVertexArray())
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  }

  /**
   * Warps a YUV frame. `planes` are the input plane layouts (as returned by VideoFrame.copyTo) of a
   * `width`×`height` frame; `inv` maps output luma coordinates to input luma coordinates.
   */
  warpYuv(
    data: Uint8Array,
    planes: readonly PlaneLayout[],
    layout: YuvLayout,
    width: number,
    height: number,
    inv: Affine,
    out: OutputSpec,
  ): Uint8Array {
    const { gl } = this
    const sixteenIn = layout.bits > 8
    const cw = Math.ceil(width / layout.subX)
    const ch = Math.ceil(height / layout.subY)
    const inputs = layout.interleaved
      ? [
          { plane: 0, w: width, h: height, channels: 1 },
          { plane: 1, w: cw, h: ch, channels: 2 },
        ]
      : [
          { plane: 0, w: width, h: height, channels: 1 },
          { plane: 1, w: cw, h: ch, channels: 1 },
          { plane: 2, w: cw, h: ch, channels: 1 },
        ]
    inputs.forEach((p, i) => {
      const { offset, stride } = planes[p.plane]
      const bytes = sixteenIn ? 2 : 1
      gl.bindTexture(gl.TEXTURE_2D, this.srcTex[i])
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, stride / (bytes * p.channels))
      const two = p.channels === 2
      const pixels = sixteenIn
        ? new Uint16Array(data.buffer, data.byteOffset + offset, (data.byteLength - offset) >> 1)
        : data.subarray(offset)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        sixteenIn ? (two ? gl.RG16UI : gl.R16UI) : two ? gl.RG8UI : gl.R8UI,
        p.w,
        p.h,
        0,
        two ? gl.RG_INTEGER : gl.RED_INTEGER,
        sixteenIn ? gl.UNSIGNED_SHORT : gl.UNSIGNED_BYTE,
        pixels,
      )
    })
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)

    const result = i420Layout(out.width, out.height, out.bits)
    const output = new Uint8Array(result.size)
    const black = blackLevels(out.bits, out.fullRange)
    const scale = (2 ** out.bits - 1) / (2 ** layout.bits - 1)
    const p = this.planar
    gl.useProgram(p)
    this.uploadPrev(result, out)
    for (let i = 0; i < 3; i++) {
      const src = layout.interleaved ? Math.min(i, 1) : i
      const m = planeSamplingMatrix(inv, i === 0 ? [1, 1] : [2, 2], i === 0 ? [1, 1] : [layout.subX, layout.subY])
      const inW = i === 0 ? width : cw
      const inH = i === 0 ? height : ch
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.srcTex[src])
      gl.uniform1i(this.loc(p, 'uSrc'), 0)
      gl.uniform1i(this.loc(p, 'uChannel'), layout.interleaved && i === 2 ? 1 : 0)
      gl.uniform1f(this.loc(p, 'uScale'), scale)
      gl.uniform2i(this.loc(p, 'uSrcSize'), inW, inH)
      this.render(p, m, i, result.planes[i], out, i === 0 ? black.y : black.c, output)
    }
    this.prev = out.fill === 'history' ? output : null
    return output
  }

  /**
   * Warps an RGB frame (`source` is a VideoFrame or RGBA bytes of size width×height) and converts it
   * to 8-bit 4:2:0 with the given YUV matrix.
   */
  warpRgb(
    source: VideoFrame | Uint8Array,
    width: number,
    height: number,
    swapRB: boolean,
    inv: Affine,
    coef: { kr: number; kb: number },
    out: OutputSpec,
  ): Uint8Array {
    const { gl } = this
    gl.bindTexture(gl.TEXTURE_2D, this.rgbTex)
    if (source instanceof Uint8Array) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, source)
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source)
    }
    const result = i420Layout(out.width, out.height, 8)
    const output = new Uint8Array(result.size)
    const black = blackLevels(8, out.fullRange)
    const range = out.fullRange ? [255, 0, 255, 128] : [219, 16, 224, 128]
    const p = this.rgb
    gl.useProgram(p)
    this.uploadPrev(result, { ...out, bits: 8 })
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.rgbTex)
    gl.uniform1i(this.loc(p, 'uRgb'), 0)
    gl.uniform1i(this.loc(p, 'uSwapRB'), swapRB ? 1 : 0)
    gl.uniform3f(this.loc(p, 'uCoef'), coef.kr, 1 - coef.kr - coef.kb, coef.kb)
    gl.uniform4f(this.loc(p, 'uRange'), range[0], range[1], range[2], range[3])
    gl.uniform2i(this.loc(p, 'uSrcSize'), width, height)
    for (let i = 0; i < 3; i++) {
      gl.uniform1i(this.loc(p, 'uPlane'), i)
      // The RGB shader maps luma coordinates itself (chroma averages its 2×2 luma block).
      this.render(p, inv, i, result.planes[i], { ...out, bits: 8 }, i === 0 ? black.y : black.c, output)
    }
    this.prev = out.fill === 'history' ? output : null
    return output
  }

  dispose(): void {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext()
  }

  // ---- internals ------------------------------------------------------------------------------

  private render(
    p: WebGLProgram,
    m: Affine,
    index: number,
    plane: { offset: number; stride: number; width: number; height: number },
    out: OutputSpec,
    fill: number,
    output: Uint8Array,
  ): void {
    const { gl } = this
    const sixteen = out.bits > 8
    const texW = Math.ceil(plane.width / (sixteen ? 2 : 4))
    const target = this.target(texW, plane.height)
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
    gl.viewport(0, 0, texW, plane.height)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.prevTex[index])
    gl.uniform1i(this.loc(p, 'uPrev'), 1)
    gl.uniform1i(this.loc(p, 'uHistory'), out.fill === 'history' && this.prev ? 1 : 0)
    gl.uniform1f(this.loc(p, 'uFill'), fill)
    gl.uniform1i(this.loc(p, 'uOutWidth'), plane.width)
    gl.uniform1i(this.loc(p, 'uSixteen'), sixteen ? 1 : 0)
    gl.uniform1f(this.loc(p, 'uMax'), 2 ** out.bits - 1)
    gl.uniform3f(this.loc(p, 'uMx'), m.a, m.c, m.e)
    gl.uniform3f(this.loc(p, 'uMy'), m.b, m.d, m.f)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    const rowBytes = texW * 4
    if (rowBytes === plane.stride) {
      gl.readPixels(0, 0, texW, plane.height, gl.RGBA, gl.UNSIGNED_BYTE, output.subarray(plane.offset, plane.offset + rowBytes * plane.height))
    } else {
      if (this.readBuf.length < rowBytes * plane.height) this.readBuf = new Uint8Array(rowBytes * plane.height)
      gl.readPixels(0, 0, texW, plane.height, gl.RGBA, gl.UNSIGNED_BYTE, this.readBuf)
      for (let y = 0; y < plane.height; y++) {
        output.set(this.readBuf.subarray(y * rowBytes, y * rowBytes + plane.stride), plane.offset + y * plane.stride)
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  /** Uploads the previous output frame's planes for history fill. */
  private uploadPrev(layout: ReturnType<typeof i420Layout>, out: OutputSpec): void {
    if (out.fill !== 'history' || !this.prev || this.prev.length !== layout.size) {
      if (out.fill === 'history') this.prev = null
      return
    }
    const { gl } = this
    const sixteen = out.bits > 8
    layout.planes.forEach((plane, i) => {
      gl.bindTexture(gl.TEXTURE_2D, this.prevTex[i])
      const data = sixteen
        ? new Uint16Array(this.prev!.buffer, this.prev!.byteOffset + plane.offset, plane.width * plane.height)
        : this.prev!.subarray(plane.offset, plane.offset + plane.width * plane.height)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        sixteen ? gl.R16UI : gl.R8UI,
        plane.width,
        plane.height,
        0,
        gl.RED_INTEGER,
        sixteen ? gl.UNSIGNED_SHORT : gl.UNSIGNED_BYTE,
        data,
      )
    })
  }

  private target(width: number, height: number): Target {
    const key = `${width}x${height}`
    let t = this.targets.get(key)
    if (!t) {
      const { gl } = this
      // Create on a spare unit so the source textures bound for this pass stay bound.
      const active = gl.getParameter(gl.ACTIVE_TEXTURE) as number
      gl.activeTexture(gl.TEXTURE7)
      const tex = this.texture()
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height)
      const fbo = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('WebGL framebuffer incomplete')
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.activeTexture(active)
      t = { tex, fbo, width, height }
      this.targets.set(key, t)
    }
    return t
  }

  private texture(): WebGLTexture {
    const { gl } = this
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return tex
  }

  private program(fragment: string): WebGLProgram {
    const { gl } = this
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Shader compile failed: ${gl.getShaderInfoLog(s)}`)
      return s
    }
    const p = gl.createProgram()!
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERTEX))
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragment))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Shader link failed: ${gl.getProgramInfoLog(p)}`)
    return p
  }

  private loc(p: WebGLProgram, name: string): WebGLUniformLocation | null {
    let m = this.uniforms.get(p)
    if (!m) this.uniforms.set(p, (m = new Map()))
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(p, name))
    return m.get(name)!
  }
}
