const assert = require('node:assert/strict');
const test = require('node:test');
const { Rag, DEGRADACAO_FILTRO, DEGRADACAO_REINDEXACAO } = require('../dist/rag');
const { Logger } = require('../dist/logger');

const MODELO = 'intfloat/multilingual-e5-small';

function encontrado(consulta, fonteId, similaridade, texto, extra = {}) {
  return { consulta: BigInt(consulta), fonteId, texto, tipo: 'nota', factual: false, titulo: fonteId, origem: 'nota', similaridade, ...extra };
}

function prismaFalso(encontrados, deOutroModelo = 0) {
  return {
    $queryRaw: async (partes) => (partes.join('').includes('pg_attribute') ? [{ dimensao: 384 }] : encontrados),
    chunkRag: { count: async () => deOutroModelo },
  };
}

function iaFalsa(filtro) {
  const filtros = [];
  return {
    filtros,
    embeddingConsultas: async (consultas) => ({ modelo: MODELO, dimensao: 384, vetores: consultas.map(() => [1]) }),
    filtrarTrechos: async (consultas) => {
      filtros.push(consultas);
      return filtro(consultas);
    },
  };
}

function porTexto(consultas) {
  return { consultas: consultas.map((c) => ({ consulta: c.consulta, aceitos: c.trechos.filter((t) => t.texto.includes(c.consulta)).map((t) => t.id) })) };
}

test('so entra o trecho que o filtro aceita para a propria consulta e a melhor nota por fonte vale', async () => {
  const ia = iaFalsa(porTexto);
  const rag = new Rag(prismaFalso([
    encontrado(1, 'exp-a', 0.87, 'SQL e Power BI', { tipo: 'experiencia', factual: true, origem: 'perfil' }),
    encontrado(1, 'n-hist', 0.95, 'Power BI'),
    encontrado(1, 'n-parecido', 0.93, 'consultas no banco relacional'),
    encontrado(2, 'exp-a', 0.9, 'SQL e Power BI', { tipo: 'experiencia', factual: true, origem: 'perfil' }),
    encontrado(2, 'n1#2', 0.7, 'painel em Power BI'),
  ], 1), ia);
  const { chunks, degradacao } = await rag.recuperar('u1', ['SQL', 'Power BI']);
  assert.deepEqual(chunks.map((c) => [c.id, c.similaridade, c.factual]), [['exp-a', 0.9, true], ['n1#2', 0.7, false]]);
  assert.equal(degradacao, DEGRADACAO_REINDEXACAO);
  assert.deepEqual(ia.filtros[0].map((c) => [c.consulta, c.trechos.map((t) => t.id)]), [
    ['SQL', ['exp-a', 'n-hist', 'n-parecido']],
    ['Power BI', ['exp-a', 'n1#2']],
  ]);
  assert.deepEqual(ia.filtros[0][1].trechos[1], { id: 'n1#2', texto: 'painel em Power BI' });
});

test('sem candidato o filtro nem e chamado', async () => {
  const ia = iaFalsa(porTexto);
  const rag = new Rag(prismaFalso([]), ia);
  assert.deepEqual(await rag.recuperar('u1', ['SQL']), { chunks: [], degradacao: null });
  assert.deepEqual(ia.filtros, []);
});

test('filtro fora devolve contexto vazio, registra o motivo e nunca devolve trecho sem filtro', async () => {
  const linhas = [];
  const ia = iaFalsa(() => { throw new Error('connect ECONNREFUSED ai-service:8000'); });
  const rag = new Rag(prismaFalso([encontrado(1, 'n1', 0.99, 'SQL')]), ia, new Logger('Rag', (linha) => linhas.push(JSON.parse(linha))));
  assert.deepEqual(await rag.recuperar('u1', ['SQL']), { chunks: [], degradacao: DEGRADACAO_FILTRO });
  assert.equal(linhas[0].codigo, 'filtro_rag_indisponivel');
  assert.match(linhas[0].erro, /ECONNREFUSED/);
  const incompleto = new Rag(prismaFalso([encontrado(1, 'n1', 0.99, 'SQL')]), iaFalsa(() => ({ consultas: [] })));
  assert.deepEqual((await incompleto.recuperar('u1', ['SQL'])).chunks, []);
});

