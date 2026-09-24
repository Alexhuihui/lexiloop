/**
 * Desktop keyboard shortcuts (spec 9.4): Space reveals, 1-4 rate, Z undoes,
 * S plays audio. The listener is registered on window and ONLY fires when
 * the focus is NOT inside an editable control — typing in an input, a
 * textarea, a select, or a contentEditable region must never trigger a
 * shortcut. Modifier chords (Ctrl/Cmd/Alt) are ignored so browser shortcuts
 * keep working, and a matched key prevents the default browser behavior
 * (e.g. Space scrolling the page).
 */

import { useEffect, useRef } from "react";

export interface KeyboardBinding {
  /** `event.key` to match (letters match case-insensitively). */
  key: string;
  handler: () => void;
}

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** True when the event target is an editable control that must own its keys. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return EDITABLE_TAGS.has(target.tagName) || target.isContentEditable;
}

/**
 * Registers global keydown bindings for the mounted lifetime. The binding
 * list is read through a ref so callers can pass a fresh array on every
 * render without re-attaching the listener.
 */
export function useKeyboardShortcuts(bindings: readonly KeyboardBinding[]): void {
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      if (isEditableTarget(event.target)) {
        return;
      }
      // Legacy browsers report Space as "Spacebar".
      const key = event.key === "Spacebar" ? " " : event.key;
      const binding = bindingsRef.current.find(
        (candidate) => candidate.key.toLowerCase() === key.toLowerCase(),
      );
      if (binding) {
        event.preventDefault();
        binding.handler();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
}
