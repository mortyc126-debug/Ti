let isLocked = false;

function acquire() {
  isLocked = true;
  console.log("замок взят");
}

function release() {
  isLocked = false;
  console.log("замок отпущен");
}

function updateRecord() {
  acquire();
  try {
    throw new Error("Сбой при записи");
  } finally {
    release();
  }
}

try {
  updateRecord();
} catch (error) {
  console.log(`Ошибка: ${error.message}, isLocked = ${isLocked}`);
}
