const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { RepositorioJobsPostgres } = require('../dist/jobs');

const PG = process.env.PRDAL_TESTE_POSTGRES_URL;
const SEM_PG = !PG && 'defina PRDAL_TESTE_POSTGRES_URL com um banco descartavel ja migrado pela api';

function banco(t) {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({ datasourceUrl: PG });
  t.after(() => prisma.$disconnect());
  return prisma;
}

async function novoJob(prisma, dados = {}) {
  const usuario = await prisma.usuario.create({ data: { email: `worker-${randomUUID()}@exemplo.dev`, senhaHash: 'x' } });
  return prisma.job.create({ data: { tipo: 'gerar_curriculo', usuarioId: usuario.id, referenciaId: randomUUID(), requestId: 'req-1', ...dados } });
}

test('duas replicas pedem o lease do mesmo job ao mesmo tempo e so uma recebe', { skip: SEM_PG }, async (t) => {
  const prisma = banco(t);
  const repo = new RepositorioJobsPostgres(prisma);
  for (let rodada = 0; rodada < 10; rodada++) {
    const job = await novoJob(prisma);
    const [a, b] = await Promise.all([repo.obterLease(job.id, 'a', 60), repo.obterLease(job.id, 'b', 60)]);
    assert.equal([a, b].filter(Boolean).length, 1);
    const ganho = a ?? b;
    assert.equal(ganho.tentativas, 1);
    assert.equal(ganho.requestId, 'req-1');
    assert.equal(ganho.tipo, 'gerar_curriculo');
  }
});

test('lease vencido pode ser retomado; lease valido e job terminal nao', { skip: SEM_PG }, async (t) => {
  const prisma = banco(t);
  const repo = new RepositorioJobsPostgres(prisma);
  const job = await novoJob(prisma);
  assert.ok(await repo.obterLease(job.id, 'a', 60));
  assert.equal(await repo.obterLease(job.id, 'b', 60), null);
  await prisma.$executeRaw`UPDATE jobs SET locked_until = timezone('UTC', now()) - interval '1 second' WHERE id = ${job.id}`;
  const retomado = await repo.obterLease(job.id, 'b', 60);
  assert.equal(retomado.tentativas, 2);
  assert.equal(await repo.concluir(job.id, 'a', { x: 1 }), false);
  assert.equal(await repo.concluir(job.id, 'b', { x: 1 }), true);
  const final = await prisma.job.findUnique({ where: { id: job.id } });
  assert.equal(final.status, 'CONCLUIDO');
  assert.deepEqual(final.resultado, { x: 1 });
  assert.equal(final.lockedUntil, null);
  assert.equal(await repo.obterLease(job.id, 'c', 60), null);
});

test('falha libera para nova tentativa, falha definitiva encerra e devolucao nao gasta tentativa', { skip: SEM_PG }, async (t) => {
  const prisma = banco(t);
  const repo = new RepositorioJobsPostgres(prisma);
  const job = await novoJob(prisma);
  await repo.obterLease(job.id, 'a', 60);
  assert.equal(await repo.liberarComErro(job.id, 'a', 'falhou'), true);
  let atual = await prisma.job.findUnique({ where: { id: job.id } });
  assert.deepEqual([atual.status, atual.tentativas, atual.erro, atual.lockedBy], ['PENDENTE', 1, 'falhou', null]);
  await repo.obterLease(job.id, 'a', 60);
  assert.equal(await repo.devolver(job.id, 'a'), true);
  atual = await prisma.job.findUnique({ where: { id: job.id } });
  assert.deepEqual([atual.status, atual.tentativas], ['PENDENTE', 1]);
  await repo.obterLease(job.id, 'b', 60);
  assert.equal(await repo.falharDefinitivo(job.id, 'b', 'sem IA'), true);
  atual = await prisma.job.findUnique({ where: { id: job.id } });
  assert.deepEqual([atual.status, atual.erro], ['ERRO', 'sem IA']);
});

test('varredura pega pendentes antigos sem lease uma vez so, e nao pega o recem criado', { skip: SEM_PG }, async (t) => {
  const prisma = banco(t);
  const repo = new RepositorioJobsPostgres(prisma);
  const antigo = await novoJob(prisma, { criadoEm: new Date(Date.now() - 120_000) });
  const recente = await novoJob(prisma);
  const [x, y] = await Promise.all([repo.paraReenviar(30, 600, 1000), repo.paraReenviar(30, 600, 1000)]);
  const ids = [...x, ...y].map((j) => j.id);
  assert.equal(ids.filter((id) => id === antigo.id).length, 1);
  assert.ok(!ids.includes(recente.id));
  assert.deepEqual((await repo.paraReenviar(30, 600, 1000)).filter((j) => j.id === antigo.id), []);
});

test('orfao em processamento com tentativas esgotadas vira erro na varredura', { skip: SEM_PG }, async (t) => {
  const prisma = banco(t);
  const repo = new RepositorioJobsPostgres(prisma);
  const job = await novoJob(prisma);
  await prisma.$executeRaw`UPDATE jobs SET status = 'PROCESSANDO', tentativas = 3, locked_by = 'morto', locked_until = timezone('UTC', now()) - interval '1 hour' WHERE id = ${job.id}`;
  const encerrados = await repo.orfaosEsgotados(3, 600, 'parou de responder');
  assert.ok(encerrados.some((j) => j.id === job.id));
  const atual = await prisma.job.findUnique({ where: { id: job.id } });
  assert.deepEqual([atual.status, atual.erro], ['ERRO', 'parou de responder']);
});
