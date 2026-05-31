// Панель управления Telegram-алертами.
// Пользователь вводит chat_id (получает от бота командой /start),
// видит список алертов и может добавлять / удалять их.
// Все данные хранятся в Cloudflare D1 через Worker.

import { useEffect, useState } from 'react';
import { Bell, Trash2, Plus, RefreshCw, AlertCircle, CheckCircle } from 'lucide-react';
import { api } from '../api.js';
import Card from './ui/Card.jsx';
import Button from './ui/Button.jsx';
import Badge from './ui/Badge.jsx';

const KIND_OPTIONS = [
  { value: 'price_above',  label: '↑ Цена выше',        hint: 'акция или фьючерс' },
  { value: 'price_below',  label: '↓ Цена ниже',        hint: 'акция или фьючерс' },
  { value: 'yield_above',  label: '↑ Доходность выше',  hint: '% YTM, облигация' },
  { value: 'yield_below',  label: '↓ Доходность ниже',  hint: '% YTM, облигация' },
  { value: 'basis_above',  label: '↑ Базис выше',       hint: '% ann., фьючерс' },
  { value: 'basis_below',  label: '↓ Базис ниже',       hint: '% ann., фьючерс' },
];

const KIND_TONE = {
  price_above: 'green', price_below: 'danger',
  yield_above: 'warn',  yield_below: 'green',
  basis_above: 'warn',  basis_below: 'neutral',
};

const UNIT = {
  price_above: '₽', price_below: '₽',
  yield_above: '%',  yield_below: '%',
  basis_above: '%',  basis_below: '%',
};

const CHAT_ID_KEY = 'tg_chat_id';

