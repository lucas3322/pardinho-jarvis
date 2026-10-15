// Orb de voz: esfera de anéis finos e brilhantes, deformada por ruído 3D
// e pela energia do áudio. Desenhada em canvas 2D com mistura aditiva;
// uma segunda camada desfocada cria o brilho.

// --- Ruído de Perlin 3D (Improved Noise, Ken Perlin 2002) -------------------
const P = new Uint8Array(512);
{
  const p = Array.from({ length: 256 }, (_, i) => i);
  let seed = 1337;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) P[i] = p[i & 255];
}
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (t, a, b) => a + t * (b - a);
function grad(h, x, y, z) {
  h &= 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
}
function noise3(x, y, z) {
  const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
  const X = fx & 255, Y = fy & 255, Z = fz & 255;
  x -= fx; y -= fy; z -= fz;
  const u = fade(x), v = fade(y), w = fade(z);
  const A = P[X] + Y, AA = P[A] + Z, AB = P[A + 1] + Z;
  const B = P[X + 1] + Y, BA = P[B] + Z, BB = P[B + 1] + Z;
  return lerp(w,
    lerp(v, lerp(u, grad(P[AA], x, y, z), grad(P[BA], x - 1, y, z)),
            lerp(u, grad(P[AB], x, y - 1, z), grad(P[BB], x - 1, y - 1, z))),
    lerp(v, lerp(u, grad(P[AA + 1], x, y, z - 1), grad(P[BA + 1], x - 1, y, z - 1)),
            lerp(u, grad(P[AB + 1], x, y - 1, z - 1), grad(P[BB + 1], x - 1, y - 1, z - 1))));
}

// --- Paletas (de cima para baixo) -------------------------------------------
// Cada paleta: 4 paradas RGB + intensidade base.
const PALETTES = {
  idle:      { stops: [[96, 200, 214], [70, 170, 210], [70, 130, 220], [90, 160, 240]], glow: 0.5 },
  listening: { stops: [[110, 255, 200], [40, 225, 190], [30, 190, 225], [60, 140, 255]], glow: 0.9 },
  thinking:  { stops: [[170, 140, 255], [130, 110, 255], [100, 140, 255], [130, 200, 255]], glow: 0.8 },
  speaking:  { stops: [[255, 92, 54], [255, 88, 170], [168, 116, 255], [120, 200, 255]], glow: 1 },
  error:     { stops: [[255, 90, 80], [230, 60, 90], [170, 50, 90], [120, 50, 80]], glow: 0.7 },
};
const STOP_OFFSETS = [0, 0.38, 0.66, 1];

