// Общий кэш словаря на странице: один запрос вместо того, чтобы каждый модуль тянул весь /keyword-dict.json.
// codelabKwDict()        — весь словарь (для «весь словарь»/поиска по всем языкам), кэш на страницу.
// codelabKwDict('python') — только этот язык + база/синонимы/примеры (для подсветки/автодополнения — быстро и легко).
// codelabKwDictReset()   — сбросить кэш (после правок словаря).
(function(){
  var all = null, byLang = {};
  window.codelabKwDict = function(lang){
    if(lang){ var l = String(lang).toLowerCase();
      if(!byLang[l]) byLang[l] = fetch('/keyword-dict.json?lang=' + encodeURIComponent(l), { cache: 'no-store' }).then(function(r){ return r.json(); }).catch(function(){ return {}; });
      return byLang[l];
    }
    if(!all) all = fetch('/keyword-dict.json', { cache: 'no-store' }).then(function(r){ return r.json(); }).catch(function(){ return {}; });
    return all;
  };
  window.codelabKwDictReset = function(){ all = null; byLang = {}; };
})();
