class JobsMemoria {
  constructor() {
    this.jobs = new Map();
  }

  criar(dados) {
    const job = { status: 'PENDENTE', tentativas: 0, lockedBy: null, lockedUntil: 0, erro: null, resultado: null, requestId: null, entrada: null, usuarioId: 'u1', referenciaId: 'ref', enfileiradoEm: null, criadoEm: Date.now(), ...dados };
    this.jobs.set(job.id, job);
    return job;
  }

  copia(job) {
    const { id, tipo, status, tentativas, usuarioId, referenciaId, requestId, entrada } = job;
    return { id, tipo, status, tentativas, usuarioId, referenciaId, requestId, entrada };
  }

  async obterLease(id, worker, leaseS) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (!(job.status === 'PENDENTE' || (job.status === 'PROCESSANDO' && job.lockedUntil < Date.now()))) return null;
    Object.assign(job, { status: 'PROCESSANDO', lockedBy: worker, lockedUntil: Date.now() + leaseS * 1000, tentativas: job.tentativas + 1 });
    return this.copia(job);
  }

  dono(id, worker) {
    const job = this.jobs.get(id);
    return job && job.status === 'PROCESSANDO' && job.lockedBy === worker ? job : null;
  }

  async estender(id, worker, leaseS) {
    const job = this.dono(id, worker);
    if (job) job.lockedUntil = Date.now() + leaseS * 1000;
    return !!job;
  }

  async concluir(id, worker, resultado) {
    const job = this.dono(id, worker);
    if (job) Object.assign(job, { status: 'CONCLUIDO', resultado, erro: null, lockedUntil: 0 });
    return !!job;
  }

  async liberarComErro(id, worker, erro) {
    const job = this.dono(id, worker);
    if (job) Object.assign(job, { status: 'PENDENTE', erro, lockedUntil: 0, lockedBy: null });
    return !!job;
  }

  async falharDefinitivo(id, worker, erro) {
    const job = this.dono(id, worker);
    if (job) Object.assign(job, { status: 'ERRO', erro, lockedUntil: 0 });
    return !!job;
  }

  async devolver(id, worker) {
    const job = this.dono(id, worker);
    if (job) Object.assign(job, { status: 'PENDENTE', tentativas: Math.max(job.tentativas - 1, 0), lockedUntil: 0, lockedBy: null });
    return !!job;
  }

  async criarExclusoesVencidas() {
    return [];
  }

  async paraReenviar() {
    const saida = [...this.jobs.values()].filter((j) => j.status === 'PENDENTE' && !j.enfileiradoEm);
    saida.forEach((j) => (j.enfileiradoEm = Date.now()));
    return saida.map((j) => ({ id: j.id, tipo: j.tipo }));
  }

  async orfaosEsgotados() {
    return [];
  }

  async estado(id) {
    return this.jobs.get(id)?.status ?? null;
  }

  async verificar() {}
}

module.exports = { JobsMemoria };
