export interface BrandColors {
  primaryColor?: string | null;
  accentColor?: string | null;
  backgroundColor?: string | null;
}

export function hexToRgb(hex: string): [number, number, number] | null {
  let normalized = hex.replace(/^#/, '');
  if (normalized.length === 3 || normalized.length === 4) {
    normalized = normalized.split('').map(c => c + c).join('');
  }
  if (normalized.length === 6 || normalized.length === 8) {
    return [
      parseInt(normalized.slice(0, 2), 16),
      parseInt(normalized.slice(2, 4), 16),
      parseInt(normalized.slice(4, 6), 16)
    ];
  }
  return null;
}

export function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
}

export function normalizeHex(hex: string | null | undefined): string | undefined {
  if (!hex) return undefined;
  const rgb = hexToRgb(hex);
  return rgb ? rgbToHex(rgb[0], rgb[1], rgb[2]) : undefined;
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return [h, s, l];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return [r * 255, g * 255, b * 255];
}

export function rgbToHslStr(r: number, g: number, b: number): string {
  const [h, s, l] = rgbToHsl(r, g, b);
  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

export function hexToHslStr(hex: string): string | null {
  const rgb = hexToRgb(hex);
  return rgb ? rgbToHslStr(rgb[0], rgb[1], rgb[2]) : null;
}

export function getLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const a = rgb.map(v => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
}

export function getContrastRatio(hex1: string, hex2: string): number {
  const l1 = getLuminance(hex1);
  const l2 = getLuminance(hex2);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export function getAccessibleForeground(bgHex: string): string {
  const ratioWhite = getContrastRatio(bgHex, "#ffffff");
  const ratioBlack = getContrastRatio(bgHex, "#000000");
  return ratioWhite > ratioBlack ? "#ffffff" : "#020617";
}

export function adjustLightness(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  let [r, g, b] = rgb;
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
  }
  
  l = Math.max(0, Math.min(1, l + amount));
  
  let r1, g1, b1;
  if (s === 0) {
    r1 = g1 = b1 = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r1 = hue2rgb(p, q, h + 1/3);
    g1 = hue2rgb(p, q, h);
    b1 = hue2rgb(p, q, h - 1/3);
  }
  
  return rgbToHex(r1 * 255, g1 * 255, b1 * 255);
}

export const THEME_CSS_VARS = [
  '--primary', '--primary-foreground', '--ring',
  '--accent', '--accent-foreground',
  '--background', '--foreground',
  '--card', '--card-foreground',
  '--popover', '--popover-foreground',
  '--muted', '--muted-foreground',
  '--border', '--input',
  '--sidebar', '--sidebar-background', '--sidebar-foreground',
  '--sidebar-primary', '--sidebar-primary-foreground',
  '--sidebar-border', '--sidebar-accent', '--sidebar-accent-foreground'
];

export function computeThemeVariables(brand: BrandColors, mode: "light" | "dark" = "light"): Record<string, string> {
  const vars: Record<string, string> = {};

  if (brand.primaryColor) {
    const p = normalizeHex(brand.primaryColor);
    if (p) {
      const pf = getAccessibleForeground(p);
      vars['--primary'] = hexToHslStr(p)!;
      vars['--primary-foreground'] = hexToHslStr(pf)!;
      vars['--ring'] = vars['--primary'];
      
      vars['--sidebar-primary'] = vars['--primary'];
      vars['--sidebar-primary-foreground'] = vars['--primary-foreground'];
    }
  }

  if (brand.accentColor) {
    const a = normalizeHex(brand.accentColor);
    if (a) {
      const af = getAccessibleForeground(a);
      vars['--accent'] = hexToHslStr(a)!;
      vars['--accent-foreground'] = hexToHslStr(af)!;
    }
  }

  if (brand.backgroundColor) {
    const rawBg = normalizeHex(brand.backgroundColor);
    if (rawBg) {
      let rgb = hexToRgb(rawBg)!;
      let [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
      
      if (mode === "dark") {
        l = Math.min(l, 0.15); // Clamp lightness for dark mode
      } else {
        l = Math.max(l, 0.95); // Clamp lightness for light mode
      }
      
      const adjRgb = hslToRgb(h, s, l);
      const bg = rgbToHex(adjRgb[0], adjRgb[1], adjRgb[2]);

      const fg = getAccessibleForeground(bg);
      vars['--background'] = hexToHslStr(bg)!;
      vars['--foreground'] = hexToHslStr(fg)!;
      
      vars['--card'] = hexToHslStr(bg)!;
      vars['--card-foreground'] = hexToHslStr(fg)!;
      
      vars['--popover'] = hexToHslStr(bg)!;
      vars['--popover-foreground'] = hexToHslStr(fg)!;

      const isDarkBg = getLuminance(bg) < 0.5;
      
      const mutedBg = isDarkBg ? adjustLightness(bg, 0.08) : adjustLightness(bg, -0.05);
      const mutedFg = isDarkBg ? adjustLightness(fg, -0.3) : adjustLightness(fg, 0.3);
      vars['--muted'] = hexToHslStr(mutedBg)!;
      vars['--muted-foreground'] = hexToHslStr(mutedFg)!;
      
      const border = isDarkBg ? adjustLightness(bg, 0.15) : adjustLightness(bg, -0.1);
      vars['--border'] = hexToHslStr(border)!;
      vars['--input'] = hexToHslStr(border)!;
      
      const sidebarBg = isDarkBg ? adjustLightness(bg, 0.03) : adjustLightness(bg, -0.03);
      vars['--sidebar'] = hexToHslStr(sidebarBg)!;
      vars['--sidebar-background'] = hexToHslStr(sidebarBg)!;
      vars['--sidebar-foreground'] = hexToHslStr(fg)!;
      vars['--sidebar-border'] = hexToHslStr(border)!;
      
      const sidebarAccent = isDarkBg ? adjustLightness(sidebarBg, 0.08) : adjustLightness(sidebarBg, -0.05);
      vars['--sidebar-accent'] = hexToHslStr(sidebarAccent)!;
      vars['--sidebar-accent-foreground'] = hexToHslStr(fg)!;
    }
  }

  // Brand colors serve both as fills and small text. In dark mode, preserve
  // their hue but lift their lightness against every themed surface.
  if (mode === "dark" && brand.primaryColor) {
    const primary = normalizeHex(brand.primaryColor);
    if (primary) {
      const parseHsl = (value: string) => {
        const [h, s, l] = value.split(" ").map(parseFloat);
        return rgbToHex(...hslToRgb(h / 360, s / 100, l / 100));
      };
      const surfaces = [
        vars["--background"] ?? "222 47% 7%",
        vars["--muted"] ?? "217 33% 17%",
        vars["--sidebar-accent"] ?? "217 33% 17%",
      ].map(parseHsl);
      const [h, s, initialLightness] = rgbToHsl(...hexToRgb(primary)!);
      let adjusted = primary;
      for (let l = initialLightness; l <= 1; l += 0.01) {
        adjusted = rgbToHex(...hslToRgb(h, s, l));
        // Extra margin for tinted badges and HSL rounding.
        if (surfaces.every(surface => getContrastRatio(adjusted, surface) >= 6)) break;
      }
      vars["--primary"] = hexToHslStr(adjusted)!;
      vars["--primary-foreground"] = hexToHslStr(getAccessibleForeground(adjusted))!;
      vars["--ring"] = vars["--primary"];
      vars["--sidebar-primary"] = vars["--primary"];
      vars["--sidebar-primary-foreground"] = vars["--primary-foreground"];
    }
  }

  return vars;
}
