export type AppearancePreferences = {
  accent: string;
  selection: string;
  contrast: "standard" | "high";
};
export const appearanceKey = "codex-web.appearance.v1";
export const defaultAppearance: AppearancePreferences = {
  accent: "#2563eb", selection: "#2563eb", contrast: "high",
};
export function readAppearance(storage: Pick<Storage, "getItem">): AppearancePreferences {
  try {
    const value = JSON.parse(storage.getItem(appearanceKey) || "null");
    const color = (v: unknown, fallback: string) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
    return {
      accent: color(value?.accent, defaultAppearance.accent),
      selection: color(value?.selection, defaultAppearance.selection),
      contrast: value?.contrast === "standard" ? "standard" : "high",
    };
  } catch { return {...defaultAppearance}; }
}
/** Choose the higher WCAG contrast foreground for an opaque sRGB color. */
export function contrastText(color: string): string {
  const channels = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255)
    .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return luminance > 0.179 ? "#000000" : "#ffffff";
}
export function applyAppearance(root: HTMLElement, value: AppearancePreferences) {
  root.dataset.contrast = value.contrast;
  root.style.setProperty("--custom-accent", value.accent);
  root.style.setProperty("--custom-accent-text", contrastText(value.accent));
  root.style.setProperty("--selection-background", value.selection);
  root.style.setProperty("--selection-text", contrastText(value.selection));
}
