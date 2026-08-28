/**
 * Renderer, HDR render targets, and the frame graph.
 * OWNER: core.
 *
 * Frame graph:
 *   modules.preRender()  ->  scene -> HDR float target  ->  postfx.render()  -> screen
 * If render/postfx.js is not registered yet, a plain tonemapped blit is used so
 * the game is always runnable.
 */
import * as THREE from 'three';
import { U } from './globals.js';

export class Engine {
  constructor(mount) {
    const canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    mount.appendChild(canvas);
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,          // we resolve with MSAA render targets / post AA
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;   // postfx owns tonemapping
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.autoClear = false;

    /**
     * SHADER FAILURES MUST BE LOUD.
     *
     * A vertex-stage fwidth() once failed to link 34-37 programs while every
     * module still reported init OK, because a shader that fails to compile
     * throws nothing — it just draws nothing. An entire critique round was spent
     * scoring a game that was not rendering, and five subsystem scores were void.
     * three.js offers a hook for exactly this; use it, and treat a link failure
     * as a first-class failure the same as a module throwing.
     */
    this.shaderErrors = [];
    this.renderer.debug.onShaderError = (gl, program, vs, fs_) => {
      const info = (sh) => {
        try { return gl.getShaderInfoLog(sh) || ''; } catch { return ''; }
      };
      const vlog = info(vs), flog = info(fs_);
      const stage = /ERROR/.test(vlog) ? 'VERTEX' : /ERROR/.test(flog) ? 'FRAGMENT' : 'LINK';
      const err = (vlog + '\n' + flog).split('\n').find((l) => /ERROR/.test(l)) || 'link failed';
      const name = program?.name || program?.cacheKey?.slice(0, 40) || 'unnamed';
      const rec = `shader[${stage}] ${name}: ${err.trim().slice(0, 160)}`;
      if (!this.shaderErrors.includes(rec)) this.shaderErrors.push(rec);
      console.error('[SHADER] ' + rec);
    };

    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = true;

    this.camera = new THREE.PerspectiveCamera(68, 1, 0.08, 6000);
    this.camera.position.set(0, -8, 0);

    // HDR scene target (float, MSAA where supported)
    const size = this._backbufferSize();
    this.hdrTarget = new THREE.WebGLRenderTarget(size.w, size.h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: true,
      samples: 4,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.hdrTarget.depthTexture = new THREE.DepthTexture(size.w, size.h, THREE.FloatType);

    this._blit = this._makeBlit();
    this.postfx = null;          // set by render/postfx.js when it registers
    this.onResize = new Set();

    this.frame = 0;
    this.drawCalls = 0;
    this.triangles = 0;

    addEventListener('resize', () => this.resize());
    this.resize();
  }

  _backbufferSize() {
    const r = this.renderer.getPixelRatio();
    return {
      w: Math.max(2, Math.floor(this.canvas.clientWidth * r)),
      h: Math.max(2, Math.floor(this.canvas.clientHeight * r)),
    };
  }

  resize() {
    const w = this.canvas.clientWidth || 1280;
    const h = this.canvas.clientHeight || 720;
    this.renderer.setSize(w, h, false);
    const s = this._backbufferSize();
    this.hdrTarget.setSize(s.w, s.h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.onResize.forEach((fn) => fn(s.w, s.h, w, h));
  }

  _makeBlit() {
    const mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { tSrc: { value: null }, uExposure: U.uExposure },
      vertexShader: `in vec3 position; in vec2 uv; out vec2 vUv;
        void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `precision highp float; in vec2 vUv; out vec4 fc;
        uniform sampler2D tSrc; uniform float uExposure;
        vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0); }
        void main(){
          vec3 c = texture(tSrc, vUv).rgb * uExposure;
          fc = vec4(pow(aces(c), vec3(1.0/2.2)), 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene(); scene.add(mesh);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    return { scene, cam, mat };
  }

  render() {
    const r = this.renderer;
    r.info.autoReset = false;
    r.info.reset();

    r.setRenderTarget(this.hdrTarget);
    r.clear(true, true, true);
    r.render(this.scene, this.camera);

    if (this.postfx && this.postfx.render) {
      this.postfx.render(this.hdrTarget, null);
    } else {
      this._blit.mat.uniforms.tSrc.value = this.hdrTarget.texture;
      r.setRenderTarget(null);
      r.clear(true, true, true);
      r.render(this._blit.scene, this._blit.cam);
    }

    this.drawCalls = r.info.render.calls;
    this.triangles = r.info.render.triangles;
    this.frame++;
  }
}
