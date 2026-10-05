const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { ExecutorExclusao } = require('../dist/executores/exclusao');
const { ArmazenamentoMemoria } = require('./helpers/armazenamento-memoria');

test('cascata remove curriculo, candidatura, conversa e sessao', { skip: !process.env.PRDAL_TESTE_POSTGRES_URL }, async () => {
  const prisma = new PrismaClient({ datasourceUrl: process.env.PRDAL_TESTE_POSTGRES_URL });
  try {
    const usuario = await prisma.usuario.create({ data: {
      email: `exclusao-${randomUUID()}@teste.dev`, senhaHash: 'hash', exclusaoAgendadaPara: new Date(Date.now() - 60_000),
    } });
    const vaga = await prisma.vaga.create({ data: { usuarioId: usuario.id, titulo: 'Teste', empresa: 'Exemplo', descricao: 'Vaga de teste', keywords: [] } });
    const curriculo = await prisma.curriculo.create({ data: { vagaId: vaga.id, markdown: '# Teste' } });
    const candidatura = await prisma.candidatura.create({ data: { vagaId: vaga.id, curriculoId: curriculo.id } });
    const conversa = await prisma.copilotoConversa.create({ data: { usuarioId: usuario.id, modo: 'assistido' } });
    const sessao = await prisma.sessao.create({ data: { usuarioId: usuario.id, familia: randomUUID(), refreshHash: randomUUID(), expiraEm: new Date(Date.now() + 86_400_000) } });
    const executor = new ExecutorExclusao(prisma, new ArmazenamentoMemoria());
    assert.deepEqual(await executor.executar({ usuarioId: usuario.id }), { excluido: true });
    assert.equal(await prisma.usuario.findUnique({ where: { id: usuario.id } }), null);
    assert.equal(await prisma.curriculo.findUnique({ where: { id: curriculo.id } }), null);
    assert.equal(await prisma.candidatura.findUnique({ where: { id: candidatura.id } }), null);
    assert.equal(await prisma.copilotoConversa.findUnique({ where: { id: conversa.id } }), null);
    assert.equal(await prisma.sessao.findUnique({ where: { id: sessao.id } }), null);
  } finally {
    await prisma.$disconnect();
  }
});
