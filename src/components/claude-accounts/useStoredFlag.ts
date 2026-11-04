import { useCallback, useState } from "react";

/**
 * A boolean the user's choice sticks to between visits (a card left open or
 * closed). Storage can be missing or throw (private windows, blocked site
 * data); then it is just state.
 */
export function useStoredFlag(key: string, initial: boolean) {
  const [value, setValue] = useState(() => {
    try {
      const stored = window.localStorage.getItem(key);
      if (stored === "1") return true;
      if (stored === "0") return false;
    } catch {
      // Not available: the default stands.
    }
    return initial;
  });
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next ? "1" : "0");
      } catch {
        // The choice lasts until the page is left.
      }
    },
    [key],
  );
  return [value, set] as const;
}