export class Orb {
  constructor(stage) {
    this.stage = stage;
    this.glow = document.createElement("canvas");
    this.glow.className = "orb-glow";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "orb-lines";
    this.glow.setAttribute("aria-hidden", "true");
    this.canvas.setAttribute("aria-hidden", "true");
    stage.append(this.glow, this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.gctx = this.glow.getContext("2d");

    this.state = "idle";
    this.color = PALETTES.idle.stops.map((c) => c.slice());
    this.glowAmt = PALETTES.idle.glow;
    this.analysers = { mic: null, out: null };
    this.buffers = new Map();

    this.env = 0;       // envelope do volume (0..1)
    this.treble = 0;    // energia de agudos (0..1)
    this.phase = 0;     // tempo do ruído, acelera com a voz
    this.time = 0;
    this.last = performance.now();

    this.reduced = matchMedia("(prefers-reduced-motion: reduce)");
    this.resize = this.resize.bind(this);
    new ResizeObserver(this.resize).observe(stage);
    this.resize();

    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
  }

  setState(state) {
    if (PALETTES[state]) this.state = state;
  }

  setAnalyser(kind, analyser) {
    this.analysers[kind] = analyser;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { width, height } = this.stage.getBoundingClientRect();
    this.w = width;
    this.h = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    // O brilho é desfocado; meia resolução basta e economiza GPU.
    this.glow.width = Math.round(width * dpr * 0.5);
    this.glow.height = Math.round(height * dpr * 0.5);
  }

  // Lê o volume (RMS) e os agudos de um analisador.
  read(analyser) {
    if (!analyser) return { rms: 0, treble: 0 };
    let buf = this.buffers.get(analyser);
    if (!buf) {
      buf = {
        time: new Float32Array(analyser.fftSize),
        freq: new Uint8Array(analyser.frequencyBinCount),
      };
      this.buffers.set(analyser, buf);
    }
    analyser.getFloatTimeDomainData(buf.time);
    let sum = 0;
    for (let i = 0; i < buf.time.length; i++) sum += buf.time[i] * buf.time[i];
    const rms = Math.sqrt(sum / buf.time.length);

    analyser.getByteFrequencyData(buf.freq);
    // ~2 kHz a ~8 kHz a 48 kHz com fftSize 512 → bins 21..85
    let hi = 0;
    for (let i = 21; i < 86; i++) hi += buf.freq[i];
    return { rms, treble: hi / (65 * 255) };
  }

  frame(now) {
    requestAnimationFrame(this.frame);
    const dt = Math.min((now - this.last) / 1000, 0.05);
    this.last = now;
    if (!this.w || document.hidden) return;

    // --- Entrada de áudio -----------------------------------------------------
    const mic = this.read(this.analysers.mic);
    const out = this.read(this.analysers.out);
    let src;
    if (this.state === "speaking") src = out;
    else if (this.state === "listening") src = mic;
    else src = { rms: Math.max(mic.rms, out.rms) * 0.6, treble: Math.max(mic.treble, out.treble) * 0.6 };

    // Voz em RMS fica entre ~0.01 e ~0.3: comprime para 0..1.
    const target = Math.min(1, Math.sqrt(Math.max(0, src.rms - 0.004) * 6));
    // Envelope: ataque rápido (40ms), soltura suave (220ms).
    const k = target > this.env ? 1 - Math.exp(-dt / 0.04) : 1 - Math.exp(-dt / 0.22);
    this.env += (target - this.env) * k;
    this.treble += (Math.min(1, src.treble * 2.2) - this.treble) * (1 - Math.exp(-dt / 0.08));

    // --- Cor: transição suave entre estados (≈250ms) --------------------------
    const pal = PALETTES[this.state];
    const ck = 1 - Math.exp(-dt / 0.25);
    for (let s = 0; s < 4; s++)
      for (let c = 0; c < 3; c++) this.color[s][c] += (pal.stops[s][c] - this.color[s][c]) * ck;
    this.glowAmt += (pal.glow - this.glowAmt) * ck;

    const reduced = this.reduced.matches;
    const env = reduced ? this.env * 0.35 : this.env;
    const thinkingPulse = this.state === "thinking" && !reduced ? 0.08 : 0;
    this.time += dt;
    this.phase += dt * (reduced ? 0.08 : 0.22 + env * 1.6 + thinkingPulse * 4);

    this.draw(env);
  }

  draw(env) {
    const { ctx, gctx, dpr } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.min(W, H) * 0.3 * (1 + env * 0.07);

    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = "lighter";
    ctx.lineWidth = Math.max(1, dpr * 0.75);
    ctx.lineJoin = "round";

    const grad = ctx.createLinearGradient(0, cy - R * 1.3, 0, cy + R * 1.3);
    this.color.forEach((c, i) =>
      grad.addColorStop(STOP_OFFSETS[i], `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`)
    );
    ctx.strokeStyle = grad;

    // Deformação: base calma + picos que crescem com a voz e com os agudos.
    const calm = 0.035;
    const amp = calm + env * 0.32;
    const spike = 0.02 + env * (0.12 + this.treble * 0.3);
    const t = this.phase;

    // Orientação: anéis ao redor do eixo X, levemente girados para dar volume.
    const yaw = 0.62 + Math.sin(this.time * 0.11) * 0.22;
    const pitch = 0.18 + Math.sin(this.time * 0.07 + 1) * 0.12;
    const cyw = Math.cos(yaw), syw = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);

    const RINGS = 64;
    const SEG = 132;
    const CAM = 3.6;
    const front = 0.55 + env * 0.4;
    const back = 0.14 + env * 0.1;

    for (let r = 0; r < RINGS; r++) {
      const theta = ((r + 0.5) / RINGS) * Math.PI;
      const ax = Math.cos(theta);
      const rho = Math.sin(theta);
      let prevZ = 0;
      let path = new Path2D();
      let started = false;

      for (let s = 0; s <= SEG; s++) {
        const phi = (s / SEG) * Math.PI * 2;
        const py = rho * Math.cos(phi);
        const pz = rho * Math.sin(phi);

        // Ruído amostrado no espaço do objeto → forma coerente entre anéis.
        const n1 = noise3(ax * 1.6 + t * 0.6, py * 1.6, pz * 1.6 - t * 0.4);
        const n2 = noise3(ax * 6.5 - t, py * 6.5 + t * 0.7, pz * 6.5);
        const d = 1 + n1 * amp + Math.abs(n2) * spike;

        let x = ax * d, y = py * d, z = pz * d;
        // yaw (eixo Y)
        let tx = x * cyw + z * syw;
        z = -x * syw + z * cyw;
        x = tx;
        // pitch (eixo X)
        const ty = y * cp - z * sp;
        z = y * sp + z * cp;
        y = ty;

        const persp = CAM / (CAM - z);
        const sx = cx + x * R * persp;
        const sy = cy - y * R * persp;

        // Separa trechos da frente e de trás para dar profundidade.
        if (started && (z >= 0) !== (prevZ >= 0)) {
          path.lineTo(sx, sy);
          ctx.globalAlpha = prevZ >= 0 ? front : back;
          ctx.stroke(path);
          path = new Path2D();
          path.moveTo(sx, sy);
        } else if (!started) {
          path.moveTo(sx, sy);
          started = true;
        } else {
          path.lineTo(sx, sy);
        }
        prevZ = z;
      }
      ctx.globalAlpha = prevZ >= 0 ? front : back;
      ctx.stroke(path);
    }
    ctx.globalAlpha = 1;

    // Camada de brilho: cópia reduzida, desfocada via CSS.
    gctx.globalCompositeOperation = "source-over";
    gctx.clearRect(0, 0, this.glow.width, this.glow.height);
    gctx.globalAlpha = Math.min(1, this.glowAmt * (0.6 + env * 0.8));
    gctx.drawImage(this.canvas, 0, 0, this.glow.width, this.glow.height);
    gctx.globalAlpha = 1;
  }
}
