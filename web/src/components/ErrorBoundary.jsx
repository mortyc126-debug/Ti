// ErrorBoundary вокруг приложения. Если внутри что-то упало — вместо
// «тёмного экрана» (CSS подгрузился, React не отрендерил) показываем
// видимое сообщение и stack. Полезно при деплое на CF Pages, где
// нет dev-tools и непонятно, в чём дело.

import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props){
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error){
    return { error };
  }
  componentDidCatch(error, info){
    console.error('AppError:', error, info);
  }
  render(){
    const { error } = this.state;
    if(!error) return this.props.children;
    return (
      <div style={{
        minHeight: '100vh', padding: 24, color: '#e6edf3',
        background: '#0a0e14', fontFamily: 'ui-monospace, monospace',
      }}>
        <div style={{ maxWidth: 800, margin: '40px auto' }}>
          <div style={{ color: '#ff4d6d', fontSize: 14, marginBottom: 8 }}>
            ❌ Ошибка инициализации
          </div>
          <div style={{ fontSize: 18, marginBottom: 16 }}>
            {String(error?.message || error)}
          </div>
          <pre style={{
            background: '#11161e', border: '1px solid #222a37',
            padding: 16, borderRadius: 8, fontSize: 12,
            color: '#9ba3b1', overflow: 'auto', maxHeight: '50vh',
            whiteSpace: 'pre-wrap',
          }}>
            {error?.stack || ''}
          </pre>
          <div style={{ color: '#5e6573', fontSize: 12, marginTop: 16 }}>
            Снимок этой ошибки → пришли её, починю быстрее.
          </div>
        </div>
      </div>
    );
  }
}
