# worker

Consumidor de jobs SQS com geração de currículos, exportação, exclusão e lembretes. Implementa a `spec-v1.11.0`.

## Instalação, testes e execução

Execute na raiz desta unidade. Não são necessários arquivos do monorepo. Requer Node.js 22 e Git para instalar os contratos quando aplicável.

```text
npm ci
npm test
npm run build
npm start
```

Defina DATABASE_URL para um banco migrado pela API, SERVICE_TOKEN e os endpoints SQS, S3, AI_SERVICE_URL e DOC_SERVICE_URL. Para testes PostgreSQL, defina PRDAL_TESTE_POSTGRES_URL para um banco descartável. A geração Prisma usa apenas o schema instalado em @prdal/contracts. /health e /ready usam a porta 3001.

## Imagem

```text
docker build -t prdal-worker .
```

O contexto é somente esta pasta. A imagem final executa sem root e não inclui dependências de desenvolvimento nem configurações de agentes. Injete as variáveis com --env-file em um arquivo local fora do controle de versão.

## Variáveis de ambiente

`DOCUMENTOS_MODO=http|lambda` seleciona o transporte do doc-service, com padrão `http`. No modo `lambda`, defina `LAMBDA_DOC_RENDER` com o nome ou ARN da função e permita `lambda:InvokeFunction` somente nela. `SERVICE_TOKEN` continua sendo enviado no cabeçalho `X-Prdal-Servico`; `DOC_SERVICE_TIMEOUT_MS` limita a espera (padrão 60000 ms).

A [invocação síncrona](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html) admite 6 MiB (6291456 bytes) em cada payload. O PDF volta em base64 dentro do JSON: para um envelope de H bytes sem o corpo base64, o máximo é `3 * floor((6291456 - H) / 4)` bytes de PDF. Portanto cabe menos de 4,5 MiB (4718592 bytes), descontando os cabeçalhos e demais campos do envelope. Acima disso, a Lambda rejeita a resposta, o cliente lança erro e o executor conclui com degradação de renderização, sem PDF nem DOCX, preservando o Markdown no ZIP pelo fluxo existente. Não há truncamento, streaming nem fallback automático para HTTP.

As variáveis opcionais usam os padrões definidos no código; configure explicitamente os destinos de banco e serviços no seu ambiente.

`AGENDADOR_MODO`, `AI_SERVICE_URL`, `AI_STEP_TIMEOUT_MS`, `AWS_ACCESS_KEY_ID`, `AWS_REGION`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `COTA_TOKENS_DIA`, `DATABASE_URL`, `DESLIGAMENTO_PRAZO_MS`, `DOC_SERVICE_URL`, `EMBED_DIMENSAO`, `EXECUTOR_MODO`, `LEMBRETE_LAMBDA_ARN`, `LEMBRETE_URL`, `PRONTIDAO_TIMEOUT_MS`, `S3_BUCKET`, `S3_ENDPOINT`, `SCHEDULER_ROLE_ARN`, `SERVICE_TOKEN`, `SQS_ENDPOINT`, `SQS_FILA_JOBS_URL`, `VARREDURA_INTERVALO_MS`, `VARREDURA_PENDENTE_S`, `VARREDURA_REENVIO_S`, `WORKER_CONCORRENCIA`, `WORKER_ESPERA_S`, `WORKER_LEASE_S`, `WORKER_MAX_TENTATIVAS`, `WORKER_PORTA`, `WORKER_VISIBILIDADE_INICIAL_S`.
