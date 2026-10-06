const assert = require('node:assert/strict');
const test = require('node:test');
const { InvokeCommand } = require('@aws-sdk/client-lambda');
const { DocumentosHttp, DocumentosLambda, ErroDoServico, criarDocumentos } = require('../dist/clientes');

test('seleciona documentos pelo ambiente com http como padrao', () => {
  assert.ok(criarDocumentos({}) instanceof DocumentosHttp);
  assert.ok(criarDocumentos({ DOCUMENTOS_MODO: 'http' }) instanceof DocumentosHttp);
  assert.ok(criarDocumentos({ DOCUMENTOS_MODO: 'lambda' }) instanceof DocumentosLambda);
  assert.throws(() => criarDocumentos({ DOCUMENTOS_MODO: 'outro' }), /DOCUMENTOS_MODO invalido/);
});

for (const formato of ['pdf', 'docx']) {
  test(`renderiza ${formato} por lambda com evento http v2 e binario intacto`, async () => {
    const binario = Buffer.from([0, 255, 128, 1, 80]);
    const cliente = {
      send: async (comando, opcoes) => {
        assert.ok(comando instanceof InvokeCommand);
        assert.equal(comando.input.FunctionName, 'doc-render');
        assert.equal(comando.input.InvocationType, 'RequestResponse');
        assert.ok(opcoes.abortSignal instanceof AbortSignal);
        const evento = JSON.parse(comando.input.Payload);
        assert.equal(evento.version, '2.0');
        assert.equal(evento.routeKey, `POST /render/${formato}`);
        assert.equal(evento.rawPath, `/render/${formato}`);
        assert.equal(evento.requestContext.http.method, 'POST');
        assert.equal(evento.requestContext.http.path, evento.rawPath);
        assert.equal(evento.headers['X-Prdal-Servico'], 'token-falso');
        assert.equal(evento.headers['Content-Type'], 'application/json');
        assert.equal(evento.isBase64Encoded, false);
        assert.deepEqual(JSON.parse(evento.body), { markdown: '# Currículo', template: 'compact' });
        return { Payload: Buffer.from(JSON.stringify({ statusCode: 200, body: binario.toString('base64'), isBase64Encoded: true, headers: { 'x-PaGiNaS': '2' } })) };
      },
    };
    const documentos = new DocumentosLambda(cliente, { LAMBDA_DOC_RENDER: 'doc-render', SERVICE_TOKEN: ' token-falso ' });
    const resultado = await documentos[formato === 'pdf' ? 'renderPdf' : 'renderDocx']('# Currículo', 'compact');
    assert.deepEqual(Buffer.from(resultado), binario);
    assert.equal(resultado.paginas, 2);
  });
}

for (const status of [400, 503]) {
  test(`erro ${status} tem a mesma classe, corpo e mensagem do http`, async () => {
    const anterior = global.fetch;
    const corpo = { detail: 'falha simulada' };
    global.fetch = async () => new Response(JSON.stringify(corpo), { status });
    try {
      const documentos = new DocumentosLambda({
        send: async () => ({ Payload: Buffer.from(JSON.stringify({ statusCode: status, body: Buffer.from(JSON.stringify(corpo)).toString('base64'), isBase64Encoded: true })) }),
      }, { LAMBDA_DOC_RENDER: 'doc-render' });
      let erroHttp;
      try { await new DocumentosHttp({}).renderPdf('texto'); } catch (erro) { erroHttp = erro; }
      await assert.rejects(documentos.renderPdf('texto'), (erro) => {
        assert.ok(erro instanceof ErroDoServico);
        assert.equal(erro.status, status);
        assert.equal(erro.message, erroHttp.message);
        assert.deepEqual(erro.corpo, erroHttp.corpo);
        return true;
      });
    } finally { global.fetch = anterior; }
  });
}

test('FunctionError vira ErroDoServico', async () => {
  const documentos = new DocumentosLambda({ send: async () => ({ FunctionError: 'Unhandled', Payload: Buffer.from(JSON.stringify({ errorMessage: 'falha' })) }) }, { LAMBDA_DOC_RENDER: 'doc-render' });
  await assert.rejects(documentos.renderPdf('texto'), (erro) => erro instanceof ErroDoServico && erro.status === 502);
});

test('falha do sdk vira indisponibilidade e funcao ausente nao invoca', async () => {
  const cliente = { send: async () => { throw new Error('limite de payload'); } };
  await assert.rejects(new DocumentosLambda(cliente, { LAMBDA_DOC_RENDER: 'doc-render' }).renderPdf('texto'), /doc-service indisponivel: limite de payload/);
  await assert.rejects(new DocumentosLambda(cliente, {}).renderPdf('texto'), /LAMBDA_DOC_RENDER ausente/);
});

test('cabecalhos invalidos nao inventam quantidade de paginas', async () => {
  for (const paginas of [undefined, '0', '-1', '2.5', '9007199254740992']) {
    const documentos = new DocumentosLambda({ send: async () => ({ Payload: Buffer.from(JSON.stringify({ statusCode: 200, body: 'pdf', headers: { 'X-Paginas': paginas } })) }) }, { LAMBDA_DOC_RENDER: 'doc-render' });
    assert.equal((await documentos.renderPdf('texto')).paginas, undefined);
  }
});

test('payload ausente ou invalido vira erro do servico', async () => {
  for (const Payload of [undefined, Buffer.from('invalido'), Buffer.from('{}')]) {
    const documentos = new DocumentosLambda({ send: async () => ({ Payload }) }, { LAMBDA_DOC_RENDER: 'doc-render' });
    await assert.rejects(documentos.renderPdf('texto'), (erro) => erro instanceof ErroDoServico && erro.status === 502);
  }
});
