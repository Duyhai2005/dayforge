type Color = { red: number; green: number; blue: number; alpha: number };

function channel(value: string): number {
  const parsed = value.endsWith("%") ? Number.parseFloat(value) * 2.55 : Number.parseFloat(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`Invalid CSS color channel: ${value}`);
  return Math.max(0, Math.min(255, parsed)) / 255;
}

function alpha(value: string | undefined): number {
  if (value === undefined) return 1;
  const parsed = value.endsWith("%") ? Number.parseFloat(value) / 100 : Number.parseFloat(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`Invalid CSS color alpha: ${value}`);
  return Math.max(0, Math.min(1, parsed));
}

function parseColor(value: string): Color {
  const normalized = value.trim().toLowerCase();
  if (normalized === "transparent") return { red: 0, green: 0, blue: 0, alpha: 0 };

  if (normalized.startsWith("#")) {
    const hex = normalized.slice(1);
    const expanded = hex.length === 3 || hex.length === 4
      ? [...hex].map((part) => `${part}${part}`).join("")
      : hex;
    if (!/^(?:[\da-f]{6}|[\da-f]{8})$/.test(expanded)) throw new TypeError(`Unsupported CSS color: ${value}`);
    return {
      red: Number.parseInt(expanded.slice(0, 2), 16) / 255,
      green: Number.parseInt(expanded.slice(2, 4), 16) / 255,
      blue: Number.parseInt(expanded.slice(4, 6), 16) / 255,
      alpha: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
    };
  }

  const match = normalized.match(/^rgba?\((.*)\)$/);
  if (!match) throw new TypeError(`Unsupported CSS color: ${value}`);
  const parts = match[1].replace("/", " ").split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) throw new TypeError(`Unsupported CSS color: ${value}`);
  return { red: channel(parts[0]), green: channel(parts[1]), blue: channel(parts[2]), alpha: alpha(parts[3]) };
}

function composite(foreground: Color, background: Color): Color {
  const outputAlpha = foreground.alpha + background.alpha * (1 - foreground.alpha);
  if (outputAlpha === 0) return { red: 0, green: 0, blue: 0, alpha: 0 };
  const blend = (front: number, back: number) => (front * foreground.alpha + back * background.alpha * (1 - foreground.alpha)) / outputAlpha;
  return { red: blend(foreground.red, background.red), green: blend(foreground.green, background.green), blue: blend(foreground.blue, background.blue), alpha: outputAlpha };
}

function linearize(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(color: Color): number {
  return 0.2126 * linearize(color.red) + 0.7152 * linearize(color.green) + 0.0722 * linearize(color.blue);
}

/** WCAG 2.x contrast ratio for CSS hex, rgb(), or rgba() colors. */
export function contrastRatio(foreground: string, background: string): number {
  const parsedBackground = parseColor(background);
  const opaqueBackground = parsedBackground.alpha === 1
    ? parsedBackground
    : composite(parsedBackground, { red: 0, green: 0, blue: 0, alpha: 1 });
  const renderedForeground = composite(parseColor(foreground), opaqueBackground);
  const light = Math.max(luminance(renderedForeground), luminance(opaqueBackground));
  const dark = Math.min(luminance(renderedForeground), luminance(opaqueBackground));
  return (light + 0.05) / (dark + 0.05);
}
