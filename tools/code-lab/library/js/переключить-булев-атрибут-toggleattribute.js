document.body.innerHTML = '<button id="send">Отправить</button>';
const sendButton = document.querySelector("#send");

function setLoading(isLoading) {
  sendButton.toggleAttribute("disabled", isLoading);
  console.log(`isLoading = ${isLoading}, disabled = ${sendButton.hasAttribute("disabled")}`);
}

setLoading(true);
setLoading(false);
