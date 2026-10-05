import { PrismaClient } from '@prisma/client';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ArmazenamentoS3 } from './clientes';
import { configuracao } from './config';
import { montarExecutores } from './executores';
import { FilaSqs } from './fila';
import { RepositorioJobsPostgres } from './jobs';
import { Logger } from './logger';
import { EnviadorHttp, VarreduraLembretes } from './lembretes';
import { servidorSaude } from './saude';
import { Worker } from './worker';

async function iniciar() {
  const logger = new Logger('Main');
  const config = configuracao();
  const prisma = new PrismaClient();
  const fila = new FilaSqs();
  const jobs = new RepositorioJobsPostgres(prisma);
  const armazenamento = new ArmazenamentoS3();
  const worker = new Worker(fila, jobs, montarExecutores({ prisma, armazenamento }), {
    id: `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
    concorrencia: config.concorrencia,
    leaseS: config.leaseS,
    esperaS: config.esperaS,
    visibilidadeInicialS: config.visibilidadeInicialS,
    maxTentativas: config.maxTentativas,
    varreduraIntervaloMs: config.varreduraIntervaloMs,
    pendenteAntigoS: config.pendenteAntigoS,
    reenvioS: config.reenvioS,
    lembretes: process.env.AGENDADOR_MODO === 'eventbridge' ? undefined : new VarreduraLembretes(prisma, new EnviadorHttp()),
  });
  const servidor = servidorSaude(
    [
      { nome: 'postgres', verificar: () => jobs.verificar() },
      { nome: 'fila', verificar: () => fila.verificar() },
      { nome: 'armazenamento', verificar: () => armazenamento.verificar() },
    ],
    config.prontidaoMs,
    () => worker.parando,
  );
  servidor.listen(config.porta, '0.0.0.0');
  worker.iniciar();
  for (const sinal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sinal, () => {
      logger.log('sinal recebido', { sinal });
      void worker
        .parar(config.prazoDesligamentoMs)
        .catch((err) => logger.error('falha no desligamento', { erro: (err as Error).message }))
        .finally(async () => {
          servidor.close();
          await prisma.$disconnect().catch(() => undefined);
          process.exit(0);
        });
    });
  }
}

void iniciar();
