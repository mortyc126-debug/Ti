const решение = await Notification.requestPermission();

if (решение === "granted") {
  new Notification("Готово", { body: "Загрузка завершена" });
} else {
  console.log("Уведомления отключены:", решение);
}