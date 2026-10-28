// 1) В проекте (есть package.json): сначала в терминале
//    npm install dayjs
//    затем в коде:
import dayjs from "dayjs";
console.log(dayjs().format("YYYY-MM-DD"));

// 2) В обычном HTML без сборки — через CDN:
// <script src="https://cdn.jsdelivr.net/npm/dayjs/dayjs.min.js"></script>