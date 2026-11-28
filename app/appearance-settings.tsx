"use client";

import { useState } from "react";
import { Check } from "lucide-react";

const themes = [
  { id: "dark", name: "Dark" },
  { id: "ocean", name: "Ocean" },
  { id: "dusk", name: "Dusk" },
  { id: "forest", name: "Forest" },
] as const;

type Theme = typeof themes[number]["id"];

export default function AppearanceSettings({ compact, onCompactChange }: {
  compact: boolean;
  onCompactChange: (compact: boolean) => void;
}) {
  const [theme, setTheme] = useState<Theme>(() => {
    const current = typeof document === "undefined" ? undefined : document.documentElement.dataset.theme;
    return themes.find(({ id }) => id === current)?.id ?? "dark";
  });

  function chooseTheme(theme: Theme) {
    document.documentElement.setAttribute("data-theme", theme);
    setTheme(theme);
    try {
      localStorage.setItem("rarrcord:theme", theme);
    } catch {
      // The selection still applies for this visit.
    }
  }

  return <>
    <fieldset className="theme-settings" aria-describedby="theme-help">
      <legend>Color theme</legend>
      <p id="theme-help">Themes apply immediately and are saved in this browser.</p>
      <div className="theme-grid">
        {themes.map(({ id, name }) => <label className="theme-option" key={id}>
          <input type="radio" name="appearance-theme" value={id} checked={theme === id} onChange={() => chooseTheme(id)} />
          <span className="theme-preview" data-theme={id} aria-hidden="true">
            <span className="theme-preview-rail" />
            <span className="theme-preview-sidebar" />
            <span className="theme-preview-chat" />
          </span>
          <span className="theme-name">{name}<Check size={15} className="theme-check" aria-hidden="true" /></span>
        </label>)}
      </div>
    </fieldset>
    <fieldset><legend>Message display</legend>
      <label className="inline"><input type="checkbox" checked={compact} onChange={e => onCompactChange(e.target.checked)} />Compact messages</label>
    </fieldset>
  </>;
}
