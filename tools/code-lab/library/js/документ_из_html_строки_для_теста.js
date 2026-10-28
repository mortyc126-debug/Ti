import { JSDOM } from "jsdom";

const { document } = new JSDOM("<p id='приветствие'>Привет</p>").window;

console.log(document.querySelector("#приветствие").textContent);
