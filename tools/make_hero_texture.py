#!/usr/bin/env python3
"""
Generate a seamless, procedurally drawn H&E-style tissue tile for the hero header.

The tile imitates a hematoxylin & eosin stained section: pink eosinophilic stroma
with wavy collagen fibres, glands (a pale lumen ringed by columnar epithelium with
radially oriented purple nuclei), scattered spindle-shaped stromal nuclei and small
round lymphocytes. Everything is drawn with wrap-around so the image tiles seamlessly.

Usage:
    python3 tools/make_hero_texture.py            # writes assets/img/hero-he.jpg
    python3 tools/make_hero_texture.py --seed 7   # a different arrangement

Requires: pillow, numpy
"""
import argparse
import math
import pathlib

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE.parent / "assets" / "img" / "hero-he.jpg"


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def fractal_noise(rng, w, h, octaves=(8, 16, 32, 64), weights=(0.5, 0.25, 0.15, 0.10)):
    """Tileable value noise in [0, 1] built from up-sampled random grids."""
    acc = np.zeros((h, w), dtype=np.float32)
    for cells, wgt in zip(octaves, weights):
        grid = rng.random((cells, cells)).astype(np.float32)
        # bicubic up-sample of a periodic grid -> seamless
        img = Image.fromarray((np.tile(grid, (3, 3)) * 255).astype(np.uint8))
        big = img.resize((w * 3, h * 3), Image.BICUBIC)
        arr = np.asarray(big, dtype=np.float32)[h:2 * h, w:2 * w] / 255.0
        acc += arr * wgt
    acc -= acc.min()
    acc /= max(acc.max(), 1e-6)
    return acc


class WrapDraw:
    """Draws every primitive nine times (offset by ±W, ±H) so the tile is seamless."""

    def __init__(self, layer, w, h):
        self.draw = ImageDraw.Draw(layer, "RGBA")
        self.offsets = [(dx, dy) for dx in (-w, 0, w) for dy in (-h, 0, h)]

    def polygon(self, pts, **kw):
        for dx, dy in self.offsets:
            self.draw.polygon([(x + dx, y + dy) for x, y in pts], **kw)

    def line(self, pts, **kw):
        for dx, dy in self.offsets:
            self.draw.line([(x + dx, y + dy) for x, y in pts], **kw)

    def ellipse_rot(self, cx, cy, a, b, angle, **kw):
        """Rotated ellipse (semi-axes a, b) as a polygon."""
        pts = []
        ca, sa = math.cos(angle), math.sin(angle)
        for k in range(28):
            t = 2 * math.pi * k / 28
            x, y = a * math.cos(t), b * math.sin(t)
            pts.append((cx + x * ca - y * sa, cy + x * sa + y * ca))
        self.polygon(pts, **kw)


def jitter(rng, rgb, amount):
    return tuple(int(np.clip(c + rng.integers(-amount, amount + 1), 0, 255)) for c in rgb)


def blob(rng, cx, cy, r, wobble=0.18, n=40, phase=None):
    """Irregular closed outline around (cx, cy) with mean radius r."""
    phase = rng.random() * 6.283 if phase is None else phase
    k1, k2 = rng.integers(2, 4), rng.integers(4, 7)
    pts = []
    for i in range(n):
        t = 2 * math.pi * i / n
        rr = r * (1 + wobble * (0.6 * math.sin(k1 * t + phase) + 0.4 * math.sin(k2 * t - phase)))
        pts.append((cx + rr * math.cos(t), cy + rr * math.sin(t)))
    return pts


