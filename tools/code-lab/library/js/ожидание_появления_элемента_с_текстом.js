import { render, screen } from "@testing-library/react";
import { Статус } from "./Статус.jsx";

test("после загрузки появляется «done»", async () => {
  render(<Статус />);
  const надпись = await screen.findByText("done");
  expect(надпись).toBeTruthy();
});
