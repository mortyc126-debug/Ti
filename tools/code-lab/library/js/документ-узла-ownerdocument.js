const frame = document.createElement("iframe");
document.body.append(frame);

const frameDocument = frame.contentDocument;
const heading = frameDocument.createElement("h1");

console.log(heading.ownerDocument === frameDocument);
console.log(heading.ownerDocument === document);
console.log(document.body.ownerDocument === document);
