import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Сообщение } from "./Сообщение.jsx";

test("сообщение становится видимым", async () => {
  render(<Сообщение />);
  await waitFor(() => expect(screen.getByText("Привет")).toBeVisible());
});