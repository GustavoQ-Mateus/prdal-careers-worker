import http from 'node:http';

export interface Sonda {
  nome: string;
  verificar(): Promise<void>;
}

export interface Prontidao {
  servico: 'worker';
  status: 'pronto' | 'indisponivel';
  dependencias: { nome: string; obrigatoria: boolean; estado: 'ok' | 'indisponivel' }[];
}

function comPrazo<T>(promessa: Promise<T>, ms: number): Promise<T> {
  let relogio: NodeJS.Timeout | undefined;
  const limite = new Promise<never>((_, rejeitar) => {
    relogio = setTimeout(() => rejeitar(new Error(`sem resposta em ${ms} ms`)), ms);
  });
  return Promise.race([promessa, limite]).finally(() => clearTimeout(relogio));
}

export async function prontidao(sondas: Sonda[], prazoMs: number, desligando: boolean): Promise<Prontidao> {
  const dependencias = await Promise.all(
    sondas.map(async (sonda) => {
      try {
        await comPrazo(sonda.verificar(), prazoMs);
        return { nome: sonda.nome, obrigatoria: true, estado: 'ok' as const };
      } catch {
        return { nome: sonda.nome, obrigatoria: true, estado: 'indisponivel' as const };
      }
    }),
  );
  const pronto = !desligando && dependencias.every((d) => d.estado === 'ok');
  return { servico: 'worker', status: pronto ? 'pronto' : 'indisponivel', dependencias };
}

export function servidorSaude(sondas: Sonda[], prazoMs: number, desligando: () => boolean): http.Server {
  return http.createServer((req, res) => {
    const rota = (req.url ?? '').split('?')[0];
    const responder = (status: number, corpo: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(corpo));
    };
    if (req.method !== 'GET') return responder(405, { erro: 'metodo nao permitido' });
    if (rota === '/health') return responder(200, { service: 'worker', status: 'ok' });
    if (rota === '/ready') {
      void prontidao(sondas, prazoMs, desligando()).then((corpo) => responder(corpo.status === 'pronto' ? 200 : 503, corpo));
      return;
    }
    responder(404, { erro: 'nao encontrado' });
  });
}
