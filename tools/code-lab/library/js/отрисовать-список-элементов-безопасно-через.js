function renderList(container, items, getLabel = item => String(item)) {
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = getLabel(item);
    fragment.append(li);
  }
  container.replaceChildren(fragment);
}
// renderList(document.querySelector('#results'), records, x => x.title);
