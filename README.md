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

As variáveis opcionais usam os padrões definidos no código; configure explicitamente os destinos de banco e serviços no seu ambiente.

`AGENDADOR_MODO`, `AI_SERVICE_URL`, `AI_STEP_TIMEOUT_MS`, `AWS_ACCESS_KEY_ID`, `AWS_REGION`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `COTA_TOKENS_DIA`, `DATABASE_URL`, `DESLIGAMENTO_PRAZO_MS`, `DOC_SERVICE_URL`, `EMBED_DIMENSAO`, `EXECUTOR_MODO`, `LEMBRETE_LAMBDA_ARN`, `LEMBRETE_URL`, `PRONTIDAO_TIMEOUT_MS`, `S3_BUCKET`, `S3_ENDPOINT`, `SCHEDULER_ROLE_ARN`, `SERVICE_TOKEN`, `SQS_ENDPOINT`, `SQS_FILA_JOBS_URL`, `VARREDURA_INTERVALO_MS`, `VARREDURA_PENDENTE_S`, `VARREDURA_REENVIO_S`, `WORKER_CONCORRENCIA`, `WORKER_ESPERA_S`, `WORKER_LEASE_S`, `WORKER_MAX_TENTATIVAS`, `WORKER_PORTA`, `WORKER_VISIBILIDADE_INICIAL_S`.
