function normalizeApiError(error) {
  return {
    name: error?.name ?? 'Error',
    message: typeof error?.message === 'string' ? error.message : String(error),
    kind: error?.kind ?? (error?.status ? 'http' : 'unknown'),
    status: Number.isInteger(error?.status) ? error.status : null,
    retryable: error?.kind === 'network' || (error?.status >= 500 && error?.status <= 599),
    cause: error?.cause
  };
}
// const safeError = normalizeApiError(error);