export default function TelegramAlerts(){
  const [chatId, setChatId]   = useState(() => localStorage.getItem(CHAT_ID_KEY) || '');
  const [input, setInput]     = useState(chatId);
  const [alerts, setAlerts]   = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const [form, setForm]       = useState({ secid: '', kind: 'price_below', threshold: '' });
  const [adding, setAdding]   = useState(false);
  const [addErr, setAddErr]   = useState(null);

  const loadAlerts = async (id) => {
    if(!id) return;
    setLoading(true); setError(null);
    try {
      const res = await api.tgAlerts(id);
      setAlerts(res.alerts || []);
    } catch(e){
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const applyChatId = () => {
    const id = input.trim();
    if(!id) return;
    setChatId(id);
    localStorage.setItem(CHAT_ID_KEY, id);
    loadAlerts(id);
  };

  useEffect(() => { if(chatId) loadAlerts(chatId); }, []); // eslint-disable-line

  const deleteAlert = async (id) => {
    try {
      await api.tgAlertDelete(id, chatId);
      setAlerts(a => a.filter(x => x.id !== id));
    } catch(e){
      setError(e.message);
    }
  };

  const addAlert = async () => {
    setAddErr(null);
    const { secid, kind, threshold } = form;
    if(!secid.trim()) { setAddErr('Укажите тикер'); return; }
    const val = parseFloat(threshold);
    if(isNaN(val)) { setAddErr('Укажите числовое значение'); return; }
    setAdding(true);
    try {
      await api.tgAlertCreate({ chat_id: chatId, secid: secid.trim().toUpperCase(), kind, threshold: val });
      setForm(f => ({ ...f, secid: '', threshold: '' }));
      await loadAlerts(chatId);
    } catch(e){
      setAddErr(e.message);
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Шаг 1 — ввод chat_id */}
      <Card>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Bell size={16} className="text-acc" />
            <span className="font-semibold text-sm">Telegram-алерты</span>
            {chatId && (
              <Badge tone="green" className="ml-auto">chat_id: {chatId}</Badge>
            )}
          </div>
          <p className="text-text2 text-xs">
            Откройте бота <b>@bondan_alerts_bot</b>, отправьте <code>/start</code> —
            бот покажет ваш chat_id. Вставьте его ниже.
          </p>
          <div className="flex gap-2">
            <input
              className="flex-1 bg-s2 border border-border rounded px-3 py-1.5 text-sm font-mono"
              placeholder="Ваш Telegram chat_id…"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && applyChatId()}
            />
            <Button size="sm" onClick={applyChatId}>Сохранить</Button>
          </div>
        </div>
      </Card>

      {chatId && (
        <>
          {/* Форма добавления алерта */}
          <Card>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-sm">Добавить алерт</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-text3 text-xs mb-1 block">Тикер</label>
                  <input
                    className="w-full bg-s2 border border-border rounded px-2 py-1.5 text-sm font-mono uppercase"
                    placeholder="SBER, SU26243RMFS7…"
                    value={form.secid}
                    onChange={e => setForm(f => ({ ...f, secid: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="text-text3 text-xs mb-1 block">Условие</label>
                  <select
                    className="w-full bg-s2 border border-border rounded px-2 py-1.5 text-sm"
                    value={form.kind}
                    onChange={e => setForm(f => ({ ...f, kind: e.target.value }))}
                  >
                    {KIND_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-text3 text-xs mb-1 block">
                    Значение ({UNIT[form.kind]})
                  </label>
                  <input
                    className="w-full bg-s2 border border-border rounded px-2 py-1.5 text-sm font-mono"
                    placeholder="150"
                    type="number"
                    value={form.threshold}
                    onChange={e => setForm(f => ({ ...f, threshold: e.target.value }))}
                    onKeyDown={e => e.key === 'Enter' && addAlert()}
                  />
                </div>
              </div>
              {addErr && (
                <div className="flex items-center gap-1.5 text-danger text-xs">
                  <AlertCircle size={12} /> {addErr}
                </div>
              )}
              <div className="flex justify-end">
                <Button size="sm" onClick={addAlert} disabled={adding}>
                  <Plus size={13} className="mr-1" />
                  {adding ? 'Добавление…' : 'Добавить'}
                </Button>
              </div>
            </div>
          </Card>

          {/* Список алертов */}
          <Card>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-sm">
                  Активные алерты
                  {alerts.length > 0 && (
                    <span className="text-text3 font-normal ml-1">({alerts.length})</span>
                  )}
                </span>
                <button
                  className="text-text3 hover:text-text"
                  onClick={() => loadAlerts(chatId)}
                  title="Обновить"
                >
                  <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
                </button>
              </div>

              {error && (
                <div className="flex items-center gap-1.5 text-danger text-xs bg-danger/10 rounded px-3 py-2">
                  <AlertCircle size={12} /> {error}
                </div>
              )}

              {!loading && !error && alerts.length === 0 && (
                <p className="text-text3 text-sm py-2">
                  Нет алертов. Добавьте выше или командой{' '}
                  <code className="bg-s2 px-1 rounded">/add SBER price_below 150</code> в боте.
                </p>
              )}

              {alerts.map(a => (
                <AlertRow key={a.id} alert={a} onDelete={deleteAlert} />
              ))}
            </div>
          </Card>

          {/* Подсказка */}
          <Card className="bg-s2/50">
            <p className="text-text3 text-xs space-y-1">
              <span className="block">⏰ Проверка алертов — ежедневно в <b>10:30 МСК</b> (cron).</span>
              <span className="block">🔕 Повторное уведомление не чаще чем раз в 24ч по каждому алерту.</span>
              <span className="block">📊 Данные: акции и фьючерсы — MOEX TQBR/FORTS; облигации — MOEX TQCB/TQOB.</span>
            </p>
          </Card>
        </>
      )}
    </div>
  );
}

function AlertRow({ alert, onDelete }){
  const [deleting, setDeleting] = useState(false);
  const kind  = KIND_OPTIONS.find(o => o.value === alert.kind);
  const unit  = UNIT[alert.kind] || '';
  const tone  = KIND_TONE[alert.kind] || 'neutral';

  const del = async () => {
    setDeleting(true);
    await onDelete(alert.id);
  };

  return (
    <div className="flex items-center gap-3 py-2 border-t border-border first:border-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono font-semibold text-sm">{alert.secid}</span>
          <Badge tone={tone} className="text-xs">{kind?.label}</Badge>
          <span className="font-mono text-sm font-semibold">
            {alert.threshold}{unit}
          </span>
        </div>
        <div className="text-text3 text-xs mt-0.5">
          {alert.last_sent
            ? `Последнее срабатывание: ${alert.last_sent.slice(0, 16).replace('T', ' ')}`
            : 'Ещё не срабатывал'}
          {' · '}добавлен {alert.created_at?.slice(0, 10)}
        </div>
      </div>
      <button
        className="text-text3 hover:text-danger shrink-0"
        onClick={del}
        disabled={deleting}
        title="Удалить алерт"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}
