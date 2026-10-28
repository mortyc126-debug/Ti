function showOrientation() {
  console.log(`Ориентация: ${screen.orientation.type}`);
}

showOrientation();
screen.orientation.addEventListener("change", showOrientation);
