type Env = Record<string, string | undefined>;

function inteiro(env: Env, nome: string, padrao: number, minimo = 1): number {
  const valor = Number(env[nome]);
  return Number.isInteger(valor) && valor >= minimo ? valor : padrao;
}

export interface ConfiguracaoWorker {
  porta: number;
  concorrencia: number;
  leaseS: number;
  esperaS: number;
  maxTentativas: number;
  prazoDesligamentoMs: number;
  varreduraIntervaloMs: number;
  pendenteAntigoS: number;
  reenvioS: number;
  prontidaoMs: number;
}

export function configuracao(env: Env = process.env): ConfiguracaoWorker {
  return {
    porta: inteiro(env, 'WORKER_PORTA', 3001),
    concorrencia: inteiro(env, 'WORKER_CONCORRENCIA', 2),
    leaseS: inteiro(env, 'WORKER_LEASE_S', 60, 5),
    esperaS: Math.min(inteiro(env, 'WORKER_ESPERA_S', 20, 0), 20),
    maxTentativas: inteiro(env, 'WORKER_MAX_TENTATIVAS', 3),
    prazoDesligamentoMs: inteiro(env, 'DESLIGAMENTO_PRAZO_MS', 25_000),
    varreduraIntervaloMs: inteiro(env, 'VARREDURA_INTERVALO_MS', 30_000),
    pendenteAntigoS: inteiro(env, 'VARREDURA_PENDENTE_S', 30),
    reenvioS: inteiro(env, 'VARREDURA_REENVIO_S', 600),
    prontidaoMs: inteiro(env, 'PRONTIDAO_TIMEOUT_MS', 2000),
  };
}