test('o cliente da ia manda a consulta e os candidatos ao filtro do ai-service com o token de servico', async (t) => {
  const http = require('node:http');
  const { IaHttp } = require('../dist/clientes');
  const recebidas = [];
  const servidor = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (parte) => { corpo += parte; });
    req.on('end', () => {
      recebidas.push({ url: req.url, servico: req.headers['x-prdal-servico'], corpo: JSON.parse(corpo) });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ consultas: [{ consulta: 'SQL', aceitos: ['n1'] }] }));
    });
  });
  await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  t.after(() => servidor.close());
  const token = 'token-de-servico-de-teste-com-mais-de-32-bytes';
  const ia = new IaHttp({}, { AI_SERVICE_URL: `http://127.0.0.1:${servidor.address().port}`, SERVICE_TOKEN: token });
  const consultas = [{ consulta: 'SQL', trechos: [{ id: 'n1', texto: 'SQL' }, { id: 'n2', texto: 'outra coisa' }] }];
  assert.deepEqual(await ia.filtrarTrechos(consultas), { consultas: [{ consulta: 'SQL', aceitos: ['n1'] }] });
  assert.deepEqual(recebidas, [{ url: '/rag/filtrar', servico: token, corpo: { consultas } }]);
});

const PG = process.env.PRDAL_TESTE_POSTGRES_URL;
const SEM_PG = !PG && 'defina PRDAL_TESTE_POSTGRES_URL com um banco descartavel ja migrado pela api';

function vetor(...posicoes) {
  const v = new Array(384).fill(0);
  for (const [i, valor] of posicoes) v[i] = valor;
  const norma = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norma);
}

test('pgvector: candidatos de cada consulta vao ao filtro com o proprio termo', { skip: SEM_PG }, async (t) => {
  const { randomUUID } = require('node:crypto');
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({ datasourceUrl: PG });
  t.after(() => prisma.$disconnect());
  const usuario = await prisma.usuario.create({ data: { email: `rag-${randomUUID()}@exemplo.dev`, senhaHash: 'x' } });
  const vetores = { 'Usei SQL no relatorio.': vetor([0, 1]), 'Painel em Power BI.': vetor([1, 1]), 'Receita de bolo.': vetor([0, 1], [1, 1]) };
  const ia = {
    ...iaFalsa(porTexto),
    embeddingDocumentos: async (documentos) => ({
      modelo: MODELO,
      dimensao: 384,
      chunks: documentos.map((d) => ({ documentoId: d.id, indice: 0, fonteId: d.origemId, texto: d.texto, vetor: vetores[d.texto] })),
    }),
    embeddingConsultas: async (consultas) => ({ modelo: MODELO, dimensao: 384, vetores: consultas.map((c) => (c === 'SQL' ? vetor([0, 1]) : vetor([1, 1]))) }),
  };
  const rag = new Rag(prisma, ia);
  for (const texto of Object.keys(vetores)) {
    const documento = await prisma.documentoRag.create({ data: { id: randomUUID(), usuarioId: usuario.id, origem: 'nota', origemId: `n-${texto.length}`, tipo: 'nota', factual: false, titulo: 'nota', texto } });
    await rag.indexar({ id: documento.id, usuarioId: usuario.id, origemId: documento.origemId, tipo: 'nota', texto });
  }
  const { chunks } = await rag.recuperar(usuario.id, ['SQL', 'Power BI']);
  assert.deepEqual(chunks.map((c) => c.texto).sort(), ['Painel em Power BI.', 'Usei SQL no relatorio.']);
  assert.deepEqual(ia.filtros[0].map((c) => [c.consulta, c.trechos.length]), [['SQL', 3], ['Power BI', 3]]);
});
