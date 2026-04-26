export default function Live(){
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-serif">Live-цены</h1>
      <p className="text-text2 text-sm">
        Real-time котировки через WebSocket — будет добавлено в следующем коммите.
        Архитектура: Cloudflare Durable Object держит polling MOEX каждые 5-10 секунд,
        подписанные клиенты получают изменения через Server-Sent Events.
      </p>
      <div className="bg-bg2 border border-border rounded-lg p-5 text-text3">
        Скоро.
      </div>
    </div>
  );
}
