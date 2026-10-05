import { AsyncLocalStorage } from 'node:async_hooks';

export const HEADER_REQUEST_ID = 'X-Request-Id';

const armazenamento = new AsyncLocalStorage<{ requestId: string }>();

export function requestIdAtual(): string | undefined {
  return armazenamento.getStore()?.requestId;
}

export function comRequestId<T>(requestId: string, executar: () => T): T {
  return armazenamento.run({ requestId }, executar);
}

export function cabecalhoRequestId(): Record<string, string> {
  const requestId = requestIdAtual();
  return requestId ? { [HEADER_REQUEST_ID]: requestId } : {};
}
