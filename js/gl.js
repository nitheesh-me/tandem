// Small WebGL2 helpers: programs with their uniforms, render targets, a full-screen triangle.

export function program(gl, vs, fs, name = '') {
  const sh = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      const lines = src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
      throw new Error(`${name} ${type === gl.VERTEX_SHADER ? 'vs' : 'fs'}: ${log}\n${lines.slice(0, 4000)}`);
    }
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${name} link: ${gl.getProgramInfoLog(p)}`);
  const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name); }
  let unit = 0;
  const api = {
    p, u,
    use() { gl.useProgram(p); unit = 0; return api; },
    f(name, ...v) { const l = u[name]; if (l == null) return api; if (v.length === 1) gl.uniform1f(l, v[0]); else if (v.length === 2) gl.uniform2f(l, v[0], v[1]); else if (v.length === 3) gl.uniform3f(l, v[0], v[1], v[2]); else gl.uniform4f(l, ...v); return api; },
    m4(name, m) { if (u[name] != null) gl.uniformMatrix4fv(u[name], false, m); return api; },
    tex(name, t) { if (u[name] == null) return api; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(u[name], unit); unit++; return api; },
  };
  return api;
}

/** A colour target (and optional depth). `type`: gl.HALF_FLOAT or gl.UNSIGNED_BYTE. */
export function target(gl, w, h, { internal, format, type, depth = false, filter } = {}) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
  const f = filter ?? gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  let rb = null;
  if (depth) { rb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, rb); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb); }
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { t, fb, rb, w, h, ok, free() { gl.deleteTexture(t); gl.deleteFramebuffer(fb); if (rb) gl.deleteRenderbuffer(rb); } };
}

export function pair(gl, w, h, opts) {
  let a = target(gl, w, h, opts), b = target(gl, w, h, opts);
  return { get read() { return a; }, get write() { return b; }, swap() { [a, b] = [b, a]; }, ok: a.ok && b.ok, free() { a.free(); b.free(); } };
}

// A full-screen triangle on attribute 0.
export function fullscreen(gl) {
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return (fb, w, h) => { gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.viewport(0, 0, w, h); gl.bindVertexArray(vao); gl.drawArrays(gl.TRIANGLES, 0, 3); };
}

// Column-major 4x4 maths for the camera.
export function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}
export function lookAt(e, c, up) {
  let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2]; let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx; l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0, -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1]);
}
export function mul(a, b) {
  const o = new Float32Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k]; o[i * 4 + j] = s; }
  return o;
}
export function project(m, x, y, z) {
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12], cy = m[1] * x + m[5] * y + m[9] * z + m[13], cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [cx / cw, cy / cw, cw];
}
