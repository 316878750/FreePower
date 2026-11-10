"""生成 FreePower 自己的图标（不引用任何第三方素材）。

设计：圆角方块 + 蓝青渐变 + 白色「浏览器窗口」轮廓 + 右上角一枚高亮圆点。
纯几何图形，自己画的，避免和别人撞标。

用法（Pillow 12）：
  python tools/make-icons.py
产物：
  desktop/assets/tray.png     32x32  托盘
  desktop/assets/tray@2x.png  64x64  高分屏托盘
  desktop/assets/icon.png     512x512 窗口/关于
  desktop/build/icon.ico      16..256 安装包与 exe 图标
"""
import math
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "desktop", "assets")
BUILD = os.path.join(ROOT, "desktop", "build")
S = 1024  # 先按 1024 画，最后缩，边缘才干净

C1 = (56, 132, 255)   # 亮蓝
C2 = (24, 60, 190)    # 深蓝


def rounded_mask(size, radius_ratio=0.22):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    r = int(size * radius_ratio)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
    return m


def gradient(size):
    img = Image.new("RGB", (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(1, size - 1)
        # 对角色阶：亮蓝 → 深蓝
        col = tuple(int(C1[i] + (C2[i] - C1[i]) * (t ** 0.85)) for i in range(3))
        d.line([(0, y), (size, y)], fill=col)
    return img


def draw_mark(img):
    """白色窗口轮廓 + 顶部地址栏 + 一枚圆点。"""
    d = ImageDraw.Draw(img)
    w, h = img.size
    # 窗口外框（内缩 26%）
    x0, y0, x1, y1 = w * 0.24, w * 0.28, w * 0.76, w * 0.72
    r = w * 0.06
    lw = int(w * 0.052)
    d.rounded_rectangle([x0, y0, x1, y1], radius=r, outline=(255, 255, 255, 255), width=lw)
    # 顶部地址栏横线
    ly = y0 + (y1 - y0) * 0.30
    d.line([x0 + lw * 0.9, ly, x1 - lw * 0.9, ly], fill=(255, 255, 255, 235), width=int(lw * 0.72))
    # 三个点（地址栏左侧）
    dot = w * 0.021
    for i in range(3):
        cx = x0 + (x1 - x0) * (0.16 + i * 0.115)
        cy = y0 + (y1 - y0) * 0.155
        d.ellipse([cx - dot, cy - dot, cx + dot, cy + dot], fill=(255, 255, 255, 220))
    # 右上角高亮
    cx, cy, r2 = w * 0.745, w * 0.265, w * 0.085
    d.ellipse([cx - r2, cy - r2, cx + r2, cy + r2], fill=(120, 230, 255, 255))


def build():
    base = gradient(S).convert("RGBA")
    draw_mark(base)
    base.putalpha(rounded_mask(S))
    os.makedirs(ASSETS, exist_ok=True)
    os.makedirs(BUILD, exist_ok=True)

    base.resize((512, 512), Image.LANCZOS).save(os.path.join(ASSETS, "icon.png"))
    base.resize((64, 64), Image.LANCZOS).save(os.path.join(ASSETS, "tray@2x.png"))
    base.resize((32, 32), Image.LANCZOS).save(os.path.join(ASSETS, "tray.png"))

    sizes = [16, 24, 32, 48, 64, 128, 256]
    base.resize((256, 256), Image.LANCZOS).save(
        os.path.join(BUILD, "icon.ico"),
        format="ICO",
        sizes=[(s, s) for s in sizes],
    )
    # 16px 下轮廓会糊，单独做一版：去掉小圆点和地址栏，只留窗口轮廓
    small = gradient(256).convert("RGBA")
    d = ImageDraw.Draw(small)
    d.rounded_rectangle([256 * 0.2, 256 * 0.25, 256 * 0.8, 256 * 0.75],
                        radius=256 * 0.08, outline=(255, 255, 255, 255), width=int(256 * 0.075))
    d.line([256 * 0.2 + 14, 256 * 0.40, 256 * 0.8 - 14, 256 * 0.40], fill=(255, 255, 255, 255), width=12)
    small.putalpha(rounded_mask(256))
    small.save(os.path.join(BUILD, "icon.ico"), format="ICO",
               sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    for p in ["desktop/assets/tray.png", "desktop/assets/tray@2x.png",
              "desktop/assets/icon.png", "desktop/build/icon.ico"]:
        f = os.path.join(ROOT, p)
        print(f"{p:32s} {os.path.getsize(f):>7d} bytes")


if __name__ == "__main__":
    build()