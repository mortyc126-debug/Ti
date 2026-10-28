const output = document.createElement("div");
document.body.append(output);

const dirtyHtml = '<p>Привет</p><img src="x" onerror="alert(1)">';

if ("setHTML" in output) {
  output.setHTML(dirtyHtml);
  console.log(output.innerHTML);
} else {
  console.log("setHTML не поддерживается в этом браузере");
}
