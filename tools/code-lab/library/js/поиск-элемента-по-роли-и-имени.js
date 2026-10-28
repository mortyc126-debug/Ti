// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen } from "@testing-library/dom";

it("находит кнопку по роли и имени", () => {
  document.body.innerHTML = "<button>Cancel</button><button>Save</button>";

  const saveButton = screen.getByRole("button", { name: "Save" });

  expect(saveButton.textContent).toBe("Save");
});
