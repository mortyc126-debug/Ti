const card = document.createElement("div");
console.log(card.isConnected);

document.body.append(card);
console.log(card.isConnected);

card.remove();
console.log(card.isConnected);
