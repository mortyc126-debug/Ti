if ("EyeDropper" in window) {
  document.querySelector("#пипетка").addEventListener("click", async () => {
    try {
      const результат = await new EyeDropper().open();
      document.body.style.background = результат.sRGBHex;
    } catch {
      console.log("Выбор отменён");
    }
  });
}
