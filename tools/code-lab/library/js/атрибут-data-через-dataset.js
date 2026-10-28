document.body.innerHTML = '<button id="buy" data-product-id="42" data-price="199">Купить</button>';
const buy = document.querySelector("#buy");

console.log(buy.dataset.productId, buy.dataset.price);

buy.dataset.inCart = "yes";
console.log(buy.getAttribute("data-in-cart"));
