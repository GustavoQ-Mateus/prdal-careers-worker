const assert = require('node:assert/strict');
const test = require('node:test');
const { ExecutorGeracao, DEGRADACAO_CONTEXTO, DEGRADACAO_RENDERIZACAO, ENTRADA_AUSENTE } = require('../dist/executores/geracao');
const { ArmazenamentoMemoria } = require('./helpers/armazenamento-memoria');

const analise = { score: 70, keywordsEncontradas: [], keywordsCriticasAusentes: [], pontosEliminatorios: [], veredicto: 'ok', breakdown: {} };
const estrutura = { titulo: { texto: 'Dev', fontes: ['e1'] }, resumo: [], experiencias: [], competencias: [], experienciasOmitidas: [] };
const entrada = {
  perfilMestre: { nome: 'Pessoa' },
  vaga: { titulo: 'Analista de Dados', empresa: 'Acme', descricao: 'Requisitos: SQL e Power BI.', keywords: [] },
  keywords: [{ termo: 'Excel', peso: 0.4 }, { termo: 'SQL', peso: 1 }, { termo: 'Power BI', peso: 0.8 }],
};

function banco({ status = 'PENDENTE' } = {}) {
  const estado = {
    geracao: { id: 'g1', status, usuarioId: 'u1', vagaId: 'v1', curriculoId: null, vaga: { titulo: 'Analista de Dados', empresa: 'Acme' } },
    atualizacoes: [],
    curriculo: null,
    eventos: [],
    pipeline: { vagaId: 'v1', usuarioId: 'u1', estado: 'GERANDO', jobId: 'g1', curriculoId: null, perfilAlteradoNaGeracao: false, versao: 1 },
    eventosPipeline: [],
    job: { resultado: null },
  };
  const atualizarGeracao = async ({ data }) => {
    estado.atualizacoes.push(data);
    Object.assign(estado.geracao, data);
  };
  const tx = {
    curriculo: { create: async ({ data }) => { estado.curriculo = data; } },
    geracaoCurriculo: { update: atualizarGeracao, findFirst: async () => estado.geracao },
    eventoOportunidade: { create: async ({ data }) => estado.eventos.push(data) },
    pipelineAts: {
      findUnique: async () => estado.pipeline,
      updateMany: async ({ where, data }) => {
        if (where.versao !== estado.pipeline.versao) return { count: 0 };
        Object.assign(estado.pipeline, data);
        return { count: 1 };
      },
      create: async () => {},
    },
    eventoPipelineAts: { create: async ({ data }) => estado.eventosPipeline.push(data) },
    $queryRaw: async () => [],
  };
  const prisma = {
    estado,
    usuario: { findUnique: async () => ({ consentimentoLlmEm: new Date() }) },
    geracaoCurriculo: { findUnique: async () => ({ ...estado.geracao }), update: atualizarGeracao },
    curriculo: { count: async () => 0, findUnique: async () => estado.curriculo },
    job: {
      findUnique: async () => estado.job,
      update: async ({ data }) => { Object.assign(estado.job, data); },
    },
    $transaction: async (fn) => fn(tx),
  };
  return prisma;
}

test('geracao sem consentimento falha antes de consultar contexto ou chamar IA', async () => {
  const prisma = banco();
  prisma.usuario.findUnique = async () => ({ consentimentoLlmEm: null });
  const { servico } = executor(prisma, {
    rag: { recuperar: async () => { throw new Error('contexto nao deveria ser lido'); } },
    ia: { gerarCurriculo: async () => { throw new Error('IA nao deveria ser chamada'); } },
  });
  await assert.rejects(servico.executar(job()), /consentimento.*ausente ou revogado/);
  assert.equal(prisma.estado.atualizacoes.length, 0);
});

function pdf(paginas) {
  return Buffer.from(Array.from({ length: paginas }, () => '/Type /Page\n').join(''));
}

