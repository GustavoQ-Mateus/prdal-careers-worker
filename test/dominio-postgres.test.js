const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { anexarConclusaoGeracao, aplicarNoPipeline, TransicaoIgnorada } = require('../dist/dominio');
const { ExecutorKeywords } = require('../dist/executores/keywords');

const PG = process.env.PRDAL_TESTE_POSTGRES_URL;
const SEM_PG = !PG && 'defina PRDAL_TESTE_POSTGRES_URL com um banco descartavel ja migrado pela api';

function banco(t) {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({ datasourceUrl: PG });
  t.after(() => prisma.$disconnect());
  return prisma;
}

async function cenario(prisma) {
  const usuario = await prisma.usuario.create({ data: { email: `dominio-${randomUUID()}@exemplo.dev`, senhaHash: 'x' } });
  const vaga = await prisma.vaga.create({ data: { usuarioId: usuario.id, titulo: 'Dev', empresa: 'Acme', descricao: 'Java', keywords: [] } });
  return { usuario, vaga };
}

test('conclusao da geracao entra uma vez so na conversa, mesmo com chamadas concorrentes', { skip: SEM_PG }, async (t) => {
  const prisma = banco(t);
  const { usuario } = await cenario(prisma);
  const conversa = await prisma.copilotoConversa.create({ data: { usuarioId: usuario.id, modo: 'assistido', totalMensagens: 1 } });
  await prisma.copilotoMensagem.create({ data: { conversaId: conversa.id, ordem: 0, papel: 'tool', tool: 'gerar_curriculo', conteudo: '{}', dados: { ok: true, resultado: { jobId: 'job-1' } } } });
  const narracao = { etapa1: 'Etapa 1', etapa3: 'Etapa 3' };
  assert.equal(await anexarConclusaoGeracao(prisma, usuario.id, 'job-x', { id: 'cv' }, narracao, {}), false);
  const vezes = await Promise.all(Array.from({ length: 4 }, () => anexarConclusaoGeracao(prisma, usuario.id, 'job-1', { id: 'cv' }, narracao, {})));
  assert.equal(vezes.filter(Boolean).length, 1);
  const mensagens = await prisma.copilotoMensagem.findMany({ where: { conversaId: conversa.id }, orderBy: { ordem: 'asc' } });
  assert.deepEqual(mensagens.map((m) => [m.ordem, m.papel, m.conteudo]).slice(2), [[2, 'assistant', 'Etapa 1'], [3, 'assistant', 'Etapa 3']]);
  assert.equal(mensagens[1].dados.origem, 'geracao_assincrona');
  assert.equal(await anexarConclusaoGeracao(prisma, randomUUID(), 'job-1', { id: 'cv' }, narracao, {}), false);
});

test('pipeline: so a geracao em andamento conclui, com evento estruturado e versao nova', { skip: SEM_PG }, async (t) => {
  const prisma = banco(t);
  const { usuario, vaga } = await cenario(prisma);
  await prisma.pipelineAts.create({ data: { vagaId: vaga.id, usuarioId: usuario.id, estado: 'GERANDO', jobId: 'g1', versao: 3 } });
  await assert.rejects(aplicarNoPipeline(prisma, usuario.id, vaga.id, { tipo: 'geracao_falhou', jobId: 'outra', erro: 'x' }), TransicaoIgnorada);
  const situacao = await aplicarNoPipeline(prisma, usuario.id, vaga.id, { tipo: 'geracao_concluida', jobId: 'g1', curriculoId: 'cv-1', narracao: null });
  assert.equal(situacao.estado, 'CONCLUIDA');
  const linha = await prisma.pipelineAts.findUnique({ where: { vagaId: vaga.id } });
  assert.deepEqual([linha.estado, linha.curriculoId, linha.versao], ['CONCLUIDA', 'cv-1', 4]);
  const eventos = await prisma.eventoPipelineAts.findMany({ where: { vagaId: vaga.id } });
  assert.deepEqual(eventos.map((e) => [e.tipo, e.de, e.para, e.jobId]), [['geracao_concluida', 'GERANDO', 'CONCLUIDA', 'g1']]);
});

test('extracao de keywords grava o estado na vaga do banco real e a reextracao que falha termina em erro', { skip: SEM_PG }, async (t) => {
  const prisma = banco(t);
  const { usuario, vaga } = await cenario(prisma);
  const ia = { keywords: async () => ({ keywords: [{ termo: 'Java', peso: 1 }], status: 'VALIDAS', degradacao: null }) };
  await new ExecutorKeywords(prisma, ia).executar({ id: 'j', tipo: 'extrair_keywords', tentativas: 1, usuarioId: usuario.id, referenciaId: vaga.id, requestId: null, entrada: null });
  const atual = await prisma.vaga.findUnique({ where: { id: vaga.id } });
  assert.deepEqual([atual.keywordsExtracao, atual.keywordsStatus, atual.keywords], ['PRONTAS', 'VALIDAS', [{ termo: 'Java', peso: 1 }]]);
  const falha = new ExecutorKeywords(prisma, { keywords: async () => { throw new Error('ai-service respondeu 503'); } });
  await assert.rejects(falha.executar({ id: 'j', tipo: 'extrair_keywords', tentativas: 1, usuarioId: usuario.id, referenciaId: vaga.id, requestId: null, entrada: null }));
  assert.equal((await prisma.vaga.findUnique({ where: { id: vaga.id } })).keywordsExtracao, 'PENDENTE');
  await falha.aoEsgotar({ referenciaId: vaga.id }, 'ai-service respondeu 503');
  const final = await prisma.vaga.findUnique({ where: { id: vaga.id } });
  assert.deepEqual([final.keywordsExtracao, final.keywordsErro], ['ERRO', 'ai-service respondeu 503']);
});
