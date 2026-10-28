import { expect, it } from "vitest";

function renderCard(user) {
  return `<div class="card"><h2>${user.name}</h2><p>${user.role}</p></div>`;
}

it("разметка карточки не меняется", () => {
  expect(renderCard({ name: "Мира", role: "admin" })).toMatchSnapshot();
});
