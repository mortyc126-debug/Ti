const docsButton = document.createElement("button");
docsButton.textContent = "Открыть документацию";
document.body.append(docsButton);

docsButton.addEventListener("click", () => {
  const opened = window.open(
    "https://developer.mozilla.org",
    "_blank",
    "noopener,noreferrer"
  );
  console.log(opened);
});
