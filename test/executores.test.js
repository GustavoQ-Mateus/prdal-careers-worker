const assert = require('node:assert/strict');
const test = require('node:test');
const { ExecutorKeywords, SEM_KEYWORDS } = require('../dist/executores/keywords');
const { ExecutorImportacao, ExecutorReindexacao, ITEM_SEM_REGISTRO } = require('../dist/executores/lotes');
const { ExecutorPacote } = require('../dist/executores/pacote');
const { dadosDaNarracao, narrar, proximaSituacao } = require('../dist/dominio');
const { montarExecutores } = require('../dist/executores');
const { ArmazenamentoMemoria } = require('./helpers/armazenamento-memoria');

const job = (tipo, referenciaId, extra = {}) => ({ id: `job-${referenciaId}`, tipo, tentativas: 1, usuarioId: 'u1', referenciaId, requestId: 'r', entrada: null, ...extra });

function bancoVagas(vaga) {
  const historico = [];
  const casa = (where) => where.id === vaga.id && (where.descricao === undefined || where.descricao === vaga.descricao)
    && (where.keywordsExtracao === undefined || (typeof where.keywordsExtracao === 'string' ? where.keywordsExtracao === vaga.keywordsExtracao : where.keywordsExtracao.not !== vaga.keywordsExtracao));
  return {
    vaga,
    historico,
    prisma: {
      vaga: {
        findUnique: async () => ({ id: vaga.id, usuarioId: vaga.usuarioId, descricao: vaga.descricao }),
        update: async ({ data }) => { Object.assign(vaga, data); historico.push(data.keywordsExtracao); },
        updateMany: async ({ where, data }) => {
          if (!casa(where)) return { count: 0 };
          Object.assign(vaga, data);
          historico.push(data.keywordsExtracao);
          return { count: 1 };
        },
      },
    },
  };
}

test('extracao de keywords passa por extraindo e termina em prontas', async () => {
  const b = bancoVagas({ id: 'v1', usuarioId: 'u1', descricao: 'Java e Docker', keywordsExtracao: 'PENDENTE' });
  const ia = { keywords: async (descricao, usuarioId) => ({ keywords: [{ termo: 'Java', peso: 1 }], status: 'VALIDAS', degradacao: null, usuarioId, descricao }) };
  const resultado = await new ExecutorKeywords(b.prisma, ia).executar(job('extrair_keywords', 'v1'));
  assert.deepEqual(resultado, { keywords: 1 });
  assert.deepEqual(b.historico, ['EXTRAINDO', 'PRONTAS']);
  assert.deepEqual([b.vaga.keywordsStatus, b.vaga.keywordsErro], ['VALIDAS', null]);
});

test('extracao sem termos validos falha, volta a pendente entre tentativas e termina em erro visivel', async () => {
  const b = bancoVagas({ id: 'v1', usuarioId: 'u1', descricao: 'x', keywordsExtracao: 'PENDENTE' });
  const executor = new ExecutorKeywords(b.prisma, { keywords: async () => ({ keywords: [], status: 'PENDENTE', degradacao: null }) });
  await assert.rejects(executor.executar(job('extrair_keywords', 'v1')), (err) => err.message === SEM_KEYWORDS);
  assert.equal(b.vaga.keywordsExtracao, 'PENDENTE');
  await executor.aoEsgotar(job('extrair_keywords', 'v1', { tentativas: 3 }), 'ai-service respondeu 503: IA indisponivel');
  assert.deepEqual([b.vaga.keywordsExtracao, b.vaga.keywordsErro], ['ERRO', 'ai-service respondeu 503: IA indisponivel']);
});

test('descricao editada durante a extracao descarta o resultado antigo', async () => {
  const b = bancoVagas({ id: 'v1', usuarioId: 'u1', descricao: 'antiga', keywordsExtracao: 'PENDENTE' });
  const ia = { keywords: async () => { b.vaga.descricao = 'nova'; return { keywords: [{ termo: 'Go', peso: 1 }], status: 'VALIDAS', degradacao: null }; } };
  assert.deepEqual(await new ExecutorKeywords(b.prisma, ia).executar(job('extrair_keywords', 'v1')), { descartado: 'a descricao mudou durante a extracao' });
  assert.equal(b.vaga.keywords, undefined);
});

