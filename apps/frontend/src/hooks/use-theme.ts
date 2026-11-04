import { useEffect, useState } from "react";

const STORAGE_KEY = "theme";

type Preference = "dark" | "light" | null;

function storedPreference(): Preference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "dark" || value === "light") return value;
  } catch {
    // Storage can be blocked. Fall through to the system preference.
  }
  return null;
}

function systemDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolveDark(preference: Preference): boolean {
  if (preference === "dark") return true;
  if (preference === "light") return false;
  return systemDark();
}

export function useTheme() {
  const [preference, setPreference] = useState<Preference>(() => storedPreference());
  const [dark, setDark] = useState(() => resolveDark(storedPreference()));

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  useEffect(() => {
    if (preference !== null) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setDark(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [preference]);

  function toggle() {
    const next = !dark;
    const stored: Preference = next ? "dark" : "light";
    setDark(next);
    setPreference(stored);
    try {
      localStorage.setItem(STORAGE_KEY, stored);
    } catch {
      // Ignore storage failures. The class still updates for this view.
    }
  }

  return {
    dark,
    toggle,
    label: dark ? "Switch to light theme" : "Switch to dark theme",
  };
}
