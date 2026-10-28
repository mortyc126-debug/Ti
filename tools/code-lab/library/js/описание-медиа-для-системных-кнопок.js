const title = "Колыбельная";
const artist = "Неизвестный автор";
navigator.mediaSession.metadata = new MediaMetadata({ title, artist });
console.log(navigator.mediaSession.metadata.title);
console.log(navigator.mediaSession.metadata.artist);