function executor(prisma, { ia = {}, documentos, rag, armazenamento = new ArmazenamentoMemoria(), passos } = {}) {
  const docs = documentos ?? { renderPdf: async () => pdf(1), renderDocx: async () => Buffer.from('docx') };
  const servico = new ExecutorGeracao(
    prisma,
    { gerarCurriculo: async () => ({ markdown: '# Pessoa', analiseInicial: analise, analiseFinal: analise, degradacao: null }), ...ia },
    docs,
    armazenamento,
    rag ?? { recuperar: async () => ({ chunks: [], degradacao: null }) },
    passos,
  );
  servico.logger.warn = () => {};
  return { servico, armazenamento };
}

const job = (extra = {}) => ({ id: 'job-x', tipo: 'gerar_curriculo', tentativas: 1, usuarioId: 'u1', referenciaId: 'g1', requestId: 'req', entrada, ...extra });

test('geracao em passos repara, respeita o teto e grava estado para retomada', async () => {
  const prisma = banco();
  const chamadas = [];
  let falhar = true;
  const passos = { executar: async (passo, payload) => {
    chamadas.push([passo, payload]);
    if (passo === 'rascunho') return { rascunho: { titulo: {} }, promptVersion: 'reescrita.v4', modelo: 'simulado', uso: { chamadas: 1 } };
    if (passo === 'verificar' && falhar) { falhar = false; throw new Error('timeout do passo'); }
    if (passo === 'verificar' && !payload.estado) return { estado: { titulo: null }, rejeitadas: [{ chave: 'resumo.1' }], uso: { chamadas: 1 } };
    if (passo === 'reparar') return { reparos: [{ chave: 'resumo.1', texto: 'Aceita', fontes: ['resumo'] }], uso: { chamadas: 1 } };
    if (passo === 'verificar') return { estado: { titulo: { texto: 'Aceita' } }, rejeitadas: [], uso: { chamadas: 1 } };
    return { markdown: '# Pessoa', estrutura, analiseInicial: analise, analiseFinal: analise, degradacao: null };
  } };
  const { servico } = executor(prisma, { passos });
  await assert.rejects(servico.executar(job()), /timeout do passo/);
  assert.equal(prisma.estado.job.resultado.passos.rascunho.modelo, 'simulado');
  await servico.executar(job({ tentativas: 2 }));
  assert.deepEqual(chamadas.map(([passo]) => passo), ['rascunho', 'verificar', 'verificar', 'reparar', 'verificar', 'montar']);
  assert.equal(chamadas[4][1].chamadasRestantes, 3);
  const status = prisma.estado.atualizacoes.map((item) => item.status).filter(Boolean);
  assert.ok(status.some((item, indice) => item === 'VALIDANDO' && status[indice + 1] === 'GERANDO' && status[indice + 2] === 'VALIDANDO'));
  assert.equal(prisma.estado.curriculo.modelo, 'simulado');
});

test('teto esgotado monta so com frases aceitas sem chamar reparo', async () => {
  const prisma = banco();
  const chamadas = [];
  const passos = { executar: async (passo, payload) => {
    chamadas.push([passo, payload]);
    if (passo === 'rascunho') return { rascunho: {}, promptVersion: 'reescrita.v4', uso: { chamadas: 5 } };
    if (passo === 'verificar') return { estado: {}, rejeitadas: [{ chave: 'resumo.1' }], uso: { chamadas: 1 } };
    if (passo === 'montar') return { markdown: '# Pessoa', estrutura, analiseInicial: analise, analiseFinal: analise, degradacao: null };
    throw new Error('reparo excedeu teto');
  } };
  await executor(prisma, { passos }).servico.executar(job());
  assert.deepEqual(chamadas.map(([passo]) => passo), ['rascunho', 'verificar', 'montar']);
  assert.equal(chamadas[1][1].chamadasRestantes, 1);
});

test('o rag e consultado pelas keywords da vaga por peso, e as fontes seguem tipadas ate a geracao', async () => {
  const consultas = [];
  const payloads = [];
  const fonte = { id: 'n1', tipo: 'nota', factual: false, titulo: 'Planos', texto: 'quero estudar Kubernetes' };
  const { servico } = executor(banco(), {
    rag: { recuperar: async (usuarioId, termos) => { consultas.push([usuarioId, termos]); return { chunks: [fonte], degradacao: null }; } },
    ia: { gerarCurriculo: async (payload, usuarioId, operacao) => { payloads.push([payload, usuarioId, operacao]); return { markdown: '# P', analiseInicial: analise, analiseFinal: analise, degradacao: null }; } },
  });
  await servico.executar(job());
  assert.deepEqual(consultas, [['u1', ['SQL', 'Power BI', 'Excel']]]);
  assert.deepEqual(payloads[0][0].contexto, [fonte]);
  assert.deepEqual(payloads[0][0].perfilMestre, { nome: 'Pessoa' });
  assert.deepEqual(payloads[0].slice(1), ['u1', 'geracao:g1']);
});

