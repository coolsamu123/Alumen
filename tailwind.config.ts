import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";
import defaultColors from "tailwindcss/colors";

// Tokens are hex CSS variables, and Tailwind 3 can't apply an opacity modifier
// (`bg-surface-2/50`, `border-accent-border/60`) to a bare `var(--x)` — it
// silently skips generating the class. Mixing the variable with transparent
// gives Tailwind an `<alpha-value>` slot to fill, so every modifier works while
// inline `style={{ color: 'var(--x)' }}` usages stay untouched.
const token = (name: string) =>
  `color-mix(in srgb, var(${name}) calc(<alpha-value> * 100%), transparent)`;

// ── Theme-aware Tailwind palette ────────────────────────────────────────────
// Components were written for the dark theme: tinted-dark fills with bright
// text (`bg-purple-900/40 text-purple-200`). Instead of overriding those
// classes one by one for light (a whitelist that every new class escaped), the
// light theme mirrors the lightness scale: 900 → 100, 200 → 800, and so on.
// 500–700 are mid-tones that read on both grounds, so solid buttons with white
// text keep their color.
const HUES = [
  "slate", "gray", "zinc", "neutral", "stone", "red", "orange", "amber", "yellow",
  "lime", "green", "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet",
  "purple", "fuchsia", "pink", "rose",
];
const SHADES = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"];
const MIRRORED = new Set(["50", "100", "200", "300", "400", "800", "900", "950"]);
// Hues whose 300/400 are too pale for text on white go one step darker.
const PALE_HUES = new Set(["orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan", "sky"]);

function lightShade(hue: string, shade: string): string {
  switch (shade) {
    case "50": return "950";
    case "100": return "900";
    case "200": return "800";
    case "300": return PALE_HUES.has(hue) ? "800" : "700";
    case "400": return PALE_HUES.has(hue) ? "700" : "600";
    case "800": return "200";
    case "900": return "100";
    case "950": return "50";
    default: return shade;
  }
}

const hex = (hue: string, shade: string) =>
  (defaultColors as unknown as Record<string, Record<string, string>>)[hue][shade];

const palette = Object.fromEntries(HUES.map(hue => [
  hue,
  Object.fromEntries(SHADES.map(shade => [
    shade,
    MIRRORED.has(shade) ? token(`--pal-${hue}-${shade}`) : hex(hue, shade),
  ])),
]));

const paletteVars = plugin(({ addBase }) => {
  const dark: Record<string, string> = {};
  const light: Record<string, string> = {};
  for (const hue of HUES) {
    for (const shade of SHADES) {
      if (!MIRRORED.has(shade)) continue;
      dark[`--pal-${hue}-${shade}`] = hex(hue, shade);
      light[`--pal-${hue}-${shade}`] = hex(hue, lightShade(hue, shade));
    }
  }
  addBase({ ":root": dark, ':root[data-theme="light"]': light });
});

const TONES = ["tech", "vendor", "data", "dds", "gio", "neutral", "ok", "warn", "bad", "info"];

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        ...palette,
        bg: token("--bg"),
        surface: {
          DEFAULT: token("--surface"),
          1: token("--surface-1"),
          2: token("--surface-2"),
          3: token("--surface-3"),
          deep: token("--surface-deep"),
          sunken: token("--surface-sunken"),
        },
        ink: {
          1: token("--ink-1"),
          2: token("--ink-2"),
          3: token("--ink-3"),
          4: token("--ink-4"),
          muted: token("--ink-muted"),
          faint: token("--ink-faint"),
        },
        line: {
          DEFAULT: token("--border"),
          strong: token("--border-strong"),
          faint: token("--border-faint"),
        },
        accent: {
          DEFAULT: token("--accent"),
          hover: token("--accent-hover"),
          fg: token("--accent-fg"),
          soft: token("--accent-soft"),
          text: token("--accent-text"),
          text2: token("--accent-text-2"),
          border: token("--accent-border"),
        },
        link: {
          DEFAULT: token("--link"),
          hover: token("--link-hover"),
        },
        // `bg-tone-vendor-bg text-tone-vendor-fg border-tone-vendor-bd` — see Tag.tsx.
        tone: Object.fromEntries(TONES.map(t => [t, {
          fg: token(`--tone-${t}-fg`),
          bg: token(`--tone-${t}-bg`),
          bd: token(`--tone-${t}-bd`),
        }])),
      },
    },
  },
  plugins: [paletteVars],
};
export default config;
