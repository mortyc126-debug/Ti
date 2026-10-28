const dirtyHtml = '<p>Привет</p><img src="x" onerror="alert(1)">';

const output = document.createElement("div");
output.innerHTML = DOMPurify.sanitize(dirtyHtml);
document.body.append(output);

console.log(output.innerHTML);
