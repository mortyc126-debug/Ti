const keys = {};

addEventListener('keydown', e => { keys[e.key] = true; });
addEventListener('keyup', e => { keys[e.key] = false; });

if (keys['ArrowLeft']) player.x -= 3;
if (keys['ArrowRight']) player.x += 3;