# --------------------------------------------------------------------------- #
# main drawing routine
# --------------------------------------------------------------------------- #
def make_tile(w=1600, h=1000, seed=2026, n_glands=9):
    rng = np.random.default_rng(seed)

    # 1. eosin stroma: pale pink with low-frequency mottling -----------------
    n = fractal_noise(rng, w, h)
    light = np.array([248, 214, 226], dtype=np.float32)
    mid = np.array([232, 164, 194], dtype=np.float32)
    base = light[None, None, :] * (1 - n[..., None]) + mid[None, None, :] * n[..., None]
    img = Image.fromarray(base.astype(np.uint8), "RGB").convert("RGBA")

    # 2. collagen fibres following a smooth flow field ------------------------
    flow = fractal_noise(rng, w, h, octaves=(3, 6), weights=(0.7, 0.3)) * 2 * math.pi
    fibres = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    fd = WrapDraw(fibres, w, h)
    for _ in range(1600):
        x, y = rng.random() * w, rng.random() * h
        pts = [(x, y)]
        for _ in range(rng.integers(10, 34)):
            a = flow[int(y) % h, int(x) % w] + rng.normal(0, 0.22)
            x, y = x + 6 * math.cos(a), y + 6 * math.sin(a)
            pts.append((x, y))
        col = jitter(rng, (218, 132, 176), 14) + (int(rng.integers(22, 62)),)
        fd.line(pts, fill=col, width=1 if rng.random() < 0.8 else 2)
    fibres = fibres.filter(ImageFilter.GaussianBlur(0.6))
    img.alpha_composite(fibres)

    # 3. glands: lumen + epithelial ring with radial nuclei --------------------
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = WrapDraw(layer, w, h)
    centers = []
    tries = 0
    while len(centers) < n_glands and tries < 4000:
        tries += 1
        cx, cy = rng.random() * w, rng.random() * h
        R = rng.uniform(70, 135)
        ok = True
        for (ox, oy, oR) in centers:
            dx = min(abs(cx - ox), w - abs(cx - ox))
            dy = min(abs(cy - oy), h - abs(cy - oy))
            if math.hypot(dx, dy) < (R + oR) * 1.25:
                ok = False
                break
        if ok:
            centers.append((cx, cy, R))

    for (cx, cy, R) in centers:
        r_l = R * rng.uniform(0.38, 0.5)
        phase = rng.random() * 6.283
        # epithelium band (slightly darker, more purple-pink than stroma)
        d.polygon(blob(rng, cx, cy, R, wobble=0.12, phase=phase), fill=jitter(rng, (226, 172, 206), 8) + (235,))
        d.polygon(blob(rng, cx, cy, R * 0.93, wobble=0.12, phase=phase), fill=jitter(rng, (236, 190, 216), 8) + (255,))
        # columnar epithelium: faint cell borders radiating from the lumen, then a
        # crowded basal row of elongated nuclei
        r_n = r_l + (R - r_l) * 0.45
        count = max(14, int(2 * math.pi * r_n / 9.5))
        for k in range(count):
            t = 2 * math.pi * (k + 0.5) / count
            p0 = (cx + r_l * 1.02 * math.cos(t), cy + r_l * 1.02 * math.sin(t))
            p1 = (cx + R * 0.95 * math.cos(t), cy + R * 0.95 * math.sin(t))
            d.line([p0, p1], fill=(196, 130, 172, 110), width=1)
        for k in range(count):
            t = 2 * math.pi * k / count + rng.normal(0, 0.04)
            rr = r_n * (1 + 0.05 * math.sin(3 * t + phase)) + rng.normal(0, 1.2)
            nx, ny = cx + rr * math.cos(t), cy + rr * math.sin(t)
            a = (R - r_l) * rng.uniform(0.20, 0.27)   # radial half-length
            b = rng.uniform(2.6, 3.4)                  # half-width
            col = jitter(rng, (58, 28, 100), 12) + (250,)
            d.ellipse_rot(nx, ny, a, b, t + rng.normal(0, 0.10), fill=col)
            # a small paler spot suggests chromatin texture
            d.ellipse_rot(nx + rng.normal(0, 1), ny + rng.normal(0, 1), a * 0.3, b * 0.35, t, fill=(128, 88, 168, 70))
        # lumen (pale, slightly translucent so a little texture shows through)
        d.polygon(blob(rng, cx, cy, r_l, wobble=0.22, phase=phase + 1.3), fill=(252, 240, 246, 240))
        d.polygon(blob(rng, cx, cy, r_l * 0.8, wobble=0.25, phase=phase + 2.1), fill=(254, 247, 250, 255))

    # 4. stromal nuclei: spindle fibroblasts + round lymphocytes ------------------
    for _ in range(620):
        x, y = rng.random() * w, rng.random() * h
        if any(math.hypot(min(abs(x - cx), w - abs(x - cx)), min(abs(y - cy), h - abs(y - cy))) < R * 1.05
               for (cx, cy, R) in centers):
            continue
        a = flow[int(y) % h, int(x) % w] + rng.normal(0, 0.35)
        d.ellipse_rot(x, y, rng.uniform(6, 10), rng.uniform(1.8, 3.0), a, fill=jitter(rng, (78, 44, 118), 12) + (230,))
    for _ in range(220):
        x, y = rng.random() * w, rng.random() * h
        if any(math.hypot(min(abs(x - cx), w - abs(x - cx)), min(abs(y - cy), h - abs(y - cy))) < R * 1.05
               for (cx, cy, R) in centers):
            continue
        r = rng.uniform(3.0, 4.6)
        d.ellipse_rot(x, y, r, r * rng.uniform(0.8, 1.0), rng.random() * 3.14, fill=jitter(rng, (52, 26, 92), 10) + (240,))

    # small lymphoid aggregates: tight clusters of round dark nuclei
    for _ in range(4):
        x0, y0 = rng.random() * w, rng.random() * h
        if any(math.hypot(min(abs(x0 - cx), w - abs(x0 - cx)), min(abs(y0 - cy), h - abs(y0 - cy))) < R * 1.5
               for (cx, cy, R) in centers):
            continue
        for _ in range(int(rng.integers(35, 70))):
            ang, rad = rng.random() * 6.283, abs(rng.normal(0, 18))
            x, y = x0 + rad * math.cos(ang), y0 + rad * math.sin(ang)
            r = rng.uniform(2.8, 4.0)
            d.ellipse_rot(x, y, r, r * 0.9, rng.random() * 3.14, fill=jitter(rng, (48, 22, 88), 10) + (240,))

    # a few small capillaries: a thin wall around a lumen with red blood cells
    for _ in range(7):
        x, y = rng.random() * w, rng.random() * h
        if any(math.hypot(min(abs(x - cx), w - abs(x - cx)), min(abs(y - cy), h - abs(y - cy))) < R * 1.3
               for (cx, cy, R) in centers):
            continue
        r = rng.uniform(10, 17)
        d.polygon(blob(rng, x, y, r, wobble=0.15), fill=(150, 90, 150, 210))
        d.polygon(blob(rng, x, y, r * 0.7, wobble=0.15), fill=(246, 214, 222, 255))
        for _ in range(int(rng.integers(2, 6))):
            rx, ry = x + rng.normal(0, r * 0.3), y + rng.normal(0, r * 0.3)
            d.ellipse_rot(rx, ry, 3.2, 2.6, rng.random() * 3.14, fill=(222, 96, 112, 230))

    layer = layer.filter(ImageFilter.GaussianBlur(0.6))
    img.alpha_composite(layer)

    # 5. finish: gentle blur, film grain -------------------------------------------
    img = img.convert("RGB").filter(ImageFilter.GaussianBlur(0.5))
    arr = np.asarray(img, dtype=np.float32)
    arr += rng.normal(0, 2.2, arr.shape).astype(np.float32)
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=2026)
    ap.add_argument("--glands", type=int, default=9)
    ap.add_argument("--width", type=int, default=1600)
    ap.add_argument("--height", type=int, default=1000)
    ap.add_argument("--out", type=pathlib.Path, default=OUT)
    ap.add_argument("--quality", type=int, default=80)
    args = ap.parse_args()

    tile = make_tile(args.width, args.height, args.seed, args.glands)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    tile.save(args.out, "JPEG", quality=args.quality, optimize=True, progressive=True)
    print(f"wrote {args.out} ({args.out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
