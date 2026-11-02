import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

function setup(value = "What is Smart Verify?") {
  const onSend = vi.fn();
  const onChange = vi.fn();
  render(
    <Composer
      value={value}
      onChange={onChange}
      onSend={onSend}
      isTyping={false}
      focusSignal={0}
      contextBar={<div data-testid="context-row" />}
      onCreateTool={vi.fn()}
    />,
  );
  return {
    onSend,
    onChange,
    area: screen.getByRole("textbox", { name: "Ask the library a question" }),
  };
}

describe("Composer", () => {
  it("sends on Enter", () => {
    const { onSend, area } = setup();
    fireEvent.keyDown(area, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("keeps Shift+Enter for a new line", () => {
    const { onSend, area } = setup();
    fireEvent.keyDown(area, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("renders the context row inside the card and disables send while empty", () => {
    setup("");
    expect(screen.getByTestId("context-row")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send question" })).toBeDisabled();
  });
});
