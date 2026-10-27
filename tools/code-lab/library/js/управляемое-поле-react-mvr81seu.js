function Поле() {
  const [имя, setИмя] = React.useState("");
  return <input value={имя} onChange={событие => setИмя(событие.target.value)} />;
}