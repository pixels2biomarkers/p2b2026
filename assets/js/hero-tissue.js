/*
 * Living H&E tissue for the header.
 *
 * Draws a hematoxylin & eosin-style section on a <canvas> and animates it very
 * slowly: stromal nuclei glide along a smooth flow field, lymphocytes drift,
 * and the glands rotate and breathe almost imperceptibly. The static JPEG tile
 * (assets/img/hero-he.jpg) stays underneath as a fallback for browsers without
 * JavaScript and for visitors who prefer reduced motion (they get one still frame).
 *
 * Everything is procedural and seeded, so the arrangement is the same on every
 * visit. Tune the feel with the constants in SETTINGS.
 */
(function () {
  'use strict';

  var SETTINGS = {
    fps: 30,                 // render cap (the motion is slow; 30 fps is plenty)
    spindleSpeed: 5.5,       // px/s: fibroblast nuclei following the flow field
    lymphSpeed: 2.2,         // px/s: lymphocytes
    glandSpeed: 0.6,         // px/s: glands drifting with the tissue
    glandRotation: 0.012,    // rad/s: one turn every ~9 minutes
    breath: 0.012,           // ±1.2 % gland scale oscillation
    spindleDensity: 3600,    // one spindle nucleus per N px²
    lymphDensity: 12000,     // one lymphocyte per N px²
    maxDpr: 1.5
  };

  var header = document.querySelector('.page-header');
  var host = document.querySelector('.hero-tissue');
  if (!header || !host || header.classList.contains('is-static')) { return; }

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var canvas = document.createElement('canvas');
  canvas.className = 'hero-canvas';
  host.appendChild(canvas);
  var ctx = canvas.getContext('2d');
  if (!ctx) { return; }

  // Deterministic PRNG so the layout is stable between visits and resizes.
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var W = 0, H = 0, DPR = 1;
  var stroma = null;           // offscreen canvas with the static eosin background
  var glands = [], spindles = [], lymphs = [];
  var TAU = Math.PI * 2;

  // Smooth, slowly evolving flow direction (radians) at a point.
  function flowAngle(x, y, t) {
    var s = 1 / Math.max(H, 1);
    return 0.9 * Math.sin(x * s * 2.3 + t * 0.045)
         + 0.7 * Math.cos(y * s * 1.9 - t * 0.035)
         + 0.5 * Math.sin((x + y) * s * 1.2 + t * 0.025);
  }

  function blobPath(cx, cy, r, wobble, phase, k1, k2) {
    var n = 40;
    ctx.beginPath();
    for (var i = 0; i < n; i++) {
      var a = TAU * i / n;
      var rr = r * (1 + wobble * (0.6 * Math.sin(k1 * a + phase) + 0.4 * Math.sin(k2 * a - phase)));
      var px = cx + rr * Math.cos(a), py = cy + rr * Math.sin(a);
      if (i === 0) { ctx.moveTo(px, py); } else { ctx.lineTo(px, py); }
    }
    ctx.closePath();
  }

  function ellipse(x, y, rx, ry, rot, fill) {
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, rot, 0, TAU);
    ctx.fillStyle = fill;
    ctx.fill();
  }

  // ---- static background: mottled eosin stroma with collagen fibres ---------
  function buildStroma(rand) {
    var off = document.createElement('canvas');
    off.width = Math.round(W * DPR);
    off.height = Math.round(H * DPR);
    var c = off.getContext('2d');
    c.setTransform(DPR, 0, 0, DPR, 0, 0);
    c.fillStyle = '#f5d3e0';
    c.fillRect(0, 0, W, H);

    // low-frequency mottling
    for (var i = 0; i < 46; i++) {
      var x = rand() * W, y = rand() * H, r = H * (0.12 + rand() * 0.28);
      var g = c.createRadialGradient(x, y, 0, x, y, r);
      var dark = rand() < 0.5;
      g.addColorStop(0, dark ? 'rgba(232,164,194,0.38)' : 'rgba(250,224,234,0.45)');
      g.addColorStop(1, 'rgba(240,190,212,0)');
      c.fillStyle = g;
      c.fillRect(x - r, y - r, r * 2, r * 2);
    }

    // collagen fibres following the (frozen) flow field
    c.lineCap = 'round';
    for (var f = 0; f < Math.round(W * H / 1500); f++) {
      var fx = rand() * W, fy = rand() * H;
      var steps = 8 + Math.floor(rand() * 22);
      c.beginPath();
      c.moveTo(fx, fy);
      for (var s = 0; s < steps; s++) {
        var a = flowAngle(fx, fy, 0) + (rand() - 0.5) * 0.5;
        fx += 6 * Math.cos(a);
        fy += 6 * Math.sin(a);
        c.lineTo(fx, fy);
      }
      c.strokeStyle = 'rgba(214,128,172,' + (0.08 + rand() * 0.16).toFixed(3) + ')';
      c.lineWidth = rand() < 0.8 ? 1 : 1.6;
      c.stroke();
    }
    return off;
  }

  // ---- population -------------------------------------------------------------
  function populate() {
    var rand = mulberry32(20261214);
    stroma = buildStroma(rand);

    glands = [];
    var count = Math.max(3, Math.min(8, Math.round(W / 210)));
    var tries = 0;
    while (glands.length < count && tries < 3000) {
      tries++;
      var R = H * (0.09 + rand() * 0.08);
      var gx = W * 0.22 + rand() * (W * 0.78 + R), gy = rand() * H;
      var ok = true;
      for (var i = 0; i < glands.length; i++) {
        var o = glands[i];
        if (Math.hypot(gx - o.x, gy - o.y) < (R + o.R) * 1.3) { ok = false; break; }
      }
      if (!ok) { continue; }
      var rl = R * (0.38 + rand() * 0.12);
      var rn = rl + (R - rl) * 0.45;
      var n = Math.max(14, Math.round(TAU * rn / 9.5));
      var nuclei = [];
      for (var k = 0; k < n; k++) {
        nuclei.push({
          a: TAU * k / n + (rand() - 0.5) * 0.08,
          dr: (rand() - 0.5) * 2.4,
          len: (R - rl) * (0.20 + rand() * 0.07),
          wid: 2.6 + rand() * 0.8,
          tint: Math.floor(rand() * 3),
          spot: (rand() - 0.5) * 2
        });
      }
      glands.push({
        x: gx, y: gy, R: R, rl: rl, n: n, nuclei: nuclei,
        phase: rand() * TAU, k1: 2 + Math.floor(rand() * 2), k2: 4 + Math.floor(rand() * 3),
        rot: rand() * TAU, omega: SETTINGS.glandRotation * (rand() < 0.5 ? 1 : -1) * (0.7 + rand() * 0.6),
        dir: rand() * TAU, band: 'rgba(' + (222 + Math.floor(rand() * 8)) + ',' + (168 + Math.floor(rand() * 10)) + ',' + (202 + Math.floor(rand() * 8)) + ',0.94)'
      });
    }

    spindles = [];
    var ns = Math.round(W * H / SETTINGS.spindleDensity);
    for (var s = 0; s < ns; s++) {
      spindles.push({
        x: rand() * W, y: rand() * H, ang: rand() * TAU,
        len: 6 + rand() * 4, wid: 1.8 + rand() * 1.2,
        speed: SETTINGS.spindleSpeed * (0.7 + rand() * 0.6),
        shade: Math.floor(rand() * 3)
      });
    }

    lymphs = [];
    var nl = Math.round(W * H / SETTINGS.lymphDensity);
    for (var l = 0; l < nl; l++) {
      lymphs.push({
        x: rand() * W, y: rand() * H, r: 2.8 + rand() * 1.4,
        dir: rand() * TAU, speed: SETTINGS.lymphSpeed * (0.6 + rand() * 0.8), wob: rand() * TAU
      });
    }
  }

  var NUCLEUS = ['rgb(58,28,100)', 'rgb(66,34,108)', 'rgb(52,24,92)'];
  var SPINDLE = ['rgba(78,44,118,0.9)', 'rgba(70,38,112,0.9)', 'rgba(86,50,124,0.9)'];

  function drawGland(g, t) {
    var breath = 1 + SETTINGS.breath * Math.sin(t * 0.7 + g.phase);
    var R = g.R * breath, rl = g.rl * breath;
    var rot = g.rot + t * g.omega;
    var wob = g.phase + t * 0.02;

    blobPath(g.x, g.y, R, 0.12, wob, g.k1, g.k2);
    ctx.fillStyle = g.band;
    ctx.fill();
    blobPath(g.x, g.y, R * 0.93, 0.12, wob, g.k1, g.k2);
    ctx.fillStyle = 'rgba(236,190,216,1)';
    ctx.fill();

    // faint radial cell borders
    ctx.strokeStyle = 'rgba(196,130,172,0.42)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var k = 0; k < g.n; k++) {
      var a = TAU * (k + 0.5) / g.n + rot;
      ctx.moveTo(g.x + rl * 1.02 * Math.cos(a), g.y + rl * 1.02 * Math.sin(a));
      ctx.lineTo(g.x + R * 0.95 * Math.cos(a), g.y + R * 0.95 * Math.sin(a));
    }
    ctx.stroke();

    // basal row of elongated nuclei
    var rn = rl + (R - rl) * 0.45;
    for (var i = 0; i < g.nuclei.length; i++) {
      var nu = g.nuclei[i];
      var an = nu.a + rot;
      var rr = rn * (1 + 0.05 * Math.sin(3 * an + g.phase)) + nu.dr;
      var nx = g.x + rr * Math.cos(an), ny = g.y + rr * Math.sin(an);
      ellipse(nx, ny, nu.len * breath, nu.wid, an, NUCLEUS[nu.tint]);
      ellipse(nx + nu.spot * 0.6, ny + nu.spot * 0.4, nu.len * 0.3, nu.wid * 0.35, an, 'rgba(128,88,168,0.28)');
    }

    // lumen
    blobPath(g.x, g.y, rl, 0.22, wob + 1.3, g.k1, g.k2);
    ctx.fillStyle = 'rgba(252,240,246,0.95)';
    ctx.fill();
    blobPath(g.x, g.y, rl * 0.8, 0.25, wob + 2.1, g.k1, g.k2);
    ctx.fillStyle = 'rgb(254,247,250)';
    ctx.fill();
  }

  function wrap(o, margin) {
    if (o.x < -margin) { o.x += W + margin * 2; } else if (o.x > W + margin) { o.x -= W + margin * 2; }
    if (o.y < -margin) { o.y += H + margin * 2; } else if (o.y > H + margin) { o.y -= H + margin * 2; }
  }

  function update(dt, t) {
    var i, o, a, d;
    for (i = 0; i < spindles.length; i++) {
      o = spindles[i];
      a = flowAngle(o.x, o.y, t);
      o.x += Math.cos(a) * o.speed * dt;
      o.y += Math.sin(a) * o.speed * dt;
      d = a - o.ang;
      d = Math.atan2(Math.sin(d), Math.cos(d));   // shortest turn
      o.ang += d * Math.min(1, dt * 0.8);
      wrap(o, 20);
    }
    for (i = 0; i < lymphs.length; i++) {
      o = lymphs[i];
      a = flowAngle(o.x, o.y, t) * 0.6 + o.dir * 0.4 + 0.3 * Math.sin(t * 0.5 + o.wob);
      o.x += Math.cos(a) * o.speed * dt;
      o.y += Math.sin(a) * o.speed * dt;
      wrap(o, 10);
    }
    for (i = 0; i < glands.length; i++) {
      o = glands[i];
      o.x += Math.cos(o.dir) * SETTINGS.glandSpeed * dt;
      o.y += Math.sin(o.dir) * SETTINGS.glandSpeed * dt * 0.4;
      wrap(o, o.R * 1.3);
    }
  }

  function render(t) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.drawImage(stroma, 0, 0, W, H);
    var i, o;
    for (i = 0; i < spindles.length; i++) {
      o = spindles[i];
      ellipse(o.x, o.y, o.len, o.wid, o.ang, SPINDLE[o.shade]);
    }
    for (i = 0; i < lymphs.length; i++) {
      o = lymphs[i];
      ellipse(o.x, o.y, o.r, o.r * 0.92, 0, 'rgba(52,26,92,0.94)');
    }
    for (i = 0; i < glands.length; i++) { drawGland(glands[i], t); }
  }

  // ---- lifecycle --------------------------------------------------------------
  var running = false, visible = true, last = 0, elapsed = 0, resizeTimer = null;
  var frameMin = 1000 / SETTINGS.fps;

  function resize() {
    var w = header.clientWidth, h = header.clientHeight;
    if (!w || !h) { return; }
    W = w; H = h;
    DPR = Math.min(window.devicePixelRatio || 1, SETTINGS.maxDpr);
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    populate();
    render(elapsed);
  }

  function frame(now) {
    if (!running) { return; }
    requestAnimationFrame(frame);
    if (!visible || document.hidden) { last = now; return; }
    var dtMs = now - last;
    if (dtMs < frameMin) { return; }
    last = now;
    var dt = Math.min(dtMs, 100) / 1000;   // seconds, clamped after tab switches
    elapsed += dt;
    update(dt, elapsed);
    render(elapsed);
  }

  resize();
  if (reduceMotion) { return; }              // one still frame is enough

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
    }, { threshold: 0 }).observe(header);
  }
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 150);
  });

  running = true;
  last = performance.now();
  requestAnimationFrame(frame);
})();