test('rag fora gera com degradacao explicita somada a da reescrita', async () => {
  const prisma = banco();
  const { servico } = executor(prisma, {
    rag: { recuperar: async () => { throw new Error('connect ECONNREFUSED ai-service:8000'); } },
    ia: { gerarCurriculo: async () => ({ markdown: '# P', analiseInicial: analise, analiseFinal: analise, degradacao: 'A reescrita está indisponível no momento.' }) },
  });
  await servico.executar(job());
  assert.equal(prisma.estado.curriculo.degradacao, `${DEGRADACAO_CONTEXTO}; A reescrita está indisponível no momento.`);
});

test('conclui gravando pdf, docx e o zip por chave, com modelo e versao do prompt, e passa o pipeline para concluida', async () => {
  const prisma = banco();
  const { servico, armazenamento } = executor(prisma, {
    ia: { gerarCurriculo: async () => ({ markdown: '# Pessoa', analiseInicial: analise, analiseFinal: { ...analise, score: 81 }, degradacao: null, modelo: 'claude-sonnet-5', promptVersion: 'reescrita.v3' }) },
  });
  const resultado = await servico.executar(job());
  const cv = prisma.estado.curriculo;
  assert.equal(prisma.estado.geracao.status, 'CONCLUIDA');
  assert.deepEqual(prisma.estado.atualizacoes.map((a) => a.status).filter(Boolean), ['ANALISANDO', 'GERANDO', 'VALIDANDO', 'CONCLUIDA']);
  assert.equal(cv.pdfPath, `usuarios/u1/curriculos/${cv.id}.pdf`);
  assert.equal(cv.docxPath, `usuarios/u1/curriculos/${cv.id}.docx`);
  assert.equal(cv.pacotePath, `usuarios/u1/curriculos/${cv.id}.zip`);
  assert.equal(armazenamento.objetos.get(cv.pacotePath).dados.subarray(0, 2).toString(), 'PK');
  assert.match(armazenamento.objetos.get(cv.pacotePath).dados.toString('latin1'), /Analista de Dados - Acme\/Curriculo_Acme .{1,3} Analista de Dados\.pdf/);
  assert.deepEqual([cv.modelo, cv.promptVersion, cv.score], ['claude-sonnet-5', 'reescrita.v3', 81]);
  assert.equal(prisma.estado.eventos[0].tipo, 'CURRICULO_GERADO');
  assert.deepEqual([prisma.estado.pipeline.estado, prisma.estado.pipeline.curriculoId], ['CONCLUIDA', cv.id]);
  assert.equal(prisma.estado.eventosPipeline[0].tipo, 'geracao_concluida');
  assert.equal(prisma.estado.eventosPipeline[0].dados.narracao.scoreFinal, 81);
  assert.deepEqual(resultado, { curriculoId: cv.id, score: 81, paginas: 1, degradacao: null });
});

test('doc-service fora conclui com degradacao e sem pdf nem docx, mas com o zip do markdown', async () => {
  const prisma = banco();
  const falhar = async () => { throw new Error('connect ECONNREFUSED doc-service'); };
  const { servico } = executor(prisma, { documentos: { renderPdf: falhar, renderDocx: falhar } });
  await servico.executar(job());
  assert.equal(prisma.estado.geracao.status, 'CONCLUIDA');
  assert.equal(prisma.estado.curriculo.pdfPath, null);
  assert.equal(prisma.estado.curriculo.degradacao, DEGRADACAO_RENDERIZACAO);
  assert.ok(prisma.estado.curriculo.pacotePath);
});