function bancoLote(itens, extras = {}) {
  const lote = { id: 'l1', usuarioId: 'u1', status: 'PENDENTE', processados: 0 };
  const porId = new Map(itens.map((i) => [i.id, { loteId: 'l1', status: 'PENDENTE', tentativas: 0, erro: null, vagaId: null, documentoRagId: null, referenciaLegada: null, ...i }]));
  const prisma = {
    lote,
    itens: porId,
    loteItem: {
      findUnique: async ({ where }) => (porId.has(where.id) ? { ...porId.get(where.id), lote: { id: 'l1', usuarioId: 'u1' } } : null),
      update: async ({ where, data }) => Object.assign(porId.get(where.id), data),
      count: async ({ where }) => [...porId.values()].filter((i) => where.status.in.includes(i.status)).length,
    },
    lote: {
      update: async ({ data }) => { if (data.processados) lote.processados += data.processados.increment; },
      updateMany: async ({ where, data }) => {
        if ((where.status === 'PENDENTE' && lote.status !== 'PENDENTE') || (where.status?.not && lote.status === where.status.not)) return { count: 0 };
        Object.assign(lote, data);
        return { count: 1 };
      },
    },
    $transaction: async (ops) => Promise.all(ops),
    ...extras,
  };
  prisma.estadoLote = lote;
  return prisma;
}

test('importacao em leque: cada item classifica a entrada e o lote fecha quando nao sobra item aberto', async () => {
  const vagas = { v1: { id: 'v1', titulo: 'Dev', descricao: 'Java', estagio: 'ENTRADA' }, v2: { id: 'v2', titulo: 'QA', descricao: 'Testes', estagio: 'ATIVA' } };
  const atualizadas = {};
  const prisma = bancoLote([{ id: 'i1', vagaId: 'v1' }, { id: 'i2', vagaId: 'v2' }], {
    vaga: {
      findUnique: async ({ where }) => vagas[where.id] ?? null,
      updateMany: async ({ where, data }) => {
        const v = vagas[where.id];
        if (!v || v.estagio !== where.estagio) return { count: 0 };
        atualizadas[where.id] = data;
        Object.assign(v, data);
        return { count: 1 };
      },
    },
  });
  const ia = { classificar: async (titulo) => (titulo === 'Dev' ? { categoria: 'backend', nivel: 'pleno' } : { categoria: 'qa', nivel: 'junior' }) };
  const executor = new ExecutorImportacao(prisma, ia);
  assert.deepEqual(await executor.executar(job('importar_lote', 'i1')), { categoria: 'backend', nivel: 'pleno' });
  assert.equal(prisma.itens.get('i1').status, 'CONCLUIDO');
  assert.deepEqual(atualizadas.v1, { categoria: 'backend', nivel: 'pleno' });
  assert.equal(prisma.estadoLote.status, 'PROCESSANDO');
  assert.deepEqual(await executor.executar(job('importar_lote', 'i2')), { ignorado: 'oportunidade ja ativada' });
  assert.equal(atualizadas.v2, undefined);
  assert.deepEqual([prisma.estadoLote.status, prisma.estadoLote.processados], ['CONCLUIDO', 2]);
  assert.deepEqual(await executor.executar(job('importar_lote', 'i1')), { status: 'CONCLUIDO' });
});

test('reindexacao indexa o documento do item e item sem registro falha com mensagem clara', async () => {
  const indexados = [];
  const prisma = bancoLote([{ id: 'i1', documentoRagId: 'd1' }, { id: 'i2' }], {
    documentoRag: { findUnique: async ({ where }) => ({ id: where.id, usuarioId: 'u1', origemId: 'o', tipo: 'nota', texto: 't' }) },
  });
  const executor = new ExecutorReindexacao(prisma, { indexar: async (doc) => { indexados.push(doc.id); return 2; } });
  assert.deepEqual(await executor.executar(job('reindexar_contexto', 'i1')), { chunks: 2 });
  assert.deepEqual(indexados, ['d1']);
  await assert.rejects(executor.executar(job('reindexar_contexto', 'i2')), (err) => err.message === ITEM_SEM_REGISTRO);
});

