#!/usr/bin/env python3
"""Derive the two per-theme provider accents in identity.yaml.

Supplier accents are decoration: they tell you which company a row belongs to and
nothing on the board depends on telling two of them apart. So the only rule is
legibility on the theme the row is drawn on (see the 2026-09-29 entry in
docs/DEVELOPMENT_LOG.md):

  * light theme -> vs #FFFFFF, dark theme -> vs #0E1217 (the real theme cards);
  * floor 4.5:1, not the 3:1 a chart mark needs — the provider name and the
    balance amount are 10px text;
  * no pairwise ΔE floor and no colour-vision simulation: those belong to the
    matrix palette, where colour carries functional meaning.

The fit is deliberately minimal: start from the brand colour, and only if it does
not read on a theme, move *lightness* (hue and chroma kept) — scanning away from
the brand's own L* and stopping at the first value that clears the floor. If no
lightness works inside sRGB, chroma is stepped down and retried.

BRAND below is the source of truth for the brand colours. It is not read back out
of identity.yaml, because identity.yaml stores the *fitted* values. Change an
entry here, re-run, and copy the printed values into identity.yaml (both
`meta.accent` and `meta.accentDark`) plus the family pairs (qwen/qwen-dashscope,
minimax/minimax-cn share a colour), then run:

    ~/.hermes/hermes-agent/venv/bin/python -m pytest tests/test_identity_accents.py -q

Usage: python3 tools/fit-brand-accent.py [--json out.json]
"""

import argparse
import json
import math

import numpy as np

_M = np.array([[0.4124, 0.3576, 0.1805],
               [0.2126, 0.7152, 0.0722],
               [0.0193, 0.1192, 0.9505]])
_M_INV = np.linalg.inv(_M)

CARDS = {"light": "#FFFFFF", "dark": "#0E1217"}
FLOOR = 4.5

# Brand colours as the providers present themselves (MiMo's orange, Alibaba's
# orange, Claude's terracotta, DeepSeek's blue, …). XAI is black by brand: the
# dark value is a lifted grey rather than a different hue.
BRAND = {
    "kimi": "#14AE68",
    "glm": "#F39800",
    "qwen": "#B33800",
    "xai": "#0D1726",
    "deepseek": "#081DA0",
    "minimax": "#F20D4F",
    "xiaomi": "#CF4800",
    "codex": "#28A7E0",
    "grok": "#1DA1F2",
    "nous": "#6366F1",
    "commandcode": "#2DD4BF",
    "anthropic": "#8F3224",
    "openrouter": "#4900FA",
}


def _linear(channel: float) -> float:
    channel = channel / 255
    return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4


def _srgb(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return 255 * (value * 12.92 if value <= 0.0031308 else 1.055 * value ** (1 / 2.4) - 0.055)


def _rgb(hex_color: str) -> list[float]:
    return [int(hex_color[1 + i:3 + i], 16) for i in (0, 2, 4)]


def luminance(hex_color: str) -> float:
    r, g, b = (_linear(c) for c in _rgb(hex_color))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: str, b: str) -> float:
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def to_lab(hex_color: str) -> tuple[float, float, float]:
    r, g, b = (_linear(c) for c in _rgb(hex_color))
    x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
    f = lambda t: t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116  # noqa: E731
    fx, fy, fz = f(x), f(y), f(z)
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


def _lch_to_hex(lightness: float, chroma: float, hue: float) -> str | None:
    a = chroma * math.cos(math.radians(hue))
    b = chroma * math.sin(math.radians(hue))
    fy = (lightness + 16) / 116
    fx, fz = fy + a / 500, fy - b / 200
    finv = lambda t: t ** 3 if t ** 3 > 0.008856 else (t - 16 / 116) / 7.787  # noqa: E731
    linear = _M_INV @ np.array([0.95047 * finv(fx), finv(fy), 1.08883 * finv(fz)])
    if np.any(linear < -0.004) or np.any(linear > 1.004):
        return None
    return "#" + "".join(f"{int(round(v)):02x}" for v in (_srgb(c) for c in linear))


def fit(brand: str, theme: str) -> tuple[str | None, str]:
    """Return (colour, note) for one theme: unchanged if the brand colour reads."""
    card = CARDS[theme]
    if contrast(brand, card) >= FLOOR:
        return brand, "unchanged"
    lightness, a, b = to_lab(brand)
    hue = math.degrees(math.atan2(b, a)) % 360
    chroma = math.hypot(a, b)
    for scale in (1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.0):
        # Scan away from the brand's own lightness and take the first value that
        # clears the floor: darken for a light card, lift for a dark one.
        steps = np.arange(lightness, 1, -0.5) if theme == "light" else np.arange(lightness, 101, 0.5)
        for candidate_lightness in steps:
            candidate = _lch_to_hex(candidate_lightness, chroma * scale, hue)
            if candidate and contrast(candidate, card) >= FLOOR:
                note = "lightness only" if scale == 1.0 else f"chroma stepped to {scale:.0%}"
                return candidate, note
    return None, "no colour clears the floor"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", help="also write the result to this path")
    args = parser.parse_args()

    palette = {}
    failures = 0
    for provider, brand in BRAND.items():
        palette[provider] = {}
        for theme in ("light", "dark"):
            colour, note = fit(brand, theme)
            palette[provider][theme] = colour
            if colour is None:
                failures += 1
                print(f"{provider:12} {theme:5} {brand} -> FAILED ({note})")
                continue
            ratio = contrast(colour, CARDS[theme])
            print(f"{provider:12} {theme:5} {brand} -> {colour}  {ratio:5.2f}:1  {note}")
        print()

    if args.json:
        with open(args.json, "w", encoding="utf-8") as handle:
            json.dump(palette, handle, indent=2)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
