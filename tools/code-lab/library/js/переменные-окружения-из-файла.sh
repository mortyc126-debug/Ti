# в файле .env записано: НАЗВАНИЕ=Мира
# в app.js: console.log(process.env.НАЗВАНИЕ)
node --env-file=.env app.js
