/**
 * Task 17 acceptance tests for the keyboard shortcut hook (spec 9.4):
 * bindings fire on keydown, letters match case-insensitively, and the
 * listener NEVER fires while the focus is inside an editable control
 * (input, textarea, select, contentEditable). Modifier chords are ignored,
 * the listener detaches on unmount, and matching keys prevent the default
 * browser behavior (e.g. Space scrolling).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { useKeyboardShortcuts } from "./keyboard";

function Harness(props: { bindings: { key: string; handler: () => void }[] }): React.JSX.Element {
  useKeyboardShortcuts(props.bindings);
  return (
    <div>
      <input aria-label="文本输入" />
      <textarea aria-label="多行输入" />
      <select aria-label="选择器">
        <option>1</option>
      </select>
      <div contentEditable aria-label="富文本" />
      <button type="button">普通按钮</button>
    </div>
  );
}

/** Renders the harness and returns the spy plus a focus helper. */
function setup(bindings: { key: string; handler: () => void }[]) {
  const renderResult = render(<Harness bindings={bindings} />);
  return renderResult;
}

/** Dispatches a cancelable keydown at the active element; returns whether the
 *  listener prevented the default browser behavior. */
function pressKey(key: string, init: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  const target = document.activeElement ?? document.body;
  return target.dispatchEvent(event) === false;
}

afterEach(() => {
  cleanup();
});

describe("keyboard shortcuts", () => {
  it("fires a bound handler on keydown", () => {
    const handler = vi.fn();
    setup([{ key: " ", handler }]);
    pressKey(" ");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("matches letters case-insensitively", () => {
    const handler = vi.fn();
    setup([{ key: "z", handler }]);
    pressKey("Z");
    expect(handler).toHaveBeenCalledTimes(1);
    pressKey("z");
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("does not fire while the focus is inside an editable control", () => {
    const space = vi.fn();
    const rate = vi.fn();
    const undo = vi.fn();
    const play = vi.fn();
    setup([
      { key: " ", handler: space },
      { key: "1", handler: rate },
      { key: "z", handler: undo },
      { key: "s", handler: play },
    ]);

    const editables = [
      screen.getByLabelText("文本输入"),
      screen.getByLabelText("多行输入"),
      screen.getByLabelText("选择器"),
      screen.getByLabelText("富文本"),
    ];
    for (const editable of editables) {
      editable.focus();
      pressKey(" ");
      pressKey("1");
      pressKey("z");
      pressKey("s");
    }
    expect(space).not.toHaveBeenCalled();
    expect(rate).not.toHaveBeenCalled();
    expect(undo).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();

    // A focused button (or the body) is NOT editable: shortcuts work.
    screen.getByRole("button", { name: "普通按钮" }).focus();
    pressKey(" ");
    expect(space).toHaveBeenCalledTimes(1);
  });

  it("ignores keydown with modifier chords", () => {
    const handler = vi.fn();
    setup([{ key: "s", handler }]);
    pressKey("s", { ctrlKey: true });
    pressKey("s", { metaKey: true });
    pressKey("s", { altKey: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it("prevents the default browser behavior for a matched key", () => {
    const handler = vi.fn();
    setup([{ key: " ", handler }]);
    // A canceled event means preventDefault was called by the listener.
    expect(pressKey(" ")).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("detaches the listener on unmount", () => {
    const handler = vi.fn();
    const { unmount } = setup([{ key: "s", handler }]);
    unmount();
    pressKey("s");
    expect(handler).not.toHaveBeenCalled();
  });

  it("survives a bindings array recreated on every render", () => {
    const handler = vi.fn();
    function NewArrayHarness(): React.JSX.Element {
      // A NEW array identity on every render must not break the listener.
      const [, setTick] = useState(0);
      useEffect(() => {
        setTick(1);
      }, []);
      useKeyboardShortcuts([{ key: "s", handler: () => handler() }]);
      return <p>ready</p>;
    }
    render(<NewArrayHarness />);
    pressKey("s");
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
