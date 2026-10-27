async function* сообщения() { yield "первое"; yield "второе"; }
for await (const текст of сообщения()) console.log(текст);