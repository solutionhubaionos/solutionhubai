import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProgressiveList } from "./ProgressiveList";

describe("progressive content", () => {
  it("reveals additional results in batches without omitting or duplicating items", () => {
    const items = Array.from({ length: 29 }, (_, i) => i);
    const view = render(
      <ProgressiveList
        items={items}
        renderItem={(i) => (
          <span key={i} data-testid="result">
            {i}
          </span>
        )}
      />,
    );
    expect(screen.getAllByTestId("result")).toHaveLength(12);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getAllByTestId("result")).toHaveLength(24);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getAllByTestId("result").map((el) => Number(el.textContent))).toEqual(items);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    view.unmount();
  });
});
