import { useEffect, useState } from "react";
import { appearanceKey, applyAppearance, defaultAppearance, readAppearance, type AppearancePreferences } from "./appearance";

export function useAppearance() {
  const [appearance, setAppearance] = useState<AppearancePreferences>(() => {
    try { return readAppearance(localStorage); } catch { return {...defaultAppearance}; }
  });
  useEffect(() => {
    applyAppearance(document.documentElement, appearance);
    try { localStorage.setItem(appearanceKey, JSON.stringify(appearance)); } catch { /* Optional device persistence. */ }
  }, [appearance]);
  return [appearance, setAppearance] as const;
}
export default function AppearanceSettings({ value, onChange, theme, onThemeChange }: {
  value: AppearancePreferences; onChange: (value: AppearancePreferences) => void;
  theme: "system" | "light" | "dark"; onThemeChange: (value: "system" | "light" | "dark") => void;
}) {
  return <div className="appearance-settings">
    <p className="settings-page-note">Changes apply immediately and are saved on this device.</p>
    <div className="settings-grid">
      <label><span>Theme</span><select aria-label="Theme" value={theme} onChange={e => onThemeChange(e.target.value as typeof theme)}>
        <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
      </select></label>
      <label><span>Contrast</span><select aria-label="Contrast" value={value.contrast} onChange={e => onChange({...value, contrast: e.target.value === "standard" ? "standard" : "high"})}>
        <option value="high">High contrast</option><option value="standard">Standard contrast</option>
      </select></label>
      <label><span>Accent color</span><input type="color" value={value.accent} onChange={e => onChange({...value, accent: e.target.value})} /></label>
      <label><span>Text selection color</span><input type="color" value={value.selection} onChange={e => onChange({...value, selection: e.target.value})} /></label>
    </div>
    <p className="settings-page-note">Selected text automatically uses a readable foreground color.</p>
    <div className="appearance-preview">
      <strong>Live preview</strong>
      <p><span className="selection-preview">Selected text</span></p>
      <p>Select this sentence to preview text highlighting.</p>
      <div className="appearance-preview-row"><span className="appearance-selected-preview">Selected item</span><button type="button" className="appearance-primary-preview">Accent color</button></div>
    </div>
    <button type="button" className="settings-toggle" onClick={() => { onChange({...defaultAppearance}); onThemeChange("system"); }}>Restore appearance defaults</button>
  </div>;
}
