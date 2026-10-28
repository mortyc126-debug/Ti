setTimeout(() => console.log("этот текст не появится"), 100);
console.log("до выхода");
process.exit(0);
console.log("после выхода");
