function createContextLogger(correlationId, sink = console) {
  return {
    info(message, data = {}) { sink.info({ level: 'info', correlationId, message, ...data }); },
    warn(message, data = {}) { sink.warn({ level: 'warn', correlationId, message, ...data }); },
    error(message, data = {}) { sink.error({ level: 'error', correlationId, message, ...data }); }
  };
}
// const log = createContextLogger(requestId); log.info('parsed', { rows: 12 });
