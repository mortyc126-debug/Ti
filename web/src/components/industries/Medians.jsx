// Заглушка-плейсхолдер вкладки «Медианы». Полный порт страницы
// `page-industries` из old SPA — отдельной задачей; здесь — короткая
// заметка и таблица отраслей с количеством эмитентов в базе.

import { useMemo } from 'react';
import { Factory } from 'lucide-react';
import { INDUSTRIES, INDUSTRY_GROUPS } from '../../data/industries.js';
import { getAllIssuers } from '../../data/issuersMock.js';

export default function Medians(){
  const counts = useMemo(() => {
    const map = new Map();
    for(const iss of getAllIssuers()){
      map.set(iss.industry, (map.get(iss.industry) || 0) + 1);
    }
    return map;
  }, []);

  return (
    <div className="space-y-4">
      <div className="bg-s2/40 border border-border rounded-lg px-4 py-3 text-text2 text-sm">
        <Factory className="inline-block mr-2 text-acc" size={16} />
        Медианы p25/p50/p75 по отраслям через ГИР БО — портируется из old SPA.
        Пока — справочник отраслей со счётчиком эмитентов в базе мультипликаторов.
      </div>

      <div className="bg-bg2 border border-border rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-s2/60 text-text3 uppercase text-[10px]">
            <tr>
              <th className="text-left p-2 pl-4">Группа</th>
              <th className="text-left p-2">Отрасль</th>
              <th className="text-right p-2 pr-4">Эмитентов в базе</th>
            </tr>
          </thead>
          <tbody>
            {INDUSTRY_GROUPS.flatMap(g => g.items.map(it => (
              <tr key={it.id} className="border-t border-border/40">
                <td className="p-2 pl-4 text-text3 font-mono text-[11px]">{g.label}</td>
                <td className="p-2 font-mono text-text">{it.label}</td>
                <td className="p-2 pr-4 text-right font-mono">
                  <span className={counts.get(it.id) ? 'text-text' : 'text-text3'}>
                    {counts.get(it.id) || 0}
                  </span>
                </td>
              </tr>
            )))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