test('corte de pagina re-renderiza a estrutura por nivel sem gerar de novo', async () => {
  const prisma = banco();
  const paginas = { longo: 2, medio: 2, curto: 1 };
  const cortes = [];
  const cortada1 = { ...estrutura, experienciasOmitidas: ['a'] };
  const cortada2 = { ...estrutura, experienciasOmitidas: ['a', 'b'] };
  const reducoes = [
    { markdown: 'medio', estrutura: cortada1, analiseInicial: analise, analiseFinal: analise },
    { markdown: 'curto', estrutura: cortada2, analiseInicial: analise, analiseFinal: { ...analise, score: 65 } },
  ];
  let geracoes = 0;
  const { servico } = executor(prisma, {
    documentos: { renderPdf: async (md) => pdf(paginas[md] ?? 1), renderDocx: async () => Buffer.from('d') },
    ia: {
      gerarCurriculo: async () => { geracoes += 1; return { markdown: 'longo', estrutura, analiseInicial: analise, analiseFinal: analise, degradacao: null }; },
      reduzirCurriculo: async (payload, operacao) => { cortes.push([payload.nivel, payload.estrutura === estrutura, 'contexto' in payload, operacao]); return reducoes[payload.nivel - 1]; },
    },
  });
  await servico.executar(job());
  assert.equal(geracoes, 1);
  assert.deepEqual(cortes, [[1, true, false, 'geracao:g1'], [2, true, false, 'geracao:g1']]);
  assert.equal(prisma.estado.curriculo.markdown, 'curto');
  assert.deepEqual(prisma.estado.curriculo.estrutura, cortada2);
  assert.equal(prisma.estado.curriculo.score, 65);
  assert.equal(prisma.estado.curriculo.degradacao, null);
});

test('corte que nao muda o texto encerra o laco e registra as paginas', async () => {
  const prisma = banco();
  const { servico } = executor(prisma, {
    documentos: { renderPdf: async () => pdf(2), renderDocx: async () => Buffer.from('d') },
    ia: {
      gerarCurriculo: async () => ({ markdown: 'longo', estrutura, analiseInicial: analise, analiseFinal: analise, degradacao: null }),
      reduzirCurriculo: async () => ({ markdown: 'longo', estrutura, analiseInicial: analise, analiseFinal: analise }),
    },
  });
  await servico.executar(job());
  assert.match(prisma.estado.curriculo.degradacao, /2 paginas apos 1 rodada/);
});

test('falha do modelo propaga para o worker contar a tentativa, sem marcar a geracao como erro', async () => {
  const prisma = banco();
  const { servico } = executor(prisma, { ia: { gerarCurriculo: async () => { throw new Error('ai-service respondeu 503: IA indisponivel'); } } });
  await assert.rejects(servico.executar(job()), /503/);
  assert.equal(prisma.estado.geracao.status, 'GERANDO');
  assert.equal(prisma.estado.curriculo, null);
});

test('na ultima tentativa a geracao fica em erro com a mensagem e o pipeline vai para falhou', async () => {
  const prisma = banco();
  prisma.estado.geracao.status = 'GERANDO';
  const { servico } = executor(prisma);
  await servico.aoEsgotar(job({ tentativas: 3 }), 'ai-service respondeu 503: IA indisponivel');
  assert.deepEqual([prisma.estado.geracao.status, prisma.estado.geracao.erro], ['ERRO', 'ai-service respondeu 503: IA indisponivel']);
  assert.equal(prisma.estado.pipeline.estado, 'FALHOU');
  assert.deepEqual(prisma.estado.eventosPipeline.map((e) => [e.tipo, e.dados.erro]), [['geracao_falhou', 'ai-service respondeu 503: IA indisponivel']]);
});

test('geracao ja concluida nao roda de novo e job sem entrada falha com mensagem clara', async () => {
  let chamadas = 0;
  const { servico } = executor(banco({ status: 'CONCLUIDA' }), { ia: { gerarCurriculo: async () => { chamadas += 1; } } });
  assert.deepEqual(await servico.executar(job()), { status: 'CONCLUIDA', curriculoId: null });
  assert.equal(chamadas, 0);
  const { servico: semEntrada } = executor(banco());
  await assert.rejects(semEntrada.executar(job({ entrada: null })), (err) => err.message === ENTRADA_AUSENTE);
});
