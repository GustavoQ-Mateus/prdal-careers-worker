const assert = require('node:assert/strict');
const test = require('node:test');
const { ExecutorExclusao } = require('../dist/executores/exclusao');
const { RepositorioJobsPostgres } = require('../dist/jobs');
const { ArmazenamentoMemoria } = require('./helpers/armazenamento-memoria');

test('varredura cria um job por usuario vencido em duas passagens', async () => {
  const jobs = [];
  const prisma = {
    usuario: { findMany: async () => [{ id: 'u1' }] },
    job: {
      findFirst: async () => jobs.find((job) => job.status === 'PENDENTE') ?? null,
      create: async ({ data }) => {
        const job = { id: `j${jobs.length + 1}`, status: 'PENDENTE', ...data };
        jobs.push(job);
        return job;
      },
    },
  };
  const repo = new RepositorioJobsPostgres(prisma);
  assert.deepEqual(await repo.criarExclusoesVencidas(50), [{ id: 'j1', tipo: 'excluir_conta' }]);
  assert.deepEqual(await repo.criarExclusoesVencidas(50), []);
  assert.equal(jobs.length, 1);
});

test('exclusao apaga S3 antes do banco e falha de S3 preserva conta', async () => {
  const ordem = [];
  let existe = true;
  const prisma = { usuario: {
    findFirst: async () => existe ? { id: 'u1' } : null,
    deleteMany: async () => { ordem.push('banco'); existe = false; return { count: 1 }; },
  } };
  const armazenamento = new ArmazenamentoMemoria();
  await armazenamento.gravar('usuarios/u1/curriculos/c1.pdf', Buffer.from('pdf'), 'application/pdf');
  await armazenamento.gravar('usuarios/u2/curriculos/c2.pdf', Buffer.from('outro'), 'application/pdf');
  const original = armazenamento.apagarPrefixo.bind(armazenamento);
  armazenamento.apagarPrefixo = async () => { ordem.push('s3'); throw new Error('S3 fora'); };
  const executor = new ExecutorExclusao(prisma, armazenamento);
  await assert.rejects(executor.executar({ usuarioId: 'u1' }), /S3 fora/);
  assert.equal(existe, true);
  assert.deepEqual(ordem, ['s3']);
  armazenamento.apagarPrefixo = async (prefixo) => { ordem.push('s3'); await original(prefixo); };
  assert.deepEqual(await executor.executar({ usuarioId: 'u1' }), { excluido: true });
  assert.deepEqual(ordem, ['s3', 's3', 'banco']);
  assert.equal(armazenamento.objetos.has('usuarios/u1/curriculos/c1.pdf'), false);
  assert.equal(armazenamento.objetos.has('usuarios/u2/curriculos/c2.pdf'), true);
});
