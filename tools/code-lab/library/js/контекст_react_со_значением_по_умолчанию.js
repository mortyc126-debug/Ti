import { createContext, useContext } from "react";

const ТемаКонтекст = createContext("светлая");

function Кнопка() {
  const тема = useContext(ТемаКонтекст);
  return <button className={тема}>ОК</button>;
}

function Приложение() {
  return (
    <ТемаКонтекст.Provider value="тёмная">
      <Кнопка />
    </ТемаКонтекст.Provider>
  );
}
