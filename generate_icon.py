#!/usr/bin/env python3
"""Generate icon.png (128x128) for the LockSettle VS Code extension.

Rounded-square gradient background drawn at 4x and downscaled with LANCZOS. Design: an
indigo-to-violet gradient with a white padlock; the lock body carries a merge glyph (two
branch lines joining into one) cut out in the background colour.
"""

from PIL import Image, ImageDraw

SIZE = 128
SCALE = 4
BIG = SIZE * SCALE

TOP_COLOR = (67, 56, 202)      # indigo
BOTTOM_COLOR = (139, 44, 214)  # violet


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_gradient_bg(size, top_color, bottom_color, radius_ratio=0.22):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gradient = Image.new("RGB", (size, size))
    gdraw = ImageDraw.Draw(gradient)
    for y in range(size):
        gdraw.line([(0, y), (size, y)], fill=lerp(top_color, bottom_color, y / (size - 1)))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([(0, 0), (size - 1, size - 1)], radius=int(size * radius_ratio), fill=255)
    img.paste(gradient, (0, 0))
    img.putalpha(mask)
    return img


def draw_glyph(img):
    s = img.size[0]
    d = ImageDraw.Draw(img)
    white = (255, 255, 255, 255)

    # Shackle.
    sw = int(s * 0.075)
    sl, sr = int(s * 0.32), int(s * 0.68)
    st, sb = int(s * 0.14), int(s * 0.50)
    d.arc([(sl, st), (sr, st + (sr - sl))], start=180, end=360, fill=white, width=sw)
    mid = st + (sr - sl) // 2
    d.rectangle([(sl, mid), (sl + sw, sb)], fill=white)
    d.rectangle([(sr - sw, mid), (sr, sb)], fill=white)

    # Body.
    bl, br = int(s * 0.20), int(s * 0.80)
    bt, bb = int(s * 0.42), int(s * 0.86)
    d.rounded_rectangle([(bl, bt), (br, bb)], radius=int(s * 0.07), fill=white)

    # Merge glyph cut into the body, in the gradient colour at that height.
    col = lerp(TOP_COLOR, BOTTOM_COLOR, 0.66) + (255,)
    lw = int(s * 0.045)
    r = int(s * 0.042)
    left_top = (int(s * 0.40), int(s * 0.52))
    right_top = (int(s * 0.60), int(s * 0.52))
    join = (int(s * 0.50), int(s * 0.66))
    bottom = (int(s * 0.50), int(s * 0.77))
    d.line([left_top, join], fill=col, width=lw)
    d.line([right_top, join], fill=col, width=lw)
    d.line([join, bottom], fill=col, width=lw)
    for (x, y) in (left_top, right_top, bottom):
        d.ellipse([(x - r, y - r), (x + r, y + r)], fill=col)
    jr = lw // 2
    d.ellipse([(join[0] - jr, join[1] - jr), (join[0] + jr, join[1] + jr)], fill=col)


def main():
    big = rounded_gradient_bg(BIG, TOP_COLOR, BOTTOM_COLOR)
    draw_glyph(big)
    final = big.resize((SIZE, SIZE), Image.LANCZOS)
    final.save("icon.png")
    print("Wrote icon.png (%dx%d)" % (SIZE, SIZE))


if __name__ == "__main__":
    main()
