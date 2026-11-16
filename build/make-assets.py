#!/usr/bin/env python3
"""Erzeugt Icon (ico/png) und Installer-Grafiken. Aufruf: python3 build/make-assets.py [Akzentfarbe #RRGGBB] [Kurzname]
Alles wird aus product.json-Werten gezeichnet, damit Weiterverkäufer eigene Farben/Namen bekommen."""
import sys, os, math
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageChops

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'assets')
os.makedirs(OUT, exist_ok=True)
accent = sys.argv[1] if len(sys.argv) > 1 else '#B026FF'
brand = sys.argv[2] if len(sys.argv) > 2 else 'UNKNOWN'

def hex2rgb(h): h = h.lstrip('#'); return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))
A = hex2rgb(accent)
CY = (0, 240, 255)
S = 1024

def glow(layer, radius, strength=1.0):
    b = layer.filter(ImageFilter.GaussianBlur(radius))
    if strength != 1.0:
        r, g, bl, a = b.split(); a = a.point(lambda v: min(255, int(v * strength))); b = Image.merge('RGBA', (r, g, bl, a))
    return b

def icon_image():
    base = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    # Hintergrund: abgerundetes Quadrat mit dunklem Verlauf
    bg = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    grad = Image.new('RGBA', (S, S))
    gp = grad.load()
    for y in range(S):
        for x in range(S):
            t = (x + y) / (2 * S)
            gp[x, y] = (int(10 + 26 * t), int(6 + 6 * t), int(22 + 40 * t), 255)
    mask = Image.new('L', (S, S), 0); ImageDraw.Draw(mask).rounded_rectangle((24, 24, S - 24, S - 24), radius=230, fill=255)
    bg.paste(grad, (0, 0), mask)
    base = Image.alpha_composite(base, bg)

    # Neon-Rand
    ring = Image.new('RGBA', (S, S), (0, 0, 0, 0)); d = ImageDraw.Draw(ring)
    d.rounded_rectangle((24, 24, S - 24, S - 24), radius=230, outline=A + (255,), width=14)
    base = Image.alpha_composite(base, glow(ring, 22, 1.6)); base = Image.alpha_composite(base, ring)

    # Kapuze (Silhouette)
    hood = Image.new('RGBA', (S, S), (0, 0, 0, 0)); d = ImageDraw.Draw(hood)
    cx = S // 2
    pts = [(cx, 150), (cx + 40, 160), (cx + 150, 235), (cx + 240, 360), (cx + 285, 520), (cx + 300, 700), (cx + 380, 830), (cx + 380, 905),
           (cx - 380, 905), (cx - 380, 830), (cx - 300, 700), (cx - 285, 520), (cx - 240, 360), (cx - 150, 235), (cx - 40, 160)]
    d.polygon(pts, fill=(7, 3, 14, 255), outline=None)
    hood_edge = Image.new('RGBA', (S, S), (0, 0, 0, 0)); de = ImageDraw.Draw(hood_edge)
    de.line(pts + [pts[0]], fill=A + (255,), width=10, joint='curve')
    base = Image.alpha_composite(base, glow(hood_edge, 14, 1.4)); base = Image.alpha_composite(base, hood)
    base = Image.alpha_composite(base, hood_edge)

    # Gesichtsöffnung (dunkel) und Maske
    face = Image.new('RGBA', (S, S), (0, 0, 0, 0)); d = ImageDraw.Draw(face)
    d.ellipse((cx - 175, 330, cx + 175, 700), fill=(2, 1, 6, 255))
    base = Image.alpha_composite(base, face)
    mask_l = Image.new('RGBA', (S, S), (0, 0, 0, 0)); d = ImageDraw.Draw(mask_l)
    d.polygon([(cx - 195, 470), (cx + 195, 470), (cx + 170, 600), (cx + 60, 640), (cx - 60, 640), (cx - 170, 600)], fill=(16, 8, 30, 255), outline=A + (255,), width=8)
    base = Image.alpha_composite(base, mask_l)
    # leuchtende Augenschlitze
    eyes = Image.new('RGBA', (S, S), (0, 0, 0, 0)); d = ImageDraw.Draw(eyes)
    d.polygon([(cx - 150, 505), (cx - 40, 520), (cx - 62, 552), (cx - 140, 540)], fill=CY + (255,))
    d.polygon([(cx + 150, 505), (cx + 40, 520), (cx + 62, 552), (cx + 140, 540)], fill=CY + (255,))
    base = Image.alpha_composite(base, glow(eyes, 20, 2.2)); base = Image.alpha_composite(base, eyes)
    # Mund-Gitter der Maske
    lines = Image.new('RGBA', (S, S), (0, 0, 0, 0)); d = ImageDraw.Draw(lines)
    for i, x in enumerate(range(cx - 80, cx + 81, 40)):
        d.line((x, 585, x - (cx - x) * 0.12, 622), fill=A + (255,), width=7)
    base = Image.alpha_composite(base, glow(lines, 8, 1.3)); base = Image.alpha_composite(base, lines)

    # Glitch-Streifen: waagerechte Bänder seitlich versetzt
    out = base.copy()
    for (y0, y1, dx) in [(250, 282, 34), (410, 430, -46), (700, 735, 52), (800, 818, -30)]:
        band = base.crop((0, y0, S, y1)); out.paste(band, (dx, y0), band)
    # Magenta/Cyan-Versatz auf dem Rand (chromatische Aberration)
    return out

def save_icon():
    big = icon_image()
    big.save(os.path.join(OUT, 'icon-1024.png'))
    big.resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, 'icon.png'))
    sizes = [16, 24, 32, 48, 64, 128, 256]
    imgs = [big.resize((s, s), Image.LANCZOS) for s in sizes]
    imgs[-1].save(os.path.join(OUT, 'icon.ico'), format='ICO', sizes=[(s, s) for s in sizes], append_images=imgs[:-1])
    return big

def font(size, bold=True):
    for p in ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf']:
        if os.path.exists(p): return ImageFont.truetype(p, size)
    return ImageFont.load_default()

def installer_images(big):
    # Willkommensseite 164x314, Kopfzeile 150x57 (BMP 24 Bit, wie NSIS es verlangt)
    W, H = 164, 314
    im = Image.new('RGB', (W, H), (11, 7, 20))
    px = im.load()
    for y in range(H):
        for x in range(W):
            t = y / H
            px[x, y] = (int(11 + 40 * t * (A[0] / 255)), int(7 + 8 * t), int(20 + 70 * t * (A[2] / 255)))
    ic = big.resize((120, 120), Image.LANCZOS); im.paste(ic, (22, 40), ic)
    d = ImageDraw.Draw(im)
    d.text((W // 2, 190), brand.upper(), font=font(20), fill=(255, 255, 255), anchor='mm')
    d.text((W // 2, 214), 'CHAT CONTROL', font=font(11), fill=A, anchor='mm')
    d.line((24, 236, W - 24, 236), fill=A, width=1)
    im.save(os.path.join(OUT, 'installer-side.bmp'), 'BMP')
    h = Image.new('RGB', (150, 57), (11, 7, 20)); d = ImageDraw.Draw(h)
    ic = big.resize((44, 44), Image.LANCZOS); h.paste(ic, (100, 6), ic)
    d.line((0, 56, 150, 56), fill=A, width=1)
    d.text((8, 28), brand.upper(), font=font(13), fill=(255, 255, 255), anchor='lm')
    h.save(os.path.join(OUT, 'installer-header.bmp'), 'BMP')

big = save_icon()
installer_images(big)
print('Assets geschrieben nach', OUT)
