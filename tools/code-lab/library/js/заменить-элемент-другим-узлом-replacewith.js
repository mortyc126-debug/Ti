document.body.innerHTML = '<p>Загрузка <span id="spinner">…</span></p>';
const spinner = document.querySelector("#spinner");

const done = document.createElement("b");
done.textContent = "готово";
spinner.replaceWith(done);
console.log(document.body.innerHTML);

done.replaceWith("завершено");
console.log(document.body.innerHTML);
