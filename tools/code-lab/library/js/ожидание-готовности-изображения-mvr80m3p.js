const фото = new Image();
фото.src = "/снимки/закат.jpg";
await фото.decode();
document.body.append(фото);