test('empacotamento le os arquivos do s3, grava o zip e so referencia se o curriculo nao mudou', async () => {
  const armazenamento = new ArmazenamentoMemoria();
  await armazenamento.gravar('usuarios/u1/curriculos/cv.pdf', Buffer.from('%PDF'), 'application/pdf');
  const curriculo = { id: 'cv', rotulo: 'V2', markdown: '# Editado', docxPath: null, pdfPath: 'usuarios/u1/curriculos/cv.pdf', pacotePath: null, vaga: { usuarioId: 'u1', titulo: 'Dev', empresa: 'Acme' } };
  const filtros = [];
  const prisma = {
    curriculo: {
      findUnique: async () => curriculo,
      updateMany: async ({ where, data }) => { filtros.push(where); Object.assign(curriculo, data); return { count: 1 }; },
    },
  };
  const resultado = await new ExecutorPacote(prisma, armazenamento).executar(job('empacotar_curriculo', 'cv'));
  assert.equal(resultado.pacotePath, 'usuarios/u1/curriculos/cv.zip');
  assert.deepEqual(filtros[0], { id: 'cv', markdown: '# Editado', docxPath: null, pdfPath: 'usuarios/u1/curriculos/cv.pdf' });
  const zip = armazenamento.objetos.get('usuarios/u1/curriculos/cv.zip').dados.toString('latin1');
  assert.match(zip, /Dev - Acme\/Curriculo_V2\.md/);
  assert.match(zip, /Curriculo_V2\.pdf/);
  assert.doesNotMatch(zip, /Curriculo_V2\.docx/);
});

test('todo tipo de job tem executor', () => {
  const executores = montarExecutores({ prisma: {}, ia: {}, documentos: {}, armazenamento: new ArmazenamentoMemoria() });
  assert.deepEqual(Object.keys(executores).sort(), ['empacotar_curriculo', 'excluir_conta', 'exportar_dados', 'extrair_keywords', 'gerar_curriculo', 'importar_lote', 'reindexar_contexto', 'sincronizar_lembrete']);
});

test('narracao em duas mensagens, sem marcador nem travessao', () => {
  const analise = { score: 48, keywordsEncontradas: ['TypeScript'], keywordsCriticasAusentes: ['Docker'], pontosEliminatorios: ['secao obrigatoria ausente'], veredicto: 'Cobertura baixa.' };
  const dados = dadosDaNarracao(analise, { ...analise, score: 76, pontosEliminatorios: [] }, 'Curriculo mantido com 2 paginas');
  const { etapa1, etapa3 } = narrar(dados);
  assert.match(etapa1, /^Etapa 1: Aderência do perfil-mestre\nScore: 48\n/);
  assert.match(etapa1, /Pontos de atenção: secao obrigatoria ausente/);
  assert.match(etapa3, /Score: 76\. Para referência, a aderência do perfil-mestre foi 48\./);
  assert.match(etapa3, /Keywords ainda ausentes: Docker/);
  assert.match(etapa3, /Observação: Curriculo mantido com 2 paginas/);
  for (const texto of [etapa1, etapa3]) {
    for (const proibido of ['[[', ']]', '\u2014', 'aumentou', 'melhorou', 'reduziu']) assert.ok(!texto.includes(proibido), proibido);
  }
  assert.equal(dadosDaNarracao({ score: 'x' }, analise, null), null);
});

test('conclusao e falha so valem para a geracao em andamento; perfil alterado vira desatualizada', () => {
  const gerando = { estado: 'GERANDO', jobId: 'g1', curriculoId: null, perfilAlteradoNaGeracao: false };
  assert.equal(proximaSituacao(gerando, { tipo: 'geracao_concluida', jobId: 'g1', curriculoId: 'cv', narracao: null }).estado, 'CONCLUIDA');
  assert.equal(proximaSituacao({ ...gerando, perfilAlteradoNaGeracao: true }, { tipo: 'geracao_concluida', jobId: 'g1', curriculoId: 'cv', narracao: null }).estado, 'DESATUALIZADA');
  assert.equal(proximaSituacao(gerando, { tipo: 'geracao_falhou', jobId: 'g1', erro: 'x' }).estado, 'FALHOU');
  assert.equal(proximaSituacao(gerando, { tipo: 'geracao_falhou', jobId: 'outro', erro: 'x' }), null);
  assert.equal(proximaSituacao({ ...gerando, estado: 'ANALISADA' }, { tipo: 'geracao_concluida', jobId: 'g1', curriculoId: 'cv', narracao: null }), null);
});
