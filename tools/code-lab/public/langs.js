// Единый список языков для всего приложения: песочница, форма куска, словарь и др.
// front:true — язык «переднего края» (HTML/CSS/JS/SVG), который собирается в живой предпросмотр.
// Подключать ПЕРЕД скриптами, которые его используют (sandbox.js, app.js, inventory.js).
(function(){
  window.CODELAB_LANGS = [
    { v:'html', t:'HTML', front:true },
    { v:'css',  t:'CSS',  front:true },
    { v:'js',   t:'JavaScript', front:true },
    { v:'ts',   t:'TypeScript' },
    { v:'python', t:'Python' },
    { v:'sql',  t:'SQL' },
    { v:'json', t:'JSON' },
    { v:'svg',  t:'SVG', front:true },
    { v:'bash', t:'Bash' },
    { v:'powershell', t:'PowerShell' },
    { v:'go',   t:'Go' },
    { v:'ruby', t:'Ruby' },
    { v:'php',  t:'PHP' },
    { v:'lua',  t:'Lua' },
    { v:'r',    t:'R' },
    { v:'perl', t:'Perl' },
    { v:'c',    t:'C' },
    { v:'cpp',  t:'C++' },
    { v:'java', t:'Java' },
    { v:'rust', t:'Rust' },
    { v:'kotlin', t:'Kotlin' },
    { v:'csharp', t:'C#' },
    { v:'swift', t:'Swift' },
    { v:'txt',  t:'текст' }
  ];
  const byV = {}; window.CODELAB_LANGS.forEach(l => byV[l.v] = l);
  window.langLabel = v => (byV[v] && byV[v].t) || v;
  // расширение файла → язык (для открытия файлов и распознавания)
  const EXT = { html:'html', htm:'html', css:'css', scss:'css', js:'js', mjs:'js', cjs:'js', jsx:'js', ts:'ts', tsx:'ts',
    py:'python', sql:'sql', json:'json', svg:'svg', sh:'bash', bash:'bash', ps1:'powershell', go:'go', rb:'ruby', php:'php',
    lua:'lua', r:'r', pl:'perl', c:'c', h:'c', cpp:'cpp', cc:'cpp', cxx:'cpp', hpp:'cpp', java:'java', rs:'rust',
    kt:'kotlin', cs:'csharp', swift:'swift', md:'txt', txt:'txt', xml:'txt', yml:'txt', yaml:'txt', csv:'txt' };
  window.langByExt = ext => EXT[String(ext || '').toLowerCase()] || 'txt';
})();
