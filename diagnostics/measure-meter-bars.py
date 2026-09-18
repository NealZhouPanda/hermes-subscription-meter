#!/usr/bin/env python3
"""看板视觉验收：从截图里按像素判定每行格子条的「锁定 / 富余 / 剩余 / 已消耗」段。

为什么需要它：视觉模型的读数不可靠——它会把深绿（剩余受限）当成翠绿（正常剩余），
同一张图两次读数互相矛盾（一次说 MINIMAX 无锁定段、一次说有）。像素判定是确定的。

用法：
    screencapture -x -R "<窗口bounds>" -o /tmp/meter.png     # 只截 Hermes 窗口
    python3 measure-meter-bars.py /tmp/meter.png

注意（Neal 2026-09-16 指出）：格子宽度随窗口宽度自适应，**不能假设固定格宽**，
所以本脚本从「整列皆背景」的间隙反推真实格子边界，再逐格取中心像素判色。

格子数 N 恒为 84；锁定格预期 = (周剩余% − min(周剩余%, 5h剩余% × 份额)) / 100 × 84。
份额来源：M1 起由后端写在周期行的 burstShare（旧表兜底 CODEX 0.15 / GLM 0.2 / KIMI 0.2）。
"""
import sys
from PIL import Image

PALETTE = {
    "t": (235, 237, 246),  # track：已流逝 + 已消耗
    "b": (83, 165, 219),   # 天蓝：已流逝 + 未消耗（富余）
    "B": (32, 72, 152),    # 深蓝：富余且被 5h 窗锁定
    "g": (81, 172, 111),   # 翠绿：未流逝 + 未消耗（剩余）
    "G": (44, 104, 58),    # 深绿：剩余且被 5h 窗锁定
    "o": (243, 152, 0),    # 橙：未流逝 + 已消耗（超额）
    ".": (254, 254, 254),  # 背景
}
LOCKED = ("B", "G")


def classify(rgb, tol=40):
    best, best_d = "?", 10 ** 9
    for key, ref in PALETTE.items():
        d = sum(abs(rgb[i] - ref[i]) for i in range(3))
        if d < best_d:
            best_d, best = d, key
    return best if best_d < tol else "?"


def band_rows(px, x0, x1, y0, y1, min_hits=120):
    """找出格子条所在的横条带（一行一个）。"""
    bands, cur = [], None
    for y in range(y0, y1):
        hits = sum(1 for x in range(x0, x1, 3) if classify(px[x, y]) != ".")
        if hits >= min_hits:
            cur = [y, y] if cur is None else [cur[0], y]
        elif cur and y - cur[1] > 4:
            bands.append(tuple(cur))
            cur = None
    if cur:
        bands.append(tuple(cur))
    return [b for b in bands if b[1] - b[0] >= 8]


def read_row(px, ya, yb, x0=1180, x1=2742):
    """按列间隙定位真实格子，逐格判色，返回色码串。"""
    gaps = []
    for x in range(x0, x1):
        if max(sum(abs(px[x, y][i] - 254) for i in range(3)) for y in range(ya, yb + 1)) < 14:
            gaps.append(x)
    seps, cur = [], None
    for x in gaps:
        if cur and x - cur[1] <= 2:
            cur[1] = x
        else:
            if cur:
                seps.append((cur[0] + cur[1]) / 2)
            cur = [x, x]
    if cur:
        seps.append((cur[0] + cur[1]) / 2)
    ym = (ya + yb) // 2
    codes = []
    for i in range(1, len(seps)):
        a, b = seps[i - 1], seps[i]
        if not 12 <= b - a <= 28:
            continue
        codes.append(classify(px[int((a + b) / 2), ym]))
    return codes


def main(path):
    im = Image.open(path).convert("RGB")
    px = im.load()
    w, h = im.size
    print(f"图像 {w}x{h}")
    for i, (ya, yb) in enumerate(band_rows(px, 600, w, 40, min(h, 700)), 1):
        codes = read_row(px, ya, yb)
        if len(codes) < 60:   # 余额/标题等文字行不是格子条，跳过
            continue
        locked = sum(1 for c in codes if c in LOCKED)
        detail = {k: codes.count(k) for k in "tbBgGo." if codes.count(k)}
        print(f"第{i}行 y={ya}-{yb} 格数 {len(codes):2d} 锁定 {locked:2d}/84  明细 {detail}")
        print("       " + "".join(codes))
    print("\n图例 t=track b=富余 B=富余受限(锁) g=剩余 G=剩余受限(锁) o=超额 .=背景")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/sm-m1-verify3.png")
