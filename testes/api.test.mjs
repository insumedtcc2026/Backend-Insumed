// Testes de integração da API do Insumed contra um Postgres em memória (pg-mem).
// Nada aqui toca o banco real: src/database/index.js é substituído pelo knex do pg-mem.
// Rodar com: npm test
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { newDb } from 'pg-mem';
import request from 'supertest';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireBackend = createRequire(path.join(BACKEND, 'package.json'));
const jwt = requireBackend('jsonwebtoken');
const bcrypt = requireBackend('bcrypt');

process.env.ACCESS_TOKEN_SECRET = 'segredo-de-teste';
process.env.NODE_ENV = 'test';

const db = newDb();
// pg-mem não traz REPLACE(); o Postgres/Neon tem nativamente
db.public.registerFunction({ name: 'replace', args: ['text', 'text', 'text'], returns: 'text', implementation: (a, b, c) => a == null ? null : a.split(b).join(c) });
// REGEXP_REPLACE(texto, padrão, troca, 'g') usado na matrícula
db.public.registerFunction({ name: 'regexp_replace', args: ['text', 'text', 'text', 'text'], returns: 'text', implementation: (a, b, c, f) => a == null ? null : a.replace(new RegExp(b, f), c) });
// TRIM(texto) usado na busca de insumo pelo nome
db.public.registerFunction({ name: 'trim', args: ['text'], returns: 'text', implementation: (a) => a == null ? null : a.trim() });
// gen_random_uuid() é nativo no Postgres 13+ (Neon)
db.public.registerFunction({ name: 'gen_random_uuid', returns: 'uuid', implementation: () => randomUUID(), impure: true });
db.public.none(`
  create table postosdesaude (pos_id serial primary key, pos_nome text, pos_endereco text, pos_latitude float, pos_longitude float);
  create table pacientes (pac_id serial primary key, pac_nome text, pac_email text, pac_senha text, pac_cpf text,
    pac_telefone text, pac_cep text, pac_data_nasc date, pac_endereco text, pac_sexo text, pac_raca text, pac_avatar text);
  create table administrador (adm_id serial primary key, adm_matricula text, adm_nome text, adm_email text, adm_tel text,
    adm_senha text, adm_cpf text, pos_id int, tp_universal boolean);
  create table autorizador (aut_id serial primary key, aut_nome text, aut_email text, aut_tel text, aut_senha text, aut_cpf text);
  create table insumo (ins_id serial primary key, ins_nome text, ins_quantidade int, ins_marca text, pos_id int);
  create table solicitacao (sol_id serial primary key, pac_id int, pos_id int, ins_id int, sol_prescricao bytea,
    sol_prescricao_tipo text, sol_observacao text, sol_status text, sol_insumo_quant int,
    sol_data_solicitacao timestamptz default now(), sol_data_vencimento date, sol_motivo_nao_autorizado text,
    sol_motivo_reenvio text, sol_data_de_coleta date, sol_protocolo text);
  create table coleta (col_id serial primary key, sol_id int, ins_id int, quantidade int);
`);

// aplica a migração entregue para o Neon (sem BEGIN/COMMIT, que o pg-mem não precisa)
const migracao = fs.readFileSync(
  path.join(BACKEND, 'database/migracoes/2026-10-13_melhorias_insumed.sql'), 'utf8')
  .replace(/^\s*(BEGIN|COMMIT);\s*$/gm, '')
  .replace(/^--.*$/gm, '');
db.public.none(migracao);
// O pg-mem usa índices parciais de forma errada: com ux_solicitacao_origem_ativa
// (só agendado/concluído), "WHERE sol_origem_id = X" deixa de achar os
// cancelados. No Postgres/Neon o índice fica; aqui ele é trocado por um comum.
// A regra "um agendamento ativo por prescrição" também é conferida no código.
db.public.none('DROP INDEX ux_solicitacao_origem_ativa; CREATE INDEX ix_teste_origem ON solicitacao (sol_origem_id);');

// migração de 15/10: só o trecho marcado (o resto usa DO $$ ... $$, que o pg-mem não executa)
const migracao2 = fs.readFileSync(
  path.join(BACKEND, 'database/migracoes/2026-10-15_reenvio_e_cadastros.sql'), 'utf8');
db.public.none(
  migracao2.slice(migracao2.indexOf('-- @pgmem-inicio'), migracao2.indexOf('-- @pgmem-fim'))
    .replace(/^--.*$/gm, ''));
// migração de 18/10 (notificações): só o trecho marcado
const migracao3 = fs.readFileSync(path.join(BACKEND, 'database/migracoes/2026-10-18_notificacoes.sql'), 'utf8');
db.public.none(
  migracao3.slice(migracao3.indexOf('-- @pgmem-inicio'), migracao3.indexOf('-- @pgmem-fim')).replace(/^--.*$/gm, '')
);
// migração de 24/10 (código do QR Code): só o trecho marcado
const migracao4 = fs.readFileSync(path.join(BACKEND, 'database/migracoes/2026-10-24_qrcode_agendamento.sql'), 'utf8');
db.public.none(
  migracao4.slice(migracao4.indexOf('-- @pgmem-inicio'), migracao4.indexOf('-- @pgmem-fim')).replace(/^--.*$/gm, '')
);

// migração de 25/10 (equipe por convite e estoque reservado): só o trecho marcado
const migracao5 = fs.readFileSync(path.join(BACKEND, 'database/migracoes/2026-10-25_equipe_e_estoque.sql'), 'utf8');
db.public.none(
  migracao5.slice(migracao5.indexOf('-- @pgmem-inicio'), migracao5.indexOf('-- @pgmem-fim')).replace(/^--.*$/gm, '')
);
// migração de 26/10 (etapa 2: itens da prescrição e retirada recorrente)
const migracao6 = fs.readFileSync(path.join(BACKEND, 'database/migracoes/2026-10-26_itens_e_recorrencia.sql'), 'utf8');
db.public.none(
  migracao6.slice(migracao6.indexOf('-- @pgmem-inicio'), migracao6.indexOf('-- @pgmem-fim')).replace(/^--.*$/gm, '')
);
// migração de 27/10 (etapa 3: agenda com turnos, outra data, presença, prioridade)
const migracao7 = fs.readFileSync(path.join(BACKEND, 'database/migracoes/2026-10-27_agenda.sql'), 'utf8');
db.public.none(
  migracao7.slice(migracao7.indexOf('-- @pgmem-inicio'), migracao7.indexOf('-- @pgmem-fim')).replace(/^--.*$/gm, '')
);
// migração de 28/10 (etapa 4: pessoas autorizadas e quem retirou)
const migracao8 = fs.readFileSync(path.join(BACKEND, 'database/migracoes/2026-10-28_autorizados_e_retirada.sql'), 'utf8');
db.public.none(
  migracao8.slice(migracao8.indexOf('-- @pgmem-inicio'), migracao8.indexOf('-- @pgmem-fim')).replace(/^--.*$/gm, '')
);

const knex = db.adapters.createKnex();
mock.module(pathToFileURL(path.join(BACKEND, 'src/database/index.js')).href, { defaultExport: knex });

let app;
const tk = {};
const ids = {};
const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const amanha = new Date(Date.parse(hoje) + 86400000).toISOString().slice(0, 10);
const ontem = new Date(Date.parse(hoje) - 86400000).toISOString().slice(0, 10);
const png = (txt) => Buffer.from('\x89PNG' + txt).toString('base64');
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const hashTeste = (codigo) => createHash('sha256').update(codigo).digest('hex');
// convite válido criado direto no banco (o fluxo pela API tem testes próprios)
const criarConvite = async (perfil, pos_id = null) => {
  const codigo = randomUUID();
  await knex('convite_equipe').insert({
    cnv_perfil: perfil, pos_id, cnv_codigo_hash: hashTeste(codigo), cnv_expira_em: new Date(Date.now() + 86400000),
  });
  return codigo;
};

before(async () => {
  const senha = await bcrypt.hash('Senha@123', 4);
  const [p1] = await knex('postosdesaude').insert({ pos_nome: 'Posto Centro' }).returning('pos_id');
  const [p2] = await knex('postosdesaude').insert({ pos_nome: 'Posto Norte' }).returning('pos_id');
  ids.posto1 = p1.pos_id; ids.posto2 = p2.pos_id;
  // as unidades de teste atendem todos os dias, sem limite (os testes usam
  // "amanhã", que pode cair no fim de semana); a agenda tem testes próprios (T)
  for (const pos_id of [ids.posto1, ids.posto2]) {
    for (let dia = 0; dia <= 6; dia++) {
      await knex('posto_horario').insert([
        { pos_id, phr_dia_semana: dia, phr_turno: 'manha', phr_abre: '08:00', phr_fecha: '12:00' },
        { pos_id, phr_dia_semana: dia, phr_turno: 'tarde', phr_abre: '13:00', phr_fecha: '17:00' },
      ]);
    }
  }
  const [a] = await knex('pacientes').insert({ pac_nome: 'Ana Souza', pac_email: 'ana@teste.com', pac_senha: senha, pac_cpf: '529.982.247-25', pac_telefone: '(24) 98888-7777' }).returning('pac_id');
  const [b] = await knex('pacientes').insert({ pac_nome: 'Bruno Lima', pac_email: 'bruno@teste.com', pac_senha: senha, pac_cpf: '111.444.777-35', pac_telefone: '(24) 97777-6666' }).returning('pac_id');
  ids.pacA = a.pac_id; ids.pacB = b.pac_id;
  await knex('administrador').insert({ adm_nome: 'Admin Geral', adm_email: 'adm@teste.com', adm_senha: senha, pos_id: ids.posto1, tp_universal: false });
  await knex('administrador').insert({ adm_nome: 'Admin Norte', adm_email: 'norte@teste.com', adm_senha: senha, pos_id: ids.posto2, tp_universal: false });
  const [aut] = await knex('autorizador').insert({ aut_nome: 'Carla Dias', aut_email: 'aut@teste.com', aut_senha: senha }).returning('aut_id');
  const [ins] = await knex('insumo').insert({ ins_nome: 'Fralda G', ins_quantidade: 1, pos_id: ids.posto1 }).returning('ins_id');
  ids.insumo = ins.ins_id;

  const assinar = (dados) => jwt.sign(dados, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '1h' });
  tk.pacA = assinar({ id: ids.pacA, tipo: 'PACIENTE' });
  tk.pacB = assinar({ id: ids.pacB, tipo: 'PACIENTE' });
  tk.adm = assinar({ email: 'adm@teste.com', posto_id: ids.posto1, tp_universal: false, tipo: 'ADMIN' });
  tk.admNorte = assinar({ email: 'norte@teste.com', posto_id: ids.posto2, tp_universal: false, tipo: 'ADMIN' });
  // admin com o MESMO id numérico do paciente A (cenário de confusão de perfis)
  tk.admMesmoId = assinar({ id: ids.pacA, posto_id: ids.posto1, tp_universal: true, tipo: 'ADMIN' });
  tk.aut = assinar({ id: aut.aut_id, tipo: 'AUTORIZADOR' });

  ({ default: app } = await import(pathToFileURL(path.join(BACKEND, 'src/server.js')).href));
});

after(async () => { await knex.destroy(); setTimeout(() => process.exit(0), 50); });

// ------------------------------------------------------------------
// Etapa A — Solicitação (paciente envia prescrição)
// ------------------------------------------------------------------
test('A1 paciente cria solicitação válida e ela é persistida como Pendente', async () => {
  const r = await request(app).post('/solicitacoes').set(auth(tk.pacA))
    .send({ pos_id: ids.posto1, sol_prescricao: png('receita-1'), sol_observacao: '  uso contínuo  ', sol_prescricao_tipo: 'image/png' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ids.sol1 = r.body.solicitacao.sol_id;
  const linha = await knex('solicitacao').where('sol_id', ids.sol1).first();
  assert.equal(linha.sol_status, 'Pendente');
  assert.equal(linha.pac_id, ids.pacA);
  assert.equal(linha.sol_observacao, 'uso contínuo');
});

test('A2 envio duplicado da mesma prescrição pendente é bloqueado (409)', async () => {
  const r = await request(app).post('/solicitacoes').set(auth(tk.pacA))
    .send({ pos_id: ids.posto1, sol_prescricao: png('receita-1'), sol_prescricao_tipo: 'image/png' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /já foi enviada/);
});

test('A3 dados obrigatórios ausentes ou inválidos são recusados com mensagem em português', async () => {
  const casos = [
    [{ sol_prescricao: png('x') }, /Posto de saúde não informado/],
    [{ pos_id: 'abc', sol_prescricao: png('x') }, /Posto de saúde inválido/],
    [{ pos_id: 9999, sol_prescricao: png('x') }, /Posto de saúde não encontrado/],
    [{ pos_id: ids.posto1 }, /Prescrição não fornecida/],
    [{ pos_id: ids.posto1, sol_prescricao: 'isto não é base64!!' }, /Arquivo da prescrição inválido/],
    [{ pos_id: ids.posto1, sol_prescricao: png('y'), sol_prescricao_tipo: 'text/html' }, /Formato não suportado/],
    [{ pos_id: ids.posto1, sol_prescricao: png('y'), sol_observacao: 'a'.repeat(1001) }, /no máximo 1000/],
  ];
  for (const [corpo, msg] of casos) {
    const r = await request(app).post('/solicitacoes').set(auth(tk.pacA)).send(corpo);
    assert.equal(r.status, 400, JSON.stringify(corpo).slice(0, 80));
    assert.match(r.body.error, msg);
  }
});

test('A4 arquivo acima de 5 MB é recusado', async () => {
  const grande = Buffer.alloc(5 * 1024 * 1024 + 10, 1).toString('base64');
  const r = await request(app).post('/solicitacoes').set(auth(tk.pacA))
    .send({ pos_id: ids.posto1, sol_prescricao: grande, sol_prescricao_tipo: 'image/png' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /5 MB/);
});

test('A5 permissões do envio: sem token 401, admin 403, PDF aceito', async () => {
  assert.equal((await request(app).post('/solicitacoes').send({})).status, 401);
  assert.equal((await request(app).post('/solicitacoes').set(auth(tk.adm)).send({ pos_id: ids.posto1, sol_prescricao: png('z') })).status, 403);
  const pdf = await request(app).post('/solicitacoes').set(auth(tk.pacB))
    .send({ pos_id: ids.posto2, sol_prescricao: Buffer.from('%PDF-1.4').toString('base64'), sol_prescricao_tipo: 'application/pdf' });
  assert.equal(pdf.status, 201);
  ids.solNorte = pdf.body.solicitacao.sol_id;
});

test('A6 paciente vê só as próprias prescrições; detalhe de outro paciente é 403', async () => {
  const lista = await request(app).get('/solicitacao/pacienteid').set(auth(tk.pacA));
  assert.equal(lista.status, 200);
  assert.ok(lista.body.length >= 1 && lista.body.every((s) => s.sol_id !== ids.solNorte));
  assert.equal((await request(app).get(`/solicitacao/${ids.solNorte}/detalhes`).set(auth(tk.pacA))).status, 403);
  assert.equal((await request(app).get(`/solicitacao/${ids.sol1}/detalhes`).set(auth(tk.pacA))).status, 200);
});

test('A7 token de ADMIN com o mesmo id do paciente não acessa dados do paciente', async () => {
  assert.equal((await request(app).get('/solicitacao/pacienteid').set(auth(tk.admMesmoId))).status, 403);
  assert.equal((await request(app).get(`/solicitacao/${ids.sol1}/detalhes`).set(auth(tk.admMesmoId))).status, 403);
  assert.equal((await request(app).put('/pacientes/perfil').set(auth(tk.admMesmoId)).send({ campo: 'nome', valor: 'Invasor Teste' })).status, 403);
});

// ------------------------------------------------------------------
// Etapa B — Revisão (admin) e autorização (autorizador)
// ------------------------------------------------------------------
test('B1 admin vê pendentes só do próprio posto', async () => {
  const r = await request(app).get('/pendentes').set(auth(tk.adm));
  assert.equal(r.status, 200);
  assert.ok(r.body.some((s) => s.sol_id === ids.sol1));
  assert.ok(!r.body.some((s) => s.sol_id === ids.solNorte));
});

test('B2 admin de outro posto não revisa a solicitação (403)', async () => {
  const r = await request(app).patch(`/solicitacao/${ids.sol1}`).set(auth(tk.admNorte))
    .send({ sol_status: 'Revisado', ins_id: ids.insumo, sol_insumo_quant: 2, sol_data_vencimento: amanha });
  assert.equal(r.status, 403);
});

test('B3 admin não pode gravar Autorizado/Aprovado (pular o autorizador)', async () => {
  for (const status of ['Autorizado', 'Aprovado', 'Nao Autorizado']) {
    const r = await request(app).patch(`/solicitacao/${ids.sol1}`).set(auth(tk.adm)).send({ sol_status: status });
    assert.equal(r.status, 400, status);
  }
  assert.equal((await knex('solicitacao').where('sol_id', ids.sol1).first()).sol_status, 'Pendente');
});

test('B4 validações da revisão: quantidade, insumo, vencimento', async () => {
  const base = { sol_status: 'Revisado', ins_id: ids.insumo, sol_insumo_quant: 2, sol_data_vencimento: amanha };
  const casos = [
    [{ ...base, sol_insumo_quant: 0 }, 400, /quantidade/i],
    [{ ...base, sol_insumo_quant: 1.5 }, 400, /quantidade/i],
    [{ ...base, ins_id: undefined }, 400, /pelo menos um insumo/],
    [{ ...base, ins_id: 999 }, 404, /Insumo não encontrado/],
    [{ ...base, sol_data_vencimento: undefined }, 400, /vencimento/],
    [{ ...base, sol_data_vencimento: '2026-02-30' }, 400, /vencimento inválida/],
    [{ ...base, sol_data_vencimento: ontem }, 400, /vencida/],
  ];
  for (const [corpo, status, msg] of casos) {
    const r = await request(app).patch(`/solicitacao/${ids.sol1}`).set(auth(tk.adm)).send(corpo);
    assert.equal(r.status, status, JSON.stringify(corpo));
    assert.match(r.body.error, msg);
  }
});

test('B5 admin revisa Pendente → Revisado e não revisa duas vezes', async () => {
  const corpo = { sol_status: 'Revisado', ins_id: ids.insumo, sol_insumo_quant: 2, sol_data_vencimento: amanha };
  const r = await request(app).patch(`/solicitacao/${ids.sol1}`).set(auth(tk.adm)).send(corpo);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const linha = await knex('solicitacao').where('sol_id', ids.sol1).first();
  assert.equal(linha.sol_status, 'Revisado');
  assert.equal(linha.sol_insumo_quant, 2);
  assert.equal((await request(app).patch(`/solicitacao/${ids.sol1}`).set(auth(tk.adm)).send(corpo)).status, 409);
  assert.equal((await request(app).patch(`/solicitacao/${ids.sol1}/reenvio`).set(auth(tk.adm)).send({ motivo: 'OUTRO' })).status, 409);
});

test('B6 pedido de reenvio: motivo obrigatório e válido', async () => {
  const [p] = await knex('solicitacao').insert({ pac_id: ids.pacA, pos_id: ids.posto1, sol_status: 'Pendente', sol_insumo_quant: 0 }).returning('sol_id');
  assert.equal((await request(app).patch(`/solicitacao/${p.sol_id}/reenvio`).set(auth(tk.adm)).send({})).status, 400);
  assert.equal((await request(app).patch(`/solicitacao/${p.sol_id}/reenvio`).set(auth(tk.adm)).send({ motivo: 'QUALQUER' })).status, 400);
  const ok = await request(app).patch(`/solicitacao/${p.sol_id}/reenvio`).set(auth(tk.adm)).send({ motivo: 'FOTO_SEM_QUALIDADE' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.solicitacao.sol_status, 'Reenvio');
});

test('B7 só o autorizador acessa a fila de análise', async () => {
  assert.equal((await request(app).get('/prescricao/aprovadas')).status, 401);
  assert.equal((await request(app).get('/prescricao/aprovadas').set(auth(tk.adm))).status, 403);
  assert.equal((await request(app).get('/prescricao/aprovadas').set(auth(tk.pacA))).status, 403);
  const r = await request(app).get('/prescricao/aprovadas').set(auth(tk.aut));
  assert.equal(r.status, 200);
  assert.ok(r.body.some((s) => s.sol_id === ids.sol1 && s.sol_status === 'Revisado'));
  const det = await request(app).get(`/autorizador/solicitacao/${ids.sol1}`).set(auth(tk.aut));
  assert.equal(det.status, 200);
});

test('B8 não autorização exige motivo (texto livre, até 500 caracteres)', async () => {
  for (const motivo of [undefined, '   ', 'x'.repeat(501)]) {
    const r = await request(app).patch(`/autorizador/solicitacao/${ids.sol1}`).set(auth(tk.aut)).send({ sol_status: 'Nao Autorizado', sol_motivo_nao_autorizado: motivo });
    assert.equal(r.status, 400);
  }
  assert.equal((await request(app).patch(`/autorizador/solicitacao/${ids.sol1}`).set(auth(tk.aut)).send({ sol_status: 'Aprovado' })).status, 400);
});

test('B9 autorizador autoriza e não pode decidir de novo', async () => {
  const r = await request(app).patch(`/autorizador/solicitacao/${ids.sol1}`).set(auth(tk.aut)).send({ sol_status: 'Autorizado' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.solicitacao.sol_status, 'Autorizado');
  const de_novo = await request(app).patch(`/autorizador/solicitacao/${ids.sol1}`).set(auth(tk.aut)).send({ sol_status: 'Nao Autorizado', sol_motivo_nao_autorizado: 'mudei de ideia' });
  assert.equal(de_novo.status, 400, 'mesmo código de antes da mudança');
  assert.match(de_novo.body.error, /já foi finalizada/);
  assert.equal((await knex('solicitacao').where('sol_id', ids.sol1).first()).sol_status, 'Autorizado');
});

// ------------------------------------------------------------------
// Etapa C — Agendamento
// ------------------------------------------------------------------
const novoAg = (extra = {}) => ({
  paciente: { pac_id: ids.pacA }, posto: { pos_id: ids.posto1 }, sol_data_de_coleta: amanha,
  itens: [{ ins_nome: 'Fralda G', quantidade: 2 }], sol_origem_id: ids.sol1,
  // o estoque de teste é pequeno de propósito (D1); o aviso de estoque
  // reservado tem os próprios testes (S1)
  confirmar_sem_estoque: true, ...extra,
});

test('C1 validações do agendamento', async () => {
  const casos = [
    [novoAg({ sol_data_de_coleta: ontem }), 400, /passado/],
    [novoAg({ sol_data_de_coleta: '2026-13-01' }), 400, /inválida/],
    [novoAg({ itens: [] }), 400, /Nenhum insumo/],
    [novoAg({ itens: [{ ins_nome: 'Fralda G', quantidade: 1.5 }] }), 400, /inteiro/],
    [novoAg({ itens: [{ ins_nome: '  ', quantidade: 1 }] }), 400, /nome e quantidade/],
    [novoAg({ paciente: { pac_id: 999 } }), 404, /Paciente não encontrado/],
    [novoAg({ posto: { pos_id: 999 } }), 404, /Posto/],
    [novoAg({ paciente: { pac_id: ids.pacB } }), 400, /não é o paciente desta prescrição/],
    [novoAg({ sol_origem_id: ids.solNorte }), 400, /autorizadas/],
  ];
  for (const [corpo, status, msg] of casos) {
    const r = await request(app).post('/agendamentos').set(auth(tk.adm)).send(corpo);
    assert.equal(r.status, status, JSON.stringify(r.body));
    assert.match(r.body.message, msg);
  }
  assert.equal((await knex('solicitacao').where('sol_status', 'agendado')).length, 0, 'nenhum agendamento criado por payload inválido');
});

test('C2 só admin cria agendamento', async () => {
  assert.equal((await request(app).post('/agendamentos').send(novoAg())).status, 401);
  assert.equal((await request(app).post('/agendamentos').set(auth(tk.aut)).send(novoAg())).status, 403);
  assert.equal((await request(app).post('/agendamentos').set(auth(tk.pacA)).send(novoAg())).status, 403);
});

test('C3 cria agendamento vinculado à prescrição autorizada, com protocolo e itens', async () => {
  const r = await request(app).post('/agendamentos').set(auth(tk.adm)).send(novoAg());
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ids.ag1 = r.body.sol_id;
  assert.equal(r.body.sol_protocolo, `AG${String(ids.ag1).padStart(6, '0')}`);
  const linha = await knex('solicitacao').where('sol_id', ids.ag1).first();
  assert.equal(linha.sol_origem_id, ids.sol1);
  assert.equal((await knex('coleta').where('sol_id', ids.ag1)).length, 1);
});

test('C4 a mesma prescrição não pode ter dois agendamentos ativos', async () => {
  const r = await request(app).post('/agendamentos').set(auth(tk.adm)).send(novoAg());
  assert.equal(r.status, 409);
  assert.match(r.body.message, /já possui um agendamento/);
});

test('C5 listagem do admin mostra o agendamento; filtros inválidos são recusados', async () => {
  const r = await request(app).get('/agendamentos').query({ status: 'agendado' }).set(auth(tk.adm));
  assert.equal(r.status, 200);
  const ag = r.body.find((a) => a.sol_id === ids.ag1);
  assert.ok(ag);
  assert.equal(ag.sol_origem_id, ids.sol1);
  assert.equal(ag.insumos[0].quantidade, 2);
  assert.equal((await request(app).get('/agendamentos').query({ status: 'xyz' }).set(auth(tk.adm))).status, 400);
  assert.equal((await request(app).get('/agendamentos').query({ data_inicio: '2026-01-31', data_fim: '2026-01-01' }).set(auth(tk.adm))).status, 400);
  const busca = await request(app).get('/agendamentos').query({ status: 'todos', busca: '529982' }).set(auth(tk.adm));
  assert.ok(busca.body.some((a) => a.sol_id === ids.ag1), 'busca por CPF sem pontuação');
});

test('C6 cancelamento exige motivo e grava motivo, data e responsável', async () => {
  for (const corpo of [{}, { motivo: '   ' }, { motivo: 'x'.repeat(501) }]) {
    const r = await request(app).patch(`/agendamentos/${ids.ag1}/cancelar`).set(auth(tk.adm)).send(corpo);
    assert.equal(r.status, 400);
  }
  assert.equal((await knex('solicitacao').where('sol_id', ids.ag1).first()).sol_status, 'agendado', 'falha de validação não altera nada');

  assert.equal((await request(app).patch(`/agendamentos/${ids.ag1}/cancelar`).set(auth(tk.pacA)).send({ motivo: 'teste' })).status, 403);

  const r = await request(app).patch(`/agendamentos/${ids.ag1}/cancelar`).set(auth(tk.adm)).send({ motivo: '  Paciente pediu para remarcar  ' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const linha = await knex('solicitacao').where('sol_id', ids.ag1).first();
  assert.equal(linha.sol_status, 'cancelado');
  assert.equal(linha.sol_motivo_cancelamento, 'Paciente pediu para remarcar');
  assert.ok(linha.sol_data_cancelamento);
  // a tabela administrador não tem id: quem cancelou fica assinado no histórico
  const his = await knex('historico_solicitacao').where({ sol_id: ids.ag1, his_acao: 'cancelada' }).first();
  assert.equal(his.his_usuario_nome, 'Admin Geral');
});

test('C7 cancelamento repetido e conclusão de cancelado são bloqueados', async () => {
  const r = await request(app).patch(`/agendamentos/${ids.ag1}/cancelar`).set(auth(tk.adm)).send({ motivo: 'de novo' });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /já foi cancelado/);
  const c = await request(app).patch(`/agendamentos/${ids.ag1}/concluir`).set(auth(tk.adm));
  assert.equal(c.status, 409);
  assert.equal((await knex('solicitacao').where('sol_id', ids.ag1).first()).sol_motivo_cancelamento, 'Paciente pediu para remarcar', 'motivo original preservado');
});

test('C8 motivo pode ser consultado depois pelo admin e pelo paciente', async () => {
  const adm = await request(app).get('/agendamentos').query({ status: 'cancelado' }).set(auth(tk.adm));
  assert.equal(adm.body.find((a) => a.sol_id === ids.ag1).sol_motivo_cancelamento, 'Paciente pediu para remarcar');
  const pac = await request(app).get('/meus-agendamentos').set(auth(tk.pacA));
  assert.equal(pac.status, 200);
  assert.equal(pac.body.itens.find((a) => a.sol_id === ids.ag1).sol_motivo_cancelamento, 'Paciente pediu para remarcar');
  const outro = await request(app).get('/meus-agendamentos').set(auth(tk.pacB));
  assert.ok(!outro.body.itens.some((a) => a.sol_id === ids.ag1), 'outro paciente não vê');
});

test('C9 após cancelar, a prescrição pode ser reagendada', async () => {
  const r = await request(app).post('/agendamentos').set(auth(tk.adm)).send(novoAg());
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ids.ag2 = r.body.sol_id;
});

// ------------------------------------------------------------------
// Etapa D — Coleta e conclusão
// ------------------------------------------------------------------
test('D1 estoque insuficiente: nada muda (transação desfeita)', async () => {
  const r = await request(app).patch(`/agendamentos/${ids.ag2}/concluir`).set(auth(tk.adm));
  assert.equal(r.status, 400);
  assert.match(r.body.message, /Estoque insuficiente/);
  assert.equal((await knex('insumo').where('ins_id', ids.insumo).first()).ins_quantidade, 1);
  assert.equal((await knex('solicitacao').where('sol_id', ids.ag2).first()).sol_status, 'agendado');
});

test('D2 conclusão válida desconta o estoque uma única vez', async () => {
  await request(app).patch(`/insumos/${ids.insumo}`).set(auth(tk.adm)).send({ tipo: 'entrada', quantidade: 9 }).expect(200);
  const r = await request(app).patch(`/agendamentos/${ids.ag2}/concluir`).set(auth(tk.adm));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await knex('insumo').where('ins_id', ids.insumo).first()).ins_quantidade, 8);
  const de_novo = await request(app).patch(`/agendamentos/${ids.ag2}/concluir`).set(auth(tk.adm));
  assert.equal(de_novo.status, 409);
  assert.equal((await knex('insumo').where('ins_id', ids.insumo).first()).ins_quantidade, 8, 'não descontou de novo');
  const cancelar = await request(app).patch(`/agendamentos/${ids.ag2}/cancelar`).set(auth(tk.adm)).send({ motivo: 'tarde demais' });
  assert.equal(cancelar.status, 409);
  assert.match(cancelar.body.message, /concluído/);
});

test('D3 conclusão só pelo admin; ids inexistentes e inválidos', async () => {
  assert.equal((await request(app).patch(`/agendamentos/${ids.ag2}/concluir`).set(auth(tk.aut))).status, 403);
  assert.equal((await request(app).patch('/agendamentos/99999/concluir').set(auth(tk.adm))).status, 404);
  assert.equal((await request(app).patch('/agendamentos/abc/concluir').set(auth(tk.adm))).status, 400);
  // prescrição (não agendamento) não pode ser "concluída" pela rota de agendamentos
  assert.equal((await request(app).patch(`/agendamentos/${ids.sol1}/concluir`).set(auth(tk.adm))).status, 404);
});

test('D4 nova prescrição concluída não pode ser agendada outra vez', async () => {
  const r = await request(app).post('/agendamentos').set(auth(tk.adm)).send(novoAg());
  assert.equal(r.status, 409);
});

// ------------------------------------------------------------------
// Etapa E — Segurança e integridade
// ------------------------------------------------------------------
test('E1 listas completas exigem admin e não expõem hash de senha', async () => {
  assert.equal((await request(app).get('/pacientesall')).status, 401);
  assert.equal((await request(app).get('/pacientesall').set(auth(tk.pacA))).status, 403);
  const p = await request(app).get('/pacientesall').set(auth(tk.adm));
  assert.equal(p.status, 200);
  assert.ok(p.body.length && p.body.every((x) => !('pac_senha' in x)));
  assert.equal((await request(app).get('/administradorall')).status, 401);
  const a = await request(app).get('/administradorall').set(auth(tk.adm));
  assert.ok(a.body.every((x) => !('adm_senha' in x)));
  const u = await request(app).get('/autorizadorall').set(auth(tk.aut));
  assert.ok(u.body.every((x) => !('aut_senha' in x)));
});

test('E2 token inválido, adulterado ou ausente', async () => {
  assert.equal((await request(app).get('/validar')).status, 401);
  assert.equal((await request(app).get('/validar').set({ Authorization: 'Bearer xyz' })).status, 401);
  const forjado = jwt.sign({ id: 1, tipo: 'ADMIN' }, 'outro-segredo');
  assert.equal((await request(app).get('/pendentes').set(auth(forjado))).status, 401);
  const none = Buffer.from('{"alg":"none"}').toString('base64url') + '.' + Buffer.from('{"id":1,"tipo":"ADMIN"}').toString('base64url') + '.';
  assert.equal((await request(app).get('/pendentes').set(auth(none))).status, 401);
});

test('E3 JSON malformado e id inválido respondem 400 em JSON, sem detalhes internos', async () => {
  const r = await request(app).post('/login').set('Content-Type', 'application/json').send('{"email":');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /formato inválido/);
  const id = await request(app).get('/solicitacao/abc').set(auth(tk.adm));
  assert.equal(id.status, 400);
  assert.match(id.body.error, /Identificador inválido/);
});

test('E4 perfil: paciente altera o próprio dado; resposta sem senha', async () => {
  const r = await request(app).put('/pacientes/perfil').set(auth(tk.pacA)).send({ campo: 'telefone', valor: '24981112222' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!('pac_senha' in r.body.usuario));
  assert.equal((await request(app).put('/pacientes/perfil').set(auth(tk.pacA)).send({ campo: 'pac_senha', valor: 'x' })).status, 400);
  assert.equal((await knex('pacientes').where('pac_id', ids.pacB).first()).pac_telefone, '(24) 97777-6666', 'outro paciente intacto');
});

// ------------------------------------------------------------------
// Etapa F — Regressão de fluxos que já funcionavam
// ------------------------------------------------------------------
test('F1 login dos três perfis e /validar', async () => {
  for (const [email, tipo] of [['ana@teste.com', 'PACIENTE'], ['adm@teste.com', 'ADMIN'], ['aut@teste.com', 'AUTORIZADOR']]) {
    const r = await request(app).post('/login').send({ email, senha: 'Senha@123' });
    assert.equal(r.status, 200, email);
    assert.equal(r.body.usuario.tipo, tipo);
    const v = await request(app).get('/validar').set(auth(r.body.token));
    assert.equal(v.body.session.tipo, tipo);
  }
  const errado = await request(app).post('/login').send({ email: 'ana@teste.com', senha: 'Errada@123' });
  assert.equal(errado.status, 401);
});

test('F2 postos, insumos e históricos continuam respondendo', async () => {
  const postos = await request(app).get('/postos');
  assert.equal(postos.status, 200);
  assert.equal(postos.body.length, 2);
  assert.equal((await request(app).get(`/postos/${ids.posto1}`)).body.pos_nome, 'Posto Centro');
  assert.equal((await request(app).get('/insumos/listar').set(auth(tk.adm))).status, 200);
  const busca = await request(app).get('/insumos').query({ busca: 'fral' }).set(auth(tk.adm));
  assert.equal(busca.status, 200, 'antes dava 500 (variável busca indefinida)');
  assert.equal(busca.body[0].ins_nome, 'Fralda G');
  assert.equal((await request(app).get('/prescricoes/historico').set(auth(tk.adm))).status, 200);
  assert.equal((await request(app).get(`/solicitacao/${ids.sol1}`).set(auth(tk.adm))).status, 200);
  assert.equal((await request(app).get('/pacientes').query({ cpf: '529' }).set(auth(tk.adm))).body[0].pac_nome, 'Ana Souza');
});

test('F3 cadastro público de paciente continua funcionando e validando', async () => {
  const ok = await request(app).post('/pacientes').send({
    nome: 'Dora Alves', email: 'dora@teste.com', telefone: '24991234567', cpf: '390.533.447-05',
    senha: 'Senha@123', confirmacao_senha: 'Senha@123', cep: '27000000', data_nascimento: '1990-01-01',
    endereco: 'Rua A, 10', sexo: 'F', raca: 'Parda',
  });
  assert.ok([201, 400].includes(ok.status), JSON.stringify(ok.body));
  const ruim = await request(app).post('/pacientes').send({ nome: 'D', email: 'x', cpf: '123' });
  assert.equal(ruim.status, 400);
});

test('F4 cadastro de autorizador e administrador só com convite válido', async () => {
  const dados = { nome: 'Eva Rocha', email: 'eva@teste.com', telefone: '24991234567', cpf: '390.533.447-05', senha: 'Senha@123', confirmacao_senha: 'Senha@123' };
  const semConvite = await request(app).post('/autorizador').send(dados);
  assert.equal(semConvite.status, 403);
  assert.match(semConvite.body.erros[0], /convite/);
  assert.equal(await knex('autorizador').where('aut_email', 'eva@teste.com').first(), undefined, 'nada criado');

  const inventado = await request(app).post('/autorizador').send({ ...dados, convite: 'codigo-inventado' });
  assert.equal(inventado.status, 403);

  // convite de administrador não serve para autorizador
  const deAdmin = await criarConvite('ADMIN', ids.posto1);
  assert.equal((await request(app).post('/autorizador').send({ ...dados, convite: deAdmin })).status, 403);

  const codigo = await criarConvite('AUTORIZADOR');
  const r = await request(app).post('/autorizador').send({ ...dados, convite: codigo });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const usado = await knex('convite_equipe').where('cnv_codigo_hash', hashTeste(codigo)).first();
  assert.ok(usado.cnv_usado_em, 'convite marcado como usado');
  assert.equal(usado.cnv_usado_email, 'eva@teste.com');

  // uso único
  const repetido = await request(app).post('/autorizador').send({ ...dados, email: 'eva2@teste.com', cpf: '300.264.746-20', convite: codigo });
  assert.equal(repetido.status, 403);
  assert.match(repetido.body.erros[0], /já foi usado/);
});

test('F5 agendamento sem vínculo (fluxo antigo, sem sol_origem_id) continua permitido', async () => {
  const r = await request(app).post('/agendamentos').set(auth(tk.adm)).send(novoAg({ sol_origem_id: undefined, paciente: { pac_id: ids.pacB } }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const prox = await request(app).get('/meus-agendamentos/proximo').set(auth(tk.pacB));
  assert.equal(prox.status, 200);
  assert.equal(prox.body.sol_id, r.body.sol_id);
});

test('F6 /pendentes indica se a prescrição autorizada já tem agendamento ativo', async () => {
  const r = await request(app).get('/pendentes').set(auth(tk.adm));
  assert.equal(r.status, 200);
  const autorizada = r.body.find((s) => s.sol_id === ids.sol1);
  assert.ok(autorizada, 'prescrição autorizada aparece na lista');
  assert.equal(autorizada.agendamento_ativo, true, 'sol1 tem agendamento concluído (ag2)');
});

test('F7 gênero e cor/raça são opcionais no cadastro do paciente', async () => {
  const base = {
    nome: 'Helena Costa', telefone: '24991234500', cpf: '935.411.347-80',
    senha: 'Senha@123', confirmacao_senha: 'Senha@123', cep: '27000000',
    data_nasc: '1990-05-10', endereco: 'Rua B, 20',
  };
  const semCampos = await request(app).post('/pacientes').send({ ...base, email: 'helena@teste.com' });
  assert.equal(semCampos.status, 201, JSON.stringify(semCampos.body));
  const salvo = await knex('pacientes').where('pac_email', 'helena@teste.com').first();
  assert.equal(salvo.pac_sexo, 'N');
  assert.equal(salvo.pac_raca, 'Não informado');

  const generoInvalido = await request(app).post('/pacientes').send({ ...base, email: 'h2@teste.com', cpf: '864.464.227-84', sexo: 'xyz' });
  assert.equal(generoInvalido.status, 400);
  assert.ok(generoInvalido.body.erros.includes('Selecione um gênero válido.'));

  const preenchido = await request(app).post('/pacientes').send({ ...base, email: 'h3@teste.com', cpf: '864.464.227-84', sexo: 'Feminino', raca: 'Parda' });
  assert.equal(preenchido.status, 201, JSON.stringify(preenchido.body));
  const salvo3 = await knex('pacientes').where('pac_email', 'h3@teste.com').first();
  assert.equal(salvo3.pac_sexo, 'F');
  assert.equal(salvo3.pac_raca, 'Parda');
});

// ------------------------------------------------------------------
// Fase 2 — perfil, painel do admin, datas sugeridas, ficha do paciente
// ------------------------------------------------------------------
test('G1 perfil do admin traz o posto; do autorizador não; paciente não acessa', async () => {
  const adm = await request(app).get('/perfil').set(auth(tk.adm));
  assert.equal(adm.status, 200);
  assert.equal(adm.body.tipo, 'ADMIN');
  assert.equal(adm.body.posto.pos_nome, 'Posto Centro');
  assert.ok(!('adm_senha' in adm.body) && !('senha' in adm.body));
  const aut = await request(app).get('/perfil').set(auth(tk.aut));
  assert.equal(aut.body.tipo, 'AUTORIZADOR');
  assert.equal(aut.body.posto, undefined);
  assert.equal((await request(app).get('/perfil').set(auth(tk.pacA))).status, 403);
  assert.equal((await request(app).get('/perfil')).status, 401);
});

test('G2 editar o próprio perfil valida e não aceita e-mail de outro usuário', async () => {
  const ruim = await request(app).put('/perfil').set(auth(tk.adm)).send({ nome: 'A', email: 'x', telefone: '1' });
  assert.equal(ruim.status, 400);
  assert.equal(ruim.body.erros.length, 3);
  const dup = await request(app).put('/perfil').set(auth(tk.adm)).send({ nome: 'Admin Geral', email: 'norte@teste.com', telefone: '24999990000' });
  assert.equal(dup.status, 409);
  const ok = await request(app).put('/perfil').set(auth(tk.adm)).send({ nome: 'Admin  Geral', email: 'ADM@teste.com', telefone: '24999990000' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.perfil.telefone, '(24) 99999-0000');
  assert.equal(ok.body.perfil.email, 'adm@teste.com');
  assert.equal(ok.body.perfil.nome, 'Admin Geral');
});

test('G3 painel do admin conta a fila de trabalho do posto', async () => {
  const r = await request(app).get('/painel/admin').set(auth(tk.adm));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  for (const k of ['pendentes', 'autorizadasSemAgendamento', 'coletasHoje', 'estoqueBaixo']) {
    assert.equal(typeof r.body[k], 'number', k);
  }
  const antes = r.body.autorizadasSemAgendamento;
  // uma prescrição autorizada sem agendamento conta; com agendamento ativo, não
  const [nova] = await knex('solicitacao').insert({ pac_id: ids.pacA, pos_id: ids.posto1, sol_status: 'Autorizado', sol_insumo_quant: 1 }).returning('sol_id');
  assert.equal((await request(app).get('/painel/admin').set(auth(tk.adm))).body.autorizadasSemAgendamento, antes + 1);
  await request(app).post('/agendamentos').set(auth(tk.adm)).send({ ...novoAg(), sol_origem_id: nova.sol_id }).expect(201);
  assert.equal((await request(app).get('/painel/admin').set(auth(tk.adm))).body.autorizadasSemAgendamento, antes);
  // admin de outro posto não vê a fila deste
  const norte = await request(app).get('/painel/admin').set(auth(tk.admNorte));
  assert.equal(norte.body.autorizadasSemAgendamento, 0);
  assert.equal((await request(app).get('/painel/admin').set(auth(tk.aut))).status, 403);
});

test('G4 datas sugeridas: unidade sem horário usa segunda a sexta; futuras e as com menos coletas', async () => {
  assert.equal((await request(app).get('/agendamentos/datas-sugeridas').set(auth(tk.adm))).status, 400);
  const [p3] = await knex('postosdesaude').insert({ pos_nome: 'Posto Sul (sem horário)' }).returning('pos_id');
  const r = await request(app).get('/agendamentos/datas-sugeridas').query({ pos_id: p3.pos_id }).set(auth(tk.adm));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.datas.length, 14);
  for (const d of r.body.datas) {
    assert.ok(d.data > hoje, 'só datas futuras');
    const dia = new Date(d.data + 'T12:00:00Z').getUTCDay();
    assert.ok(dia !== 0 && dia !== 6, 'sem fim de semana');
  }
  assert.equal(r.body.sugeridas.length, 3);
  assert.ok(r.body.opcoes.every((o) => ['manha', 'tarde'].includes(o.turno) && o.livres === null));

  const p1 = await request(app).get('/agendamentos/datas-sugeridas').query({ pos_id: ids.posto1 }).set(auth(tk.adm));
  const cheio = p1.body.datas.find((d) => d.agendados > 0);
  if (cheio) assert.ok(!p1.body.sugeridas.includes(cheio.data), 'dia com coleta não é sugerido antes de dias vazios');
});

test('G5 ficha do paciente para o admin; busca por nome', async () => {
  const r = await request(app).get(`/pacientes/${ids.pacA}/resumo`).set(auth(tk.adm));
  assert.equal(r.status, 200);
  assert.equal(r.body.paciente.pac_nome, 'Ana Souza');
  assert.ok(!('pac_senha' in r.body.paciente));
  assert.ok(r.body.prescricoes.length >= 1 && r.body.prescricoes.every((p) => !['agendado', 'concluido', 'cancelado'].includes(p.sol_status)));
  assert.ok(r.body.agendamentos.length >= 1 && r.body.agendamentos.every((a) => Array.isArray(a.insumos)));
  assert.ok(r.body.agendamentos.some((a) => a.sol_motivo_cancelamento === 'Paciente pediu para remarcar'));
  assert.equal((await request(app).get(`/pacientes/${ids.pacA}/resumo`).set(auth(tk.pacA))).status, 403);
  assert.equal((await request(app).get('/pacientes/99999/resumo').set(auth(tk.adm))).status, 404);
  const porNome = await request(app).get('/pacientes').query({ busca: 'bruno' }).set(auth(tk.adm));
  assert.equal(porNome.body[0].pac_nome, 'Bruno Lima');
  assert.deepEqual((await request(app).get('/pacientes').query({ busca: '' }).set(auth(tk.adm))).body, []);
});

// ------------------------------------------------------------------
// Fase 3 — histórico (assinatura), transferência, recado, WhatsApp do posto
// ------------------------------------------------------------------
test('H1 histórico registra quem fez cada etapa, com nome (visão da equipe)', async () => {
  const r = await request(app).get(`/solicitacao/${ids.sol1}/historico`).set(auth(tk.adm));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const acoes = r.body.map((e) => e.acao);
  for (const a of ['enviada', 'revisada', 'autorizada', 'agendada', 'cancelada', 'concluida']) {
    assert.ok(acoes.includes(a), `faltou "${a}" em ${acoes.join(',')}`);
  }
  const enviada = r.body.find((e) => e.acao === 'enviada');
  assert.equal(enviada.usuario_tipo, 'PACIENTE');
  assert.equal(enviada.usuario_nome, 'Ana Souza');
  const autorizada = r.body.find((e) => e.acao === 'autorizada');
  assert.equal(autorizada.usuario_tipo, 'AUTORIZADOR');
  assert.equal(autorizada.usuario_nome, 'Carla Dias');
  const revisada = r.body.find((e) => e.acao === 'revisada');
  assert.equal(revisada.usuario_tipo, 'ADMIN');
  assert.match(revisada.detalhe, /2x Fralda G/);
  const cancelada = r.body.find((e) => e.acao === 'cancelada');
  assert.match(cancelada.detalhe, /Paciente pediu para remarcar/);
});

test('H2 paciente vê o histórico só dos próprios itens, sem o nome da equipe', async () => {
  const r = await request(app).get(`/solicitacao/${ids.sol1}/historico`).set(auth(tk.pacA));
  assert.equal(r.status, 200);
  assert.ok(r.body.filter((e) => e.usuario_tipo !== 'PACIENTE').every((e) => e.usuario_nome === null));
  assert.ok(r.body.some((e) => e.usuario_tipo === 'PACIENTE' && e.usuario_nome === 'Ana Souza'));
  assert.equal((await request(app).get(`/solicitacao/${ids.sol1}/historico`).set(auth(tk.pacB))).status, 403);
  assert.equal((await request(app).get(`/solicitacao/${ids.sol1}/historico`)).status, 401);
  assert.equal((await request(app).get(`/solicitacao/${ids.sol1}/historico`).set(auth(tk.admNorte))).status, 403);
});

test('H3 transferência entre unidades foi removida: rota responde 410 e nada muda', async () => {
  const [p] = await knex('solicitacao').insert({ pac_id: ids.pacA, pos_id: ids.posto1, sol_status: 'Pendente', sol_insumo_quant: 0 }).returning('sol_id');
  const r = await request(app).patch(`/solicitacao/${p.sol_id}/transferir`).set(auth(tk.adm)).send({ pos_id: ids.posto2, motivo: 'x' });
  assert.equal(r.status, 410);
  assert.equal((await knex('solicitacao').where('sol_id', p.sol_id).first()).pos_id, ids.posto1);
  assert.equal((await request(app).patch(`/solicitacao/${p.sol_id}/transferir`).send({})).status, 401);
  await knex('solicitacao').where('sol_id', p.sol_id).del();
});

test('H4 recado no agendamento: salva, aparece para o paciente, só em agendado', async () => {
  const novo = await request(app).post('/agendamentos').set(auth(tk.adm)).send(novoAg({ sol_origem_id: undefined }));
  const id = novo.body.sol_id;
  assert.equal((await request(app).patch(`/agendamentos/${id}/recado`).set(auth(tk.adm)).send({ recado: 'x'.repeat(301) })).status, 400);
  assert.equal((await request(app).patch(`/agendamentos/${id}/recado`).set(auth(tk.pacA)).send({ recado: 'oi' })).status, 403);
  const ok = await request(app).patch(`/agendamentos/${id}/recado`).set(auth(tk.adm)).send({ recado: '  Traga documento com foto  ' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const meus = await request(app).get('/meus-agendamentos').query({ porPagina: 50 }).set(auth(tk.pacA));
  assert.equal(meus.body.itens.find((a) => a.sol_id === id).sol_recado, 'Traga documento com foto');
  const hist = (await request(app).get(`/solicitacao/${id}/historico`).set(auth(tk.adm))).body;
  assert.ok(hist.some((e) => e.acao === 'recado' && e.detalhe === 'Traga documento com foto'));
  // apagar
  assert.equal((await request(app).patch(`/agendamentos/${id}/recado`).set(auth(tk.adm)).send({ recado: '' })).body.sol_recado, null);
  // concluído não aceita recado
  assert.equal((await request(app).patch(`/agendamentos/${ids.ag2}/recado`).set(auth(tk.adm)).send({ recado: 'oi' })).status, 409);
});

test('H5 agendamento traz endereço e WhatsApp do posto (quando cadastrado)', async () => {
  await knex('postosdesaude').where('pos_id', ids.posto1).update({ pos_whatsapp: '5524999990000', pos_endereco: 'Rua Central, 100' });
  const meus = await request(app).get('/meus-agendamentos').query({ porPagina: 50 }).set(auth(tk.pacA));
  const ag = meus.body.itens.find((a) => a.posto.pos_id === ids.posto1);
  assert.equal(ag.posto.pos_whatsapp, '5524999990000');
  assert.equal(ag.posto.pos_endereco, 'Rua Central, 100');
});

// ------------------------------------------------------------------
// Fase 4 — páginas do paciente (rastreio e meus agendamentos)
// ------------------------------------------------------------------
test('I1 minhas prescrições: agendamento vinculado e linha do tempo, sem nomes da equipe', async () => {
  const r = await request(app).get('/minhas-prescricoes').set(auth(tk.pacA));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.every((p) => !['agendado', 'concluido', 'cancelado'].includes(p.sol_status)), 'só prescrições');
  const p1 = r.body.find((p) => p.sol_id === ids.sol1);
  assert.ok(p1, 'prescrição sol1 presente');
  assert.ok(p1.agendamento, 'tem agendamento vinculado');
  assert.ok(['agendado', 'concluido', 'cancelado'].includes(p1.agendamento.sol_status));
  const acoes = p1.eventos.map((e) => e.acao);
  for (const a of ['enviada', 'revisada', 'autorizada', 'agendada']) assert.ok(acoes.includes(a), a);
  assert.ok(p1.eventos.filter((e) => e.usuario_tipo !== 'PACIENTE').every((e) => e.usuario_nome === null));
  assert.ok(!('sol_prescricao' in p1), 'não devolve o arquivo na lista');
  // outro paciente não vê
  const b = await request(app).get('/minhas-prescricoes').set(auth(tk.pacB));
  assert.ok(!b.body.some((p) => p.sol_id === ids.sol1));
  assert.equal((await request(app).get('/minhas-prescricoes').set(auth(tk.adm))).status, 403);
});

test('I2 meus agendamentos: próximos (agendado, data crescente) e anteriores', async () => {
  const prox = await request(app).get('/meus-agendamentos').query({ situacao: 'proximos', porPagina: 50 }).set(auth(tk.pacA));
  assert.equal(prox.status, 200);
  assert.ok(prox.body.itens.length >= 1 && prox.body.itens.every((a) => a.status === 'agendado'));
  const datas = prox.body.itens.map((a) => String(a.sol_data_de_coleta).slice(0, 10));
  assert.deepEqual(datas, [...datas].sort(), 'do mais próximo para o mais distante');
  assert.equal(typeof prox.body.total, 'number');
  const ant = await request(app).get('/meus-agendamentos').query({ situacao: 'anteriores', porPagina: 50 }).set(auth(tk.pacA));
  assert.ok(ant.body.itens.length >= 1 && ant.body.itens.every((a) => ['concluido', 'cancelado'].includes(a.status)));
  assert.equal((await request(app).get('/meus-agendamentos').query({ situacao: 'xyz' }).set(auth(tk.pacA))).status, 400);
});

// ------------------------------------------------------------------
// Fase 5 — atividades da unidade
// ------------------------------------------------------------------
test('J1 atividades da unidade: lista, filtros e escopo do posto', async () => {
  const r = await request(app).get('/atividades').set(auth(tk.adm));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.total > 0 && r.body.itens.length > 0);
  const datas = r.body.itens.map((i) => new Date(i.quando).getTime());
  assert.deepEqual(datas, [...datas].sort((a, b) => b - a), 'mais recente primeiro');
  assert.ok(r.body.itens.every((i) => i.acao && 'usuario_nome' in i && 'pac_nome' in i));

  const so = await request(app).get('/atividades').query({ acao: 'autorizada' }).set(auth(tk.adm));
  assert.ok(so.body.itens.length > 0 && so.body.itens.every((i) => i.acao === 'autorizada'));
  const quem = await request(app).get('/atividades').query({ usuario: 'carla' }).set(auth(tk.adm));
  assert.ok(quem.body.itens.length > 0 && quem.body.itens.every((i) => /carla/i.test(i.usuario_nome)));
  const paciente = await request(app).get('/atividades').query({ busca: 'Bruno' }).set(auth(tk.adm));
  assert.ok(paciente.body.itens.every((i) => i.pac_nome === 'Bruno Lima'));
  const futuro = await request(app).get('/atividades').query({ data_inicio: '2099-01-01' }).set(auth(tk.adm));
  assert.equal(futuro.body.total, 0);

  assert.equal((await request(app).get('/atividades').query({ acao: 'xyz' }).set(auth(tk.adm))).status, 400);
  assert.equal((await request(app).get('/atividades').query({ data_inicio: '2026-02-30' }).set(auth(tk.adm))).status, 400);
  assert.equal((await request(app).get('/atividades').set(auth(tk.aut))).status, 403);
  assert.equal((await request(app).get('/atividades').set(auth(tk.pacA))).status, 403);

  // admin do posto Norte só vê o que é do posto Norte
  const norte = await request(app).get('/atividades').query({ porPagina: 100 }).set(auth(tk.admNorte));
  assert.ok(norte.body.itens.every((i) => i.pos_nome === 'Posto Norte'));
});

test('K1 agendamentos: admin de posto vê e age só no próprio posto; universal vê todos', async () => {
  const norte = await request(app).get('/agendamentos').query({ status: 'todos' }).set(auth(tk.admNorte));
  assert.equal(norte.status, 200);
  assert.ok(norte.body.every((a) => a.posto.pos_id === ids.posto2), 'Norte não vê agendamentos do Centro');
  const centro = await request(app).get('/agendamentos').query({ status: 'todos' }).set(auth(tk.adm));
  assert.ok(centro.body.length > 0 && centro.body.every((a) => a.posto.pos_id === ids.posto1));
  const universal = await request(app).get('/agendamentos').query({ status: 'todos' }).set(auth(tk.admMesmoId));
  assert.ok(universal.body.length >= centro.body.length, 'universal vê todos');

  const novo = await request(app).post('/agendamentos').set(auth(tk.adm)).send(novoAg({ sol_origem_id: undefined }));
  const id = novo.body.sol_id;
  assert.equal((await request(app).patch(`/agendamentos/${id}/cancelar`).set(auth(tk.admNorte)).send({ motivo: 'x' })).status, 403);
  assert.equal((await request(app).patch(`/agendamentos/${id}/recado`).set(auth(tk.admNorte)).send({ recado: 'x' })).status, 403);
  assert.equal((await request(app).patch(`/agendamentos/${id}/concluir`).set(auth(tk.admNorte))).status, 403);
  assert.equal((await knex('solicitacao').where('sol_id', id).first()).sol_status, 'agendado');
});

test('K2 admin troca o e-mail no perfil e recebe token novo que continua valendo', async () => {
  const r = await request(app).put('/perfil').set(auth(tk.adm)).send({ nome: 'Admin Geral', email: 'adm.novo@teste.com', telefone: '24999990000' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.token, 'deve devolver token novo');
  assert.equal(r.body.perfil.email, 'adm.novo@teste.com');
  assert.equal((await request(app).get('/perfil').set(auth(r.body.token))).body.email, 'adm.novo@teste.com');
  // volta ao e-mail original para não afetar outros testes
  const volta = await request(app).put('/perfil').set(auth(r.body.token)).send({ nome: 'Admin Geral', email: 'adm@teste.com', telefone: '24999990000' });
  assert.equal(volta.status, 200);
});

// ------------------------------------------------------------------
// Rodada de 15/10 — cadastro, reenvio, remarcação, paginação e painéis
// ------------------------------------------------------------------
const basePaciente = {
  nome: 'Lia Martins', telefone: '24991234567', data_nasc: '1990-01-01', endereco: 'Rua das Flores, 20',
  cep: '27200000', senha: 'Senha@123', confirmacao_senha: 'Senha@123',
};

test('L1 cadastro do paciente aceita "Outro", "Prefiro não responder" e campos vazios', async () => {
  const outro = await request(app).post('/pacientes').send({ ...basePaciente, email: 'lia1@teste.com', cpf: '750.064.938-01', sexo: 'Outro', raca: 'Prefiro não responder' });
  assert.equal(outro.status, 201, JSON.stringify(outro.body));
  const l1 = await knex('pacientes').where('pac_email', 'lia1@teste.com').first();
  assert.equal(l1.pac_sexo, 'O');
  assert.equal(l1.pac_raca, 'Prefiro não responder');

  const prefiro = await request(app).post('/pacientes').send({ ...basePaciente, email: 'lia2@teste.com', cpf: '433.011.658-85', sexo: 'Prefiro não responder', raca: '' });
  assert.equal(prefiro.status, 201, JSON.stringify(prefiro.body));
  const l2 = await knex('pacientes').where('pac_email', 'lia2@teste.com').first();
  assert.equal(l2.pac_sexo, 'N');
  assert.equal(l2.pac_raca, 'Não informado');

  const semCampos = await request(app).post('/pacientes').send({ ...basePaciente, email: 'lia3@teste.com', cpf: '503.090.921-40' });
  assert.equal(semCampos.status, 201, JSON.stringify(semCampos.body));

  const racaRuim = await request(app).post('/pacientes').send({ ...basePaciente, email: 'lia4@teste.com', cpf: '698.293.746-10', raca: 'xyz' });
  assert.equal(racaRuim.status, 400);
  assert.ok(racaRuim.body.erros.includes('Selecione uma cor/raça válida.'));

  // e-mail já usado por um administrador não pode virar paciente (o login não acharia)
  const emailAdm = await request(app).post('/pacientes').send({ ...basePaciente, email: 'ADM@teste.com', cpf: '698.293.746-10' });
  assert.equal(emailAdm.status, 409);
});

test('L2 cadastro de administrador: matrícula validada, normalizada e única; sem universal pelo formulário', async () => {
  const base = { nome: 'Rui Prado', telefone: '24991234567', senha: 'Senha@123', confirmacao_senha: 'Senha@123', posto_id: ids.posto1 };
  const invalidas = ['', 'ab', 'A#1', 'ABCD', '12', 'x1'.repeat(11)];
  for (const matricula of invalidas) {
    const r = await request(app).post('/administrador').send({ ...base, matricula, email: 'rui@teste.com', cpf: '879.376.059-01', convite: await criarConvite('ADMIN', ids.posto1) });
    assert.equal(r.status, 400, `matrícula ${JSON.stringify(matricula)}`);
  }

  const ok = await request(app).post('/administrador').send({ ...base, matricula: ' sms-1234 ', email: 'rui@teste.com', cpf: '879.376.059-01', tp_universal: true, convite: await criarConvite('ADMIN', ids.posto1) });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const rui = await knex('administrador').where('adm_email', 'rui@teste.com').first();
  assert.equal(rui.adm_matricula, 'SMS-1234');
  assert.equal(rui.tp_universal, false, 'universal nunca vem do formulário');

  // mesma matrícula escrita de outro jeito (minúsculas, espaço, sem separador)
  for (const matricula of ['sms1234', 'SMS 1234', 'sms/1234']) {
    const dup = await request(app).post('/administrador').send({ ...base, matricula, email: 'rui2@teste.com', cpf: '300.264.746-20', convite: await criarConvite('ADMIN', ids.posto1) });
    assert.equal(dup.status, 409, matricula);
    assert.ok(dup.body.erros.includes('Matrícula já cadastrada.'));
  }

  // a unidade vem do convite; no cadastro direto (admin universal) ela é validada
  const postoRuim = await request(app).post('/equipe').set(auth(tk.admMesmoId)).send({ ...base, perfil: 'ADMIN', posto_id: 9999, matricula: 'B-77', email: 'rui3@teste.com', cpf: '300.264.746-20' });
  assert.equal(postoRuim.status, 400);
  const postoTexto = await request(app).post('/equipe').set(auth(tk.admMesmoId)).send({ ...base, perfil: 'ADMIN', posto_id: 'abc', matricula: 'B-77', email: 'rui3@teste.com', cpf: '300.264.746-20' });
  assert.equal(postoTexto.status, 400);
  // convite da unidade 1: o posto_id do formulário é ignorado
  assert.equal(rui.pos_id, ids.posto1);

  const emailPaciente = await request(app).post('/administrador').send({ ...base, matricula: 'B-78', email: 'ana@teste.com', cpf: '300.264.746-20', convite: await criarConvite('ADMIN', ids.posto1) });
  assert.equal(emailPaciente.status, 409);
  assert.ok(emailPaciente.body.erros.includes('E-mail já cadastrado.'));

  const autEmailUsado = await request(app).post('/autorizador').send({ nome: 'Ivo Reis', email: 'rui@teste.com', telefone: '24991234567', cpf: '300.264.746-20', senha: 'Senha@123', confirmacao_senha: 'Senha@123', convite: await criarConvite('AUTORIZADOR') });
  assert.equal(autEmailUsado.status, 409);
});

const lerBinario = (res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); };

test('L3 reenvio: o paciente corrige na MESMA solicitação, a versão anterior fica guardada e tudo vai para o histórico', async () => {
  const env = await request(app).post('/solicitacoes').set(auth(tk.pacA))
    .send({ pos_id: ids.posto1, sol_prescricao: png('versao-1'), sol_prescricao_tipo: 'image/png' });
  assert.equal(env.status, 201);
  const id = env.body.solicitacao.sol_id;
  const totalAntes = Number((await knex('solicitacao').count({ n: '*' }).first()).n);
  const corrigir = (token, corpo) => request(app).patch(`/solicitacao/${id}/corrigir`).set(auth(token)).send(corpo);

  // ainda não há pedido de reenvio
  assert.equal((await corrigir(tk.pacA, { sol_prescricao: png('v2'), sol_prescricao_tipo: 'image/png' })).status, 409);

  assert.equal((await request(app).patch(`/solicitacao/${id}/reenvio`).set(auth(tk.adm)).send({ motivo: 'FOTO_SEM_QUALIDADE' })).status, 200);
  assert.equal((await knex('solicitacao').where('sol_id', id).first()).sol_status, 'Reenvio');

  // outro paciente, admin e arquivo inválido não passam
  assert.equal((await corrigir(tk.pacB, { sol_prescricao: png('v2'), sol_prescricao_tipo: 'image/png' })).status, 403);
  assert.equal((await corrigir(tk.adm, { sol_prescricao: png('v2') })).status, 403);
  assert.equal((await corrigir(tk.pacA, { sol_prescricao: 'não é base64!' })).status, 400);

  const ok = await corrigir(tk.pacA, { sol_prescricao: png('versao-2'), sol_prescricao_tipo: 'image/png', sol_observacao: '  Foto nova, bem iluminada  ' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.sol_id, id);
  assert.equal(ok.body.versao, 2);

  const linha = await knex('solicitacao').where('sol_id', id).first();
  assert.equal(linha.sol_status, 'Pendente', 'voltou para análise');
  assert.equal(Buffer.from(linha.sol_prescricao).toString('base64'), png('versao-2'));
  assert.equal(Number((await knex('solicitacao').count({ n: '*' }).first()).n), totalAntes, 'nenhuma solicitação nova');

  const v = await knex('prescricao_versao').where('sol_id', id);
  assert.equal(v.length, 1);
  assert.equal(v[0].ver_numero, 1);
  assert.equal(v[0].ver_motivo_reenvio, 'FOTO_SEM_QUALIDADE');
  assert.equal(Buffer.from(v[0].ver_prescricao).toString('base64'), png('versao-1'));

  // corrigir de novo sem novo pedido: recusado
  assert.equal((await corrigir(tk.pacA, { sol_prescricao: png('v3'), sol_prescricao_tipo: 'image/png' })).status, 409);

  const hist = (await request(app).get(`/solicitacao/${id}/historico`).set(auth(tk.adm))).body.map((e) => e.acao);
  assert.deepEqual(hist, ['enviada', 'reenvio_solicitado', 'reenviada']);
  const reenviada = (await request(app).get(`/solicitacao/${id}/historico`).set(auth(tk.pacA))).body.find((e) => e.acao === 'reenviada');
  assert.match(reenviada.detalhe, /Resposta do paciente: Foto nova, bem iluminada/);

  // versões: paciente dono, admin do posto e autorizador veem; outros não
  const lista = await request(app).get(`/solicitacao/${id}/versoes`).set(auth(tk.pacA));
  assert.equal(lista.status, 200);
  assert.equal(lista.body[0].ver_motivo_reenvio_texto, 'Foto sem qualidade');
  assert.ok(!('ver_prescricao' in lista.body[0]), 'lista não traz o arquivo');
  assert.equal((await request(app).get(`/solicitacao/${id}/versoes`).set(auth(tk.adm))).status, 200);
  assert.equal((await request(app).get(`/solicitacao/${id}/versoes`).set(auth(tk.aut))).status, 200);
  assert.equal((await request(app).get(`/solicitacao/${id}/versoes`).set(auth(tk.pacB))).status, 403);
  assert.equal((await request(app).get(`/solicitacao/${id}/versoes`).set(auth(tk.admNorte))).status, 403);
  const arq = await request(app).get(`/solicitacao/${id}/versoes/1/arquivo`).set(auth(tk.pacA)).buffer(true).parse(lerBinario);
  assert.equal(arq.status, 200);
  assert.equal(arq.body.toString('base64'), png('versao-1'));
  assert.equal((await request(app).get(`/solicitacao/${id}/versoes/2/arquivo`).set(auth(tk.pacA))).status, 404);

  // a unidade vê que é uma correção e pode revisar de novo
  const pend = (await request(app).get('/pendentes').set(auth(tk.adm))).body.find((p) => p.sol_id === id);
  assert.equal(pend.versoes_anteriores, 1);
  const painel = (await request(app).get('/painel/admin').set(auth(tk.adm))).body;
  assert.ok(painel.corrigidasParaRevisar >= 1);
  const rev = await request(app).patch(`/solicitacao/${id}`).set(auth(tk.adm))
    .send({ sol_status: 'Revisado', ins_id: ids.insumo, sol_insumo_quant: 1, sol_data_vencimento: amanha });
  assert.equal(rev.status, 200, JSON.stringify(rev.body));
  ids.solCorrigida = id;
});

test('L4 cancelamento e remarcação aparecem como eventos distintos na mesma prescrição, sem duplicar', async () => {
  const [p] = await knex('solicitacao').insert({ pac_id: ids.pacB, pos_id: ids.posto1, sol_status: 'Autorizado', sol_insumo_quant: 1 }).returning('sol_id');
  const ag = () => request(app).post('/agendamentos').set(auth(tk.adm))
    .send(novoAg({ paciente: { pac_id: ids.pacB }, sol_origem_id: p.sol_id }));

  const a1 = await ag();
  assert.equal(a1.status, 201, JSON.stringify(a1.body));
  assert.equal((await request(app).patch(`/agendamentos/${a1.body.sol_id}/cancelar`).set(auth(tk.adm)).send({ motivo: 'Unidade fechada no dia' })).status, 200);
  const a2 = await ag();
  assert.equal(a2.status, 201, JSON.stringify(a2.body));

  const r = await request(app).get('/minhas-prescricoes').set(auth(tk.pacB));
  const item = r.body.find((x) => x.sol_id === p.sol_id);
  assert.equal(item.agendamento.sol_id, a2.body.sol_id, 'status atual = novo agendamento');
  assert.equal(item.agendamento.sol_status, 'agendado');
  assert.equal(item.agendamentos_cancelados.length, 1);
  assert.equal(item.agendamentos_cancelados[0].sol_motivo_cancelamento, 'Unidade fechada no dia');
  const acoes = item.eventos.map((e) => e.acao);
  assert.deepEqual(acoes, ['agendada', 'cancelada', 'reagendada'], 'cada evento uma vez, em ordem');
  assert.match(item.eventos[2].detalhe, /substitui o agendamento cancelado AG/);
});

test('L5 contato com a unidade: prescrição traz o WhatsApp do posto certo', async () => {
  await knex('postosdesaude').where('pos_id', ids.posto2).update({ pos_whatsapp: '5524988887777' });
  const [p] = await knex('solicitacao').insert({ pac_id: ids.pacB, pos_id: ids.posto2, sol_status: 'Nao Autorizado', sol_motivo_nao_autorizado: 'Fora do protocolo', sol_insumo_quant: 1 }).returning('sol_id');
  const r = await request(app).get('/minhas-prescricoes').set(auth(tk.pacB));
  const item = r.body.find((x) => x.sol_id === p.sol_id);
  assert.equal(item.pos_whatsapp, '5524988887777');
  assert.equal(item.pos_id, ids.posto2);
});

test('L6 listas longas paginadas no banco, com filtros e sem vazar dados de outro paciente/posto', async () => {
  const ag = await request(app).get('/agendamentos').query({ page: 1, porPagina: 1, status: 'todos' }).set(auth(tk.adm));
  assert.equal(ag.status, 200);
  assert.equal(ag.body.itens.length, 1);
  assert.ok(ag.body.total > 1 && ag.body.totalPaginas === ag.body.total);
  const ag2 = await request(app).get('/agendamentos').query({ page: 2, porPagina: 1, status: 'todos' }).set(auth(tk.adm));
  assert.notEqual(ag2.body.itens[0].sol_id, ag.body.itens[0].sol_id);
  const semPagina = await request(app).get('/agendamentos').query({ status: 'todos' }).set(auth(tk.adm));
  assert.ok(Array.isArray(semPagina.body), 'sem ?page= continua devolvendo a lista inteira');
  assert.equal(semPagina.body.length, ag.body.total);
  assert.ok(semPagina.body.every((a) => a.posto.pos_id === ids.posto1));

  const minhas = await request(app).get('/minhas-prescricoes').query({ situacao: 'encerradas', page: 1, porPagina: 1 }).set(auth(tk.pacB));
  assert.equal(minhas.status, 200);
  assert.ok(minhas.body.itens.length <= 1);
  assert.ok(minhas.body.contagem.encerradas >= 1);
  assert.ok(minhas.body.itens.every((p) => p.sol_status === 'Nao Autorizado' || p.agendamento?.sol_status === 'concluido'));
  const andamento = await request(app).get('/minhas-prescricoes').query({ situacao: 'andamento', page: 1 }).set(auth(tk.pacB));
  assert.equal(andamento.body.total, andamento.body.contagem.andamento);
  assert.equal((await request(app).get('/minhas-prescricoes').query({ situacao: 'x' }).set(auth(tk.pacB))).status, 400);

  const hist = await request(app).get('/prescricoes/historico').query({ page: 1, porPagina: 2, status: 'Revisado' }).set(auth(tk.adm));
  assert.equal(hist.status, 200);
  assert.ok(hist.body.itens.every((p) => ['Revisado', 'Aprovado'].includes(p.sol_status)));
  assert.ok(hist.body.itens.length <= 2);
  const busca = await request(app).get('/prescricoes/historico').query({ page: 1, busca: 'Ana' }).set(auth(tk.adm));
  assert.ok(busca.body.itens.every((p) => p.pac_nome.includes('Ana')));
  assert.equal((await request(app).get('/prescricoes/historico').query({ page: 1, status: 'xyz' }).set(auth(tk.adm))).status, 400);

  const aut = await request(app).get('/prescricao/aprovadas').query({ page: 1, porPagina: 5, status: 'Revisado' }).set(auth(tk.aut));
  assert.equal(aut.status, 200);
  assert.ok(aut.body.itens.every((p) => ['Revisado', 'Aprovado'].includes(p.sol_status)));
  const corrigida = aut.body.itens.find((p) => p.sol_id === ids.solCorrigida);
  assert.equal(corrigida?.versoes_anteriores, 1, 'autorizador vê que recebeu nova versão');
});

test('L7 painel do autorizador: fila, novas versões e as próprias decisões', async () => {
  const r = await request(app).get('/painel/autorizador').set(auth(tk.aut));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.aguardando >= 1);
  assert.ok(r.body.comNovaVersao >= 1);
  assert.equal(typeof r.body.autorizadas30, 'number');
  assert.ok(Array.isArray(r.body.fila) && r.body.fila.length <= 5);
  assert.ok(Array.isArray(r.body.recentes));
  assert.equal((await request(app).get('/painel/autorizador').set(auth(tk.adm))).status, 403);

  const adm = await request(app).get('/painel/admin').set(auth(tk.adm));
  assert.equal(typeof adm.body.aguardandoPaciente, 'number');
  assert.ok(Array.isArray(adm.body.proximasColetas));
});

// ------------------------------------------------------------------
// Etapa N — Notificações (sino)
// ------------------------------------------------------------------
const somarDiasTeste = (iso, n) => new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10);
const daqui5 = somarDiasTeste(hoje, 5);
const notifs = (tipo, id, evento) => knex('notificacao')
  .where({ not_dest_tipo: tipo, not_dest_id: id })
  .modify((qb) => { if (evento) qb.where('not_evento', evento); });
const admId = async (email) => (await knex('administrador').where('adm_email', email).first('adm_id')).adm_id;
const autId = async () => (await knex('autorizador').where('aut_email', 'aut@teste.com').first('aut_id')).aut_id;

test('N1 fluxo completo: cada etapa avisa só quem deve, sem duplicar', async () => {
  const adm1 = await admId('adm@teste.com');
  const admNorte = await admId('norte@teste.com');
  const aut = await autId();
  const filaNorteAntes = JSON.stringify(await notifs('ADMIN', admNorte, 'fila_analise'));

  const envio = await request(app).post('/solicitacoes').set(auth(tk.pacB))
    .send({ pos_id: ids.posto1, sol_prescricao: png('receita-notif'), sol_prescricao_tipo: 'image/png' });
  assert.equal(envio.status, 201);
  const sol = envio.body.solicitacao.sol_id;
  ids.solNotif = sol;
  assert.equal((await notifs('PACIENTE', ids.pacB, 'prescricao_recebida').where('sol_id', sol)).length, 1);
  const fila = await notifs('ADMIN', adm1, 'fila_analise').whereNull('not_lida_em');
  assert.equal(fila.length, 1, 'uma notificação agregada para o admin do posto');
  assert.match(fila[0].not_mensagem, /aguardando análise na sua unidade/);
  assert.equal(JSON.stringify(await notifs('ADMIN', admNorte, 'fila_analise')), filaNorteAntes, 'admin de outro posto não recebe');
  assert.equal((await notifs('PACIENTE', ids.pacA).where('sol_id', sol)).length, 0, 'outro paciente não recebe');

  const rev = await request(app).patch(`/solicitacao/${sol}`).set(auth(tk.adm))
    .send({ sol_status: 'Revisado', ins_id: ids.insumo, sol_insumo_quant: 3, sol_data_vencimento: daqui5 });
  assert.equal(rev.status, 200);
  assert.equal((await notifs('PACIENTE', ids.pacB, 'prescricao_revisada').where('sol_id', sol)).length, 1);
  const filaAut = await notifs('AUTORIZADOR', aut, 'fila_autorizacao').whereNull('not_lida_em');
  assert.equal(filaAut.length, 1);
  assert.match(filaAut[0].not_mensagem, /aguardando sua análise/);

  const nao = await request(app).patch(`/autorizador/solicitacao/${sol}`).set(auth(tk.aut))
    .send({ sol_status: 'Nao Autorizado', sol_motivo_nao_autorizado: 'Falta o CID na receita' });
  assert.equal(nao.status, 200);
  const avisoPac = await notifs('PACIENTE', ids.pacB, 'prescricao_nao_autorizada').where('sol_id', sol).first();
  assert.match(avisoPac.not_mensagem, /Falta o CID na receita/);
  assert.equal(avisoPac.not_tom, 'erro');
  const avisoAdm = await notifs('ADMIN', adm1, 'nao_autorizada_equipe').where('sol_id', sol).first();
  assert.match(avisoAdm.not_mensagem, /de Bruno/, 'equipe vê o primeiro nome');
  assert.doesNotMatch(avisoAdm.not_mensagem, /111\.444/, 'nunca o CPF');
  assert.equal((await notifs('ADMIN', admNorte, 'nao_autorizada_equipe')).length, 0);

  // refazer o pedido: observação obrigatória, volta ao autorizador
  assert.equal((await request(app).patch(`/solicitacao/${sol}/refazer`).set(auth(tk.adm)).send({})).status, 400);
  assert.equal((await request(app).patch(`/solicitacao/${sol}/refazer`).set(auth(tk.admNorte)).send({ observacao: 'x' })).status, 403);
  const refazer = await request(app).patch(`/solicitacao/${sol}/refazer`).set(auth(tk.adm)).send({ observacao: 'CID anexado na nova foto' });
  assert.equal(refazer.status, 200, JSON.stringify(refazer.body));
  const linha = await knex('solicitacao').where('sol_id', sol).first();
  assert.equal(linha.sol_status, 'Revisado');
  assert.equal(linha.sol_observacao_equipe, 'CID anexado na nova foto');
  assert.equal((await request(app).patch(`/solicitacao/${sol}/refazer`).set(auth(tk.adm)).send({ observacao: 'de novo' })).status, 409);
  assert.equal((await notifs('PACIENTE', ids.pacB, 'prescricao_reanalise').where('sol_id', sol)).length, 1);
  const verAut = await request(app).get(`/autorizador/solicitacao/${sol}`).set(auth(tk.aut));
  assert.equal(verAut.body.sol_observacao_equipe, 'CID anexado na nova foto');

  const aut2 = await request(app).patch(`/autorizador/solicitacao/${sol}`).set(auth(tk.aut)).send({ sol_status: 'Autorizado' });
  assert.equal(aut2.status, 200);
  assert.equal((await notifs('PACIENTE', ids.pacB, 'prescricao_autorizada').where('sol_id', sol)).length, 1);
  assert.equal((await notifs('ADMIN', adm1, 'pronta_para_agendar').where('sol_id', sol)).length, 1);

  // agendar: coleta não pode ser depois do vencimento
  const base = { paciente: { pac_id: ids.pacB }, posto: { pos_id: ids.posto1 }, itens: [{ ins_nome: 'Fralda G', quantidade: 1 }], sol_origem_id: sol, confirmar_sem_estoque: true };
  const depois = await request(app).post('/agendamentos').set(auth(tk.adm)).send({ ...base, sol_data_de_coleta: somarDiasTeste(daqui5, 1) });
  assert.equal(depois.status, 400);
  assert.match(depois.body.message, /vencimento/);
  const ag = await request(app).post('/agendamentos').set(auth(tk.adm)).send({ ...base, sol_data_de_coleta: amanha });
  assert.equal(ag.status, 201, JSON.stringify(ag.body));
  ids.agNotif = ag.body.sol_id;
  assert.equal((await notifs('PACIENTE', ids.pacB, 'coleta_agendada')).filter((n) => n.sol_id === ids.agNotif).length, 1,
    'o evento gravado também na prescrição de origem não gera aviso repetido');

  // remarcar: mesma linha, nova data, aviso ao paciente
  assert.equal((await request(app).patch(`/agendamentos/${ids.agNotif}/remarcar`).set(auth(tk.adm)).send({ sol_data_de_coleta: ontem })).status, 400);
  assert.equal((await request(app).patch(`/agendamentos/${ids.agNotif}/remarcar`).set(auth(tk.adm)).send({ sol_data_de_coleta: somarDiasTeste(daqui5, 2) })).status, 400);
  const rem = await request(app).patch(`/agendamentos/${ids.agNotif}/remarcar`).set(auth(tk.adm)).send({ sol_data_de_coleta: daqui5, motivo: 'Posto fechado no feriado' });
  assert.equal(rem.status, 200, JSON.stringify(rem.body));
  const agLinha = await knex('solicitacao').where('sol_id', ids.agNotif).first();
  const anterior = agLinha.sol_data_anterior instanceof Date ? agLinha.sol_data_anterior.toISOString() : String(agLinha.sol_data_anterior);
  assert.equal(anterior.slice(0, 10), amanha);
  const avisoRem = await notifs('PACIENTE', ids.pacB, 'coleta_remarcada').where('sol_id', ids.agNotif).first();
  assert.match(avisoRem.not_mensagem, /Posto fechado no feriado/);
  assert.equal((await request(app).patch(`/agendamentos/${ids.agNotif}/remarcar`).set(auth(tk.admNorte)).send({ sol_data_de_coleta: amanha })).status, 403);

  await request(app).patch(`/agendamentos/${ids.agNotif}/recado`).set(auth(tk.adm)).send({ recado: 'Traga documento com foto' });
  assert.equal((await notifs('PACIENTE', ids.pacB, 'recado_unidade').where('sol_id', ids.agNotif)).length, 1);

  // reprocessar todos os eventos não duplica
  const antes = (await notifs('PACIENTE', ids.pacB)).filter((n) => !n.not_evento.startsWith('lembrete')).length;
  await knex('notificacao_evento').where('nev_status', 'ok').update({ nev_status: 'erro' });
  process.env.CRON_SECRET = 'cron-teste';
  assert.equal((await request(app).get('/tarefas/diaria').set(auth('cron-teste'))).status, 200);
  assert.equal((await notifs('PACIENTE', ids.pacB)).filter((n) => !n.not_evento.startsWith('lembrete')).length,
    antes, 'reprocessar os eventos não cria notificações repetidas');
});

test('N2 sino: lista, contador e marcar como lida só das próprias notificações', async () => {
  const r = await request(app).get('/notificacoes/resumo').set(auth(tk.pacB));
  assert.equal(r.status, 200);
  assert.ok(r.body.naoLidas >= 5);
  assert.ok(r.body.ultimas.length <= 6);
  assert.ok(r.body.ultimas.every((n) => n.titulo && n.mensagem && n.link?.startsWith('/')));

  const pagina = await request(app).get('/notificacoes').query({ page: 1, porPagina: 3 }).set(auth(tk.pacB));
  assert.equal(pagina.status, 200);
  assert.equal(pagina.body.itens.length, 3);
  assert.ok(pagina.body.totalPaginas >= 2);
  const alvo = pagina.body.itens[0];

  // outra pessoa não lê nem marca
  assert.equal((await request(app).patch(`/notificacoes/${alvo.id}/lida`).set(auth(tk.pacA))).status, 404);
  assert.equal((await request(app).patch(`/notificacoes/${alvo.id}/lida`).set(auth(tk.adm))).status, 404);
  assert.equal((await request(app).get('/notificacoes').set(auth(tk.pacA))).body.itens.some((n) => n.id === alvo.id), false);

  const marcar = await request(app).patch(`/notificacoes/${alvo.id}/lida`).set(auth(tk.pacB));
  assert.equal(marcar.status, 200);
  assert.equal(marcar.body.naoLidas, r.body.naoLidas - 1);
  assert.equal((await request(app).patch(`/notificacoes/${alvo.id}/lida`).set(auth(tk.pacB))).status, 200, 'idempotente');

  // ler não muda o status da prescrição/agendamento
  assert.equal((await knex('solicitacao').where('sol_id', ids.agNotif).first()).sol_status, 'agendado');

  const naoLidas = await request(app).get('/notificacoes').query({ situacao: 'nao_lidas' }).set(auth(tk.pacB));
  assert.ok(naoLidas.body.itens.every((n) => !n.lida));
  const todas = await request(app).patch('/notificacoes/lidas').set(auth(tk.pacB)).send({});
  assert.equal(todas.body.naoLidas, 0);
  assert.equal((await request(app).get('/notificacoes').query({ situacao: 'xyz' }).set(auth(tk.pacB))).status, 400);
  assert.equal((await request(app).get('/notificacoes')).status, 401);

  // admin com token antigo (sem id) é reconhecido pelo e-mail
  const adm = await request(app).get('/notificacoes/resumo').set(auth(tk.adm));
  assert.equal(adm.status, 200);
  assert.ok(adm.body.naoLidas >= 1);
  const desconhecido = jwt.sign({ email: 'ninguem@teste.com', tipo: 'ADMIN' }, process.env.ACCESS_TOKEN_SECRET);
  assert.equal((await request(app).get('/notificacoes').set(auth(desconhecido))).status, 403);
});

test('N3 tarefa diária: lembretes, coleta sem baixa, não compareceu e prescrição vencida', async () => {
  delete process.env.CRON_SECRET;
  assert.equal((await request(app).get('/tarefas/diaria')).status, 503);
  process.env.CRON_SECRET = 'cron-teste';
  assert.equal((await request(app).get('/tarefas/diaria').set(auth('errado'))).status, 401);

  const ag = async (dados) => {
    const [l] = await knex('solicitacao').insert({ pac_id: ids.pacA, pos_id: ids.posto1, sol_insumo_quant: 0, ...dados }).returning('sol_id');
    await knex('solicitacao').where('sol_id', l.sol_id).update({ sol_protocolo: `AG${String(l.sol_id).padStart(6, '0')}` });
    await knex('coleta').insert({ sol_id: l.sol_id, ins_id: ids.insumo, quantidade: 1 });
    return l.sol_id;
  };
  const agHoje = await ag({ sol_status: 'agendado', sol_data_de_coleta: hoje });
  const agAmanha = await ag({ sol_status: 'agendado', sol_data_de_coleta: amanha });
  const agCancelado = await ag({ sol_status: 'cancelado', sol_data_de_coleta: amanha });
  const agOntem = await ag({ sol_status: 'agendado', sol_data_de_coleta: ontem });
  const agAntigo = await ag({ sol_status: 'agendado', sol_data_de_coleta: somarDiasTeste(hoje, -9) });

  // prescrição autorizada que venceu ontem, com agendamento ativo
  const [venc] = await knex('solicitacao').insert({ pac_id: ids.pacA, pos_id: ids.posto1, sol_status: 'Autorizado', sol_insumo_quant: 1, ins_id: ids.insumo, sol_data_vencimento: ontem }).returning('sol_id');
  const agVencida = await ag({ sol_status: 'agendado', sol_data_de_coleta: amanha, sol_origem_id: venc.sol_id });

  const r1 = await request(app).get('/tarefas/diaria').set(auth('cron-teste'));
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  const doA = (evento) => notifs('PACIENTE', ids.pacA, evento);

  assert.equal((await doA('lembrete_hoje').where('sol_id', agHoje)).length, 1);
  assert.equal((await doA('lembrete_vespera').where('sol_id', agAmanha)).length, 1);
  assert.equal((await doA().where('sol_id', agCancelado)).length, 0, 'cancelado não recebe lembrete');

  const adm1 = await admId('adm@teste.com');
  assert.equal((await notifs('ADMIN', adm1, 'coleta_sem_baixa').where('sol_id', agOntem)).length, 1);
  assert.equal((await knex('solicitacao').where('sol_id', agOntem).first()).sol_status, 'agendado', 'ainda dentro dos 7 dias');

  assert.equal((await knex('solicitacao').where('sol_id', agAntigo).first()).sol_status, 'nao_compareceu');
  assert.equal((await doA('coleta_nao_realizada').where('sol_id', agAntigo)).length, 1);

  const cancelada = await knex('solicitacao').where('sol_id', agVencida).first();
  assert.equal(cancelada.sol_status, 'cancelado');
  assert.equal(cancelada.sol_motivo_cancelamento, 'Prescrição vencida');
  assert.equal((await doA('prescricao_vencida').where('sol_id', venc.sol_id)).length, 1);
  assert.equal((await doA('lembrete_vespera').where('sol_id', agVencida)).length, 0, 'agendamento cancelado não recebe lembrete');

  // rodar de novo no mesmo dia não duplica nada
  const total = (await knex('notificacao')).length;
  assert.equal((await request(app).get('/tarefas/diaria').set(auth('cron-teste'))).status, 200);
  assert.equal((await knex('notificacao')).length, total);

  // "não compareceu" aparece em Anteriores e não pode ser concluído
  const anteriores = await request(app).get('/meus-agendamentos').query({ situacao: 'anteriores', porPagina: 50 }).set(auth(tk.pacA));
  assert.ok(anteriores.body.itens.some((a) => a.sol_id === agAntigo && a.status === 'nao_compareceu'));
  assert.equal((await request(app).patch(`/agendamentos/${agAntigo}/concluir`).set(auth(tk.adm))).status, 409);

  // prescrição vencida não pode ser autorizada
  const [rev] = await knex('solicitacao').insert({ pac_id: ids.pacA, pos_id: ids.posto1, sol_status: 'Revisado', sol_insumo_quant: 1, ins_id: ids.insumo, sol_data_vencimento: ontem }).returning('sol_id');
  const autVencida = await request(app).patch(`/autorizador/solicitacao/${rev.sol_id}`).set(auth(tk.aut)).send({ sol_status: 'Autorizado' });
  assert.equal(autVencida.status, 409);
  assert.match(autVencida.body.error, /venceu/);
});

test('N4 estoque: equipe avisada de baixo/esgotado; paciente só se tiver coleta agendada do insumo', async () => {
  const [ins] = await knex('insumo').insert({ ins_nome: 'Luva Nitrílica', ins_quantidade: 10, pos_id: ids.posto1 }).returning('ins_id');
  const [ag] = await knex('solicitacao').insert({ pac_id: ids.pacA, pos_id: ids.posto1, sol_status: 'agendado', sol_insumo_quant: 0, sol_data_de_coleta: daqui5 }).returning('sol_id');
  await knex('coleta').insert({ sol_id: ag.sol_id, ins_id: ins.ins_id, quantidade: 2 });
  const adm1 = await admId('adm@teste.com');
  const mover = (tipo, quantidade) => request(app).patch(`/insumos/${ins.ins_id}`).set(auth(tk.adm)).send({ tipo, quantidade });

  assert.equal((await mover('saida', 6)).status, 200); // 4 = baixo
  assert.equal((await notifs('ADMIN', adm1, 'estoque_baixo')).filter((n) => /Luva/.test(n.not_mensagem)).length, 1);
  assert.equal((await notifs('PACIENTE', ids.pacA, 'estoque_baixo').where('sol_id', ag.sol_id)).length, 1);
  assert.equal((await notifs('PACIENTE', ids.pacB, 'estoque_baixo')).length, 0, 'quem não tem coleta do insumo não recebe');

  assert.equal((await mover('saida', 4)).status, 200); // 0 = esgotado
  const esgotado = await notifs('PACIENTE', ids.pacA, 'estoque_esgotado').where('sol_id', ag.sol_id).first();
  assert.match(esgotado.not_mensagem, /Luva Nitrílica está temporariamente indisponível/);

  assert.equal((await mover('entrada', 20)).status, 200);
  assert.equal((await notifs('PACIENTE', ids.pacA, 'estoque_reabastecido').where('sol_id', ag.sol_id)).length, 1);
});

test('N5 falha ao gerar notificação fica registrada e é refeita pela tarefa diária', async () => {
  const evento = await knex('notificacao_evento as e')
    .join('historico_solicitacao as h', 'h.his_id', 'e.his_id')
    .where('h.his_acao', 'enviada').where('h.sol_id', ids.solNotif).first('e.his_id');
  await knex('notificacao').where({ sol_id: ids.solNotif, not_evento: 'prescricao_recebida' }).del();
  await knex('notificacao_evento').where('his_id', evento.his_id).update({ nev_status: 'erro', nev_erro: 'falha simulada' });

  assert.equal((await request(app).get('/tarefas/diaria').set(auth('cron-teste'))).status, 200);
  assert.equal((await knex('notificacao_evento').where('his_id', evento.his_id).first()).nev_status, 'ok');
  assert.equal((await notifs('PACIENTE', ids.pacB, 'prescricao_recebida').where('sol_id', ids.solNotif)).length, 1);
});

test('N6 links das notificações: ?sol_id= mostra só o item, e só se for do paciente', async () => {
  const minha = await request(app).get('/minhas-prescricoes').query({ sol_id: ids.solNotif }).set(auth(tk.pacB));
  assert.equal(minha.status, 200);
  assert.deepEqual(minha.body.map((p) => p.sol_id), [ids.solNotif]);
  const deOutro = await request(app).get('/minhas-prescricoes').query({ sol_id: ids.solNotif }).set(auth(tk.pacA));
  assert.deepEqual(deOutro.body, []);
  assert.equal((await request(app).get('/minhas-prescricoes').query({ sol_id: 'abc' }).set(auth(tk.pacB))).status, 400);

  const ag = await request(app).get('/meus-agendamentos').query({ sol_id: ids.agNotif }).set(auth(tk.pacB));
  assert.deepEqual(ag.body.itens.map((a) => a.sol_id), [ids.agNotif]);
  assert.equal((await request(app).get('/meus-agendamentos').query({ sol_id: ids.agNotif }).set(auth(tk.pacA))).body.itens.length, 0);
});

// ------------------------------------------------------------------
// Etapa Q — Leitor de QR Code do comprovante
// ------------------------------------------------------------------
test('Q1 agendamento nasce com código do QR; só o paciente recebe o código', async () => {
  await knex('insumo').insert({ ins_nome: 'Sonda Q', ins_quantidade: 10, pos_id: ids.posto1 });
  const origem = await knex('solicitacao').insert({ pac_id: ids.pacB, pos_id: ids.posto1, sol_status: 'Autorizado', sol_insumo_quant: 0, sol_data_vencimento: amanha }).returning('sol_id');
  const r = await request(app).post('/agendamentos').set(auth(tk.adm)).send({
    paciente: { pac_id: ids.pacB }, posto: { pos_id: ids.posto1 }, sol_data_de_coleta: amanha,
    itens: [{ ins_nome: 'Sonda Q', quantidade: 2 }], sol_origem_id: origem[0].sol_id,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ids.agQR = r.body.sol_id;
  ids.protQR = r.body.sol_protocolo;
  const linha = await knex('solicitacao').where('sol_id', ids.agQR).first();
  assert.match(String(linha.sol_codigo_qr), /^[0-9a-f-]{36}$/);
  ids.codQR = String(linha.sol_codigo_qr);

  const pac = await request(app).get('/meus-agendamentos').query({ sol_id: ids.agQR }).set(auth(tk.pacB));
  assert.equal(pac.body.itens[0].sol_codigo_qr, ids.codQR);
  const adm = await request(app).get('/agendamentos').query({ status: 'todos', busca: ids.protQR }).set(auth(tk.adm));
  assert.ok(adm.body.length && adm.body.every((a) => a.sol_codigo_qr === undefined), 'listagem do admin não expõe o código');
});

test('Q2 leitura do QR: formato novo, antigo, leitor com teclado ABNT2 e erros', async () => {
  const ler = (codigo, t = tk.adm) => request(app).get('/agendamentos/qrcode').query({ codigo }).set(auth(t));

  const ok = await ler(`INSUMED:${ids.protQR}:${ids.codQR}`);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.sol_id, ids.agQR);
  assert.equal((await ler(`  insumed:${ids.protQR.toLowerCase()}:${ids.codQR.toUpperCase()} `)).body.sol_id, ids.agQR, 'maiúsculas/espaços');
  assert.equal((await ler(`INSUMEDÇ${ids.protQR}Ç${ids.codQR}`)).body.sol_id, ids.agQR, 'leitor USB em teclado ABNT2');
  assert.equal((await ler(ids.protQR)).body.sol_id, ids.agQR, 'comprovante antigo (só protocolo)');

  assert.equal((await ler('qualquer coisa')).status, 400);
  assert.equal((await ler('')).status, 400);
  assert.equal((await ler(`INSUMED:${ids.protQR}:${randomUUID()}`)).status, 404, 'código inventado');
  assert.equal((await ler(`INSUMED:AG999999:${ids.codQR}`)).status, 404, 'protocolo trocado');
  assert.equal((await ler(`INSUMED:${ids.protQR}:${ids.codQR}`, tk.admNorte)).status, 403, 'outro posto');
  assert.equal((await ler(`INSUMED:${ids.protQR}:${ids.codQR}`, tk.pacB)).status, 403, 'paciente não usa o leitor');
  assert.equal((await ler(`INSUMED:${ids.protQR}:${ids.codQR}`, tk.aut)).status, 403, 'autorizador não usa o leitor');
});

test('Q3 tela de atendimento: dados mínimos, posto conferido, concluir pelo fluxo existente', async () => {
  const r = await request(app).get(`/agendamentos/${ids.agQR}/atendimento`).set(auth(tk.adm));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.paciente.pac_nome, 'Bruno Lima');
  assert.equal(r.body.paciente.pac_cpf_parcial, '111.***.***-35');
  assert.equal(r.body.paciente.pac_cpf, undefined);
  assert.equal(r.body.paciente.pac_telefone, undefined);
  assert.deepEqual(r.body.insumos.map((i) => [i.ins_nome, i.quantidade, i.estoque]), [['Sonda Q', 2, 10]]);
  assert.equal(r.body.prescricao_vencida, false);

  assert.equal((await request(app).get(`/agendamentos/${ids.agQR}/atendimento`).set(auth(tk.admNorte))).status, 403);
  assert.equal((await request(app).get(`/agendamentos/${ids.agQR}/atendimento`).set(auth(tk.pacB))).status, 403);
  assert.equal((await request(app).get(`/agendamentos/${ids.sol1}/atendimento`).set(auth(tk.adm))).status, 404, 'prescrição não é agendamento');

  assert.equal((await request(app).patch(`/agendamentos/${ids.agQR}/concluir`).set(auth(tk.adm))).status, 200);
  const depois = await request(app).get(`/agendamentos/${ids.agQR}/atendimento`).set(auth(tk.adm));
  assert.equal(depois.body.status, 'concluido');
  assert.equal(depois.body.insumos[0].estoque, 8);
});

// ------------------------------------------------------------------
// Etapa S — Equipe por convite, login por CPF e estoque reservado (25/10)
// ------------------------------------------------------------------
test('S1 estoque reservado: insumo da própria unidade, aviso ao agendar além do disponível', async () => {
  const [gaze] = await knex('insumo').insert({ ins_nome: 'Gaze S', ins_quantidade: 5, pos_id: ids.posto1 }).returning('ins_id');
  const [gazeNorte] = await knex('insumo').insert({ ins_nome: 'Gaze S', ins_quantidade: 50, pos_id: ids.posto2 }).returning('ins_id');
  const agendar = (itens, extra = {}) => request(app).post('/agendamentos').set(auth(tk.adm)).send({
    paciente: { pac_id: ids.pacB }, posto: { pos_id: ids.posto1 }, sol_data_de_coleta: amanha, itens, ...extra,
  });

  const a1 = await agendar([{ ins_id: gaze.ins_id, quantidade: 3 }]);
  assert.equal(a1.status, 201, JSON.stringify(a1.body));

  const lista = await request(app).get('/insumos/listar').set(auth(tk.adm));
  const item = lista.body.find((i) => i.ins_id === gaze.ins_id);
  assert.equal(item.ins_quantidade, 5, 'a baixa só acontece na conclusão');
  assert.equal(item.ins_reservado, 3);
  assert.equal(item.ins_disponivel, 2);

  // além do disponível: avisa e não cria nada
  const antes = await knex('solicitacao').count({ n: '*' }).first();
  const a2 = await agendar([{ ins_id: gaze.ins_id, quantidade: 3 }]);
  assert.equal(a2.status, 409);
  assert.equal(a2.body.codigo, 'ESTOQUE_INSUFICIENTE');
  assert.deepEqual(a2.body.itens.map((i) => [i.ins_nome, i.pedido, i.disponivel]), [['Gaze S', 3, 2]]);
  assert.equal((await knex('solicitacao').count({ n: '*' }).first()).n, antes.n);

  // confirmando, agenda mesmo assim
  const a3 = await agendar([{ ins_id: gaze.ins_id, quantidade: 3 }], { confirmar_sem_estoque: true });
  assert.equal(a3.status, 201, JSON.stringify(a3.body));

  // insumo de outra unidade e nome fora do estoque: recusados, nada é criado
  const outro = await agendar([{ ins_id: gazeNorte.ins_id, quantidade: 1 }]);
  assert.equal(outro.status, 400);
  assert.match(outro.body.message, /não está cadastrado no estoque de Posto Centro/);
  const insumosAntes = (await knex('insumo').count({ n: '*' }).first()).n;
  const inventado = await agendar([{ ins_nome: 'Produto que não existe', quantidade: 1 }]);
  assert.equal(inventado.status, 400);
  assert.equal((await knex('insumo').count({ n: '*' }).first()).n, insumosAntes, 'nenhum insumo novo');

  // pelo nome (clientes antigos) só acha o da própria unidade; linhas repetidas somam
  const porNome = await agendar([{ ins_nome: 'gaze s', quantidade: 1 }, { ins_id: gaze.ins_id, quantidade: 1 }], { confirmar_sem_estoque: true });
  assert.equal(porNome.status, 201, JSON.stringify(porNome.body));
  const itens = await knex('coleta').where('sol_id', porNome.body.sol_id);
  assert.deepEqual(itens.map((i) => [i.ins_id, i.quantidade]), [[gaze.ins_id, 2]]);

  // cancelar libera a reserva
  await request(app).patch(`/agendamentos/${a3.body.sol_id}/cancelar`).set(auth(tk.adm)).send({ motivo: 'Paciente pediu' }).expect(200);
  const depois = (await request(app).get('/insumos/listar').set(auth(tk.adm))).body.find((i) => i.ins_id === gaze.ins_id);
  assert.equal(depois.ins_reservado, 5);

  // saída abaixo do reservado: registra e avisa
  const saida = await request(app).patch(`/insumos/${gaze.ins_id}`).set(auth(tk.adm)).send({ tipo: 'saida', quantidade: 1 });
  assert.equal(saida.status, 200);
  assert.match(saida.body.aviso, /reservadas/);
});

test('S2 login por CPF ou e-mail; mesma pessoa em dois perfis escolhe o perfil', async () => {
  const porCpf = await request(app).post('/login').send({ login: '529.982.247-25', senha: 'Senha@123' });
  assert.equal(porCpf.status, 200, JSON.stringify(porCpf.body));
  assert.equal(porCpf.body.usuario.tipo, 'PACIENTE');
  assert.equal(jwt.decode(porCpf.body.token).id, ids.pacA);

  const semPontos = await request(app).post('/login').send({ login: '52998224725', senha: 'Senha@123' });
  assert.equal(semPontos.status, 200);

  // campo antigo "email" continua funcionando, com e-mail ou CPF
  assert.equal((await request(app).post('/login').send({ email: 'ana@teste.com', senha: 'Senha@123' })).status, 200);
  assert.equal((await request(app).post('/login').send({ email: '52998224725', senha: 'Senha@123' })).status, 200);

  assert.equal((await request(app).post('/login').send({ login: '123.456.789-00', senha: 'Senha@123' })).status, 400);
  const errada = await request(app).post('/login').send({ login: '529.982.247-25', senha: 'Errada@123' });
  assert.equal(errada.status, 401);
  assert.match(errada.body.msg, /CPF ou senha/);

  // Ana também trabalha na unidade (mesmo CPF e senha, outro e-mail)
  await knex('administrador').insert({
    adm_nome: 'Ana Souza', adm_email: 'ana.unidade@teste.com', adm_senha: await bcrypt.hash('Senha@123', 4),
    adm_cpf: '52998224725', pos_id: ids.posto1, tp_universal: false,
  });
  const ambos = await request(app).post('/login').send({ login: '529.982.247-25', senha: 'Senha@123' });
  assert.equal(ambos.status, 200);
  assert.equal(ambos.body.escolher_perfil, true);
  assert.equal(ambos.body.token, undefined, 'sem token até escolher');
  assert.deepEqual(ambos.body.perfis.map((p) => p.tipo).sort(), ['ADMIN', 'PACIENTE']);

  const comoAdmin = await request(app).post('/login').send({ login: '529.982.247-25', senha: 'Senha@123', perfil: 'ADMIN' });
  assert.equal(comoAdmin.status, 200);
  assert.equal(comoAdmin.body.usuario.tipo, 'ADMIN');
  assert.equal(jwt.decode(comoAdmin.body.token).posto_id, ids.posto1);
});

test('S3 convites pela API: só o admin universal, uso único, cancelamento e validade', async () => {
  const universal = tk.admMesmoId;
  assert.equal((await request(app).post('/convites').set(auth(tk.adm)).send({ perfil: 'AUTORIZADOR' })).status, 403);
  assert.equal((await request(app).get('/equipe').set(auth(tk.adm))).status, 403);
  assert.equal((await request(app).post('/convites').set(auth(universal)).send({ perfil: 'ADMIN' })).status, 400, 'admin precisa de unidade');
  assert.equal((await request(app).post('/convites').set(auth(universal)).send({ perfil: 'GERENTE' })).status, 400);

  const c = await request(app).post('/convites').set(auth(universal)).send({ perfil: 'ADMIN', posto_id: ids.posto2 });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal(c.body.posto.pos_nome, 'Posto Norte');
  const salvo = await knex('convite_equipe').where('cnv_id', c.body.cnv_id).first();
  assert.notEqual(salvo.cnv_codigo_hash, c.body.codigo, 'no banco fica só o hash');

  const lista = await request(app).get('/convites').set(auth(universal));
  assert.equal(lista.body.find((x) => x.cnv_id === c.body.cnv_id).situacao, 'pendente');

  const dados = { matricula: 'N-501', nome: 'Davi Neves', email: 'davi@teste.com', telefone: '24991234567', cpf: '300.264.746-20', senha: 'Senha@123', confirmacao_senha: 'Senha@123', posto_id: ids.posto1 };
  const cad = await request(app).post('/administrador').send({ ...dados, convite: c.body.codigo });
  assert.equal(cad.status, 201, JSON.stringify(cad.body));
  assert.equal((await knex('administrador').where('adm_email', 'davi@teste.com').first()).pos_id, ids.posto2, 'unidade do convite');
  assert.equal((await request(app).delete(`/convites/${c.body.cnv_id}`).set(auth(universal))).status, 409, 'usado não cancela');

  const c2 = await request(app).post('/convites').set(auth(universal)).send({ perfil: 'AUTORIZADOR' });
  assert.equal((await request(app).delete(`/convites/${c2.body.cnv_id}`).set(auth(universal))).status, 200);
  const cancelado = await request(app).post('/autorizador').send({ ...dados, email: 'x1@teste.com', convite: c2.body.codigo });
  assert.equal(cancelado.status, 403);
  assert.match(cancelado.body.erros[0], /cancelado/);

  const vencido = await criarConvite('AUTORIZADOR');
  await knex('convite_equipe').where('cnv_codigo_hash', hashTeste(vencido)).update({ cnv_expira_em: new Date(Date.now() - 1000) });
  const r = await request(app).post('/autorizador').send({ ...dados, email: 'x2@teste.com', convite: vencido });
  assert.equal(r.status, 403);
  assert.match(r.body.erros[0], /expirou/);
});

test('S4 cadastro direto com senha provisória, troca no primeiro acesso e desativação', async () => {
  const universal = tk.admMesmoId;
  const cad = await request(app).post('/equipe').set(auth(universal)).send({
    perfil: 'AUTORIZADOR', nome: 'Lia Moraes', email: 'lia@teste.com', telefone: '24991234567', cpf: '879.376.059-01',
  });
  assert.equal(cad.status, 201, JSON.stringify(cad.body));
  const provisoria = cad.body.senha_provisoria;
  assert.ok(provisoria && provisoria.length >= 10);

  const login = await request(app).post('/login').send({ login: 'lia@teste.com', senha: provisoria });
  assert.equal(login.status, 200);
  assert.equal(login.body.trocar_senha, true);
  const tokenLia = login.body.token;

  const errada = await request(app).put('/minha-senha').set(auth(tokenLia)).send({ senha_atual: 'Errada@1', nova_senha: 'NovaSenha@1', confirmacao_senha: 'NovaSenha@1' });
  assert.equal(errada.status, 400);
  const fraca = await request(app).put('/minha-senha').set(auth(tokenLia)).send({ senha_atual: provisoria, nova_senha: '123', confirmacao_senha: '123' });
  assert.equal(fraca.status, 400);
  const ok = await request(app).put('/minha-senha').set(auth(tokenLia)).send({ senha_atual: provisoria, nova_senha: 'NovaSenha@1', confirmacao_senha: 'NovaSenha@1' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const login2 = await request(app).post('/login').send({ login: 'lia@teste.com', senha: 'NovaSenha@1' });
  assert.equal(login2.status, 200);
  assert.equal(login2.body.trocar_senha, undefined);

  const equipe = await request(app).get('/equipe').set(auth(universal));
  const lia = equipe.body.find((p) => p.email === 'lia@teste.com');
  assert.equal(lia.perfil, 'AUTORIZADOR');
  assert.equal(lia.ativo, true);
  assert.equal(equipe.body.some((p) => 'adm_senha' in p || 'senha' in p), false);

  // desativar: o login e o token que já existia param na hora
  const des = await request(app).patch(`/equipe/AUTORIZADOR/${lia.id}/ativo`).set(auth(universal)).send({ ativo: false });
  assert.equal(des.status, 200);
  assert.equal((await request(app).post('/login').send({ login: 'lia@teste.com', senha: 'NovaSenha@1' })).status, 403);
  const negado = await request(app).get('/painel/autorizador').set(auth(login2.body.token));
  assert.equal(negado.status, 401);
  assert.match(negado.body.error, /desativada/);

  await request(app).patch(`/equipe/AUTORIZADOR/${lia.id}/ativo`).set(auth(universal)).send({ ativo: true }).expect(200);
  assert.equal((await request(app).get('/painel/autorizador').set(auth(login2.body.token))).status, 200);

  // ninguém desativa a si mesmo; valor precisa ser booleano
  assert.equal((await request(app).patch('/equipe/ADMIN/1/ativo').set(auth(universal)).send({ ativo: false })).status, 400);
  assert.equal((await request(app).patch(`/equipe/AUTORIZADOR/${lia.id}/ativo`).set(auth(universal)).send({ ativo: 'nao' })).status, 400);
  assert.equal((await request(app).patch(`/equipe/AUTORIZADOR/${lia.id}/ativo`).set(auth(tk.adm)).send({ ativo: false })).status, 403);
});

test('S5 informações públicas do convite para o formulário do link', async () => {
  const codigo = await criarConvite('ADMIN', ids.posto2);
  const info = await request(app).get('/convites/info').query({ codigo });
  assert.equal(info.status, 200);
  assert.equal(info.body.perfil, 'ADMIN');
  assert.equal(info.body.posto.pos_nome, 'Posto Norte');
  assert.equal((await request(app).get('/convites/info').query({ codigo: 'nao-existe' })).status, 404);
  await knex('convite_equipe').where('cnv_codigo_hash', hashTeste(codigo)).update({ cnv_cancelado_em: new Date() });
  const cancelado = await request(app).get('/convites/info').query({ codigo });
  assert.equal(cancelado.status, 410);
  assert.equal(cancelado.body.situacao, 'cancelado');
});

// ------------------------------------------------------------------
// Etapa 2 — Prescrição com vários insumos e retirada recorrente
// ------------------------------------------------------------------

// prescrição Pendente do paciente A no posto 1, criada direto no banco
const novaPrescricao = async () => {
  const [p] = await knex('solicitacao')
    .insert({ pac_id: ids.pacA, pos_id: ids.posto1, sol_status: 'Pendente', sol_insumo_quant: 0, sol_prescricao: Buffer.from('x') })
    .returning('sol_id');
  return p.sol_id;
};
const somar = (iso, dias) => new Date(Date.parse(iso) + dias * 86400000).toISOString().slice(0, 10);

test('R1 revisão com vários insumos: itens somados, colunas antigas com o 1º e leitura com a lista', async () => {
  const [bolsa] = await knex('insumo').insert({ ins_nome: 'Bolsa de colostomia', ins_quantidade: 100, pos_id: ids.posto1 }).returning('ins_id');
  const [placa] = await knex('insumo').insert({ ins_nome: 'Placa protetora', ins_quantidade: 100, pos_id: ids.posto1 }).returning('ins_id');
  ids.bolsa = bolsa.ins_id; ids.placa = placa.ins_id;
  const sol = await novaPrescricao();

  const r = await request(app).patch(`/solicitacao/${sol}`).set(auth(tk.adm)).send({
    sol_status: 'Revisado', sol_data_vencimento: somar(hoje, 90),
    itens: [{ ins_id: ids.bolsa, quantidade: 20 }, { ins_id: ids.placa, quantidade: 4 }, { ins_id: ids.bolsa, quantidade: 10 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const itens = await knex('solicitacao_item').where('sol_id', sol).orderBy('sit_id');
  assert.deepEqual(itens.map((i) => [i.ins_id, i.sit_quantidade]), [[ids.bolsa, 30], [ids.placa, 4]]);
  const linha = await knex('solicitacao').where('sol_id', sol).first();
  assert.equal(linha.ins_id, ids.bolsa);
  assert.equal(linha.sol_insumo_quant, 30);
  assert.equal(linha.sol_periodicidade_dias, null);

  const adm = await request(app).get(`/solicitacao/${sol}`).set(auth(tk.adm));
  assert.equal(adm.body.itens.length, 2);
  assert.equal(adm.body.insumos_resumo, '30x Bolsa de colostomia, 4x Placa protetora');
  const aut = await request(app).get(`/autorizador/solicitacao/${sol}`).set(auth(tk.aut));
  assert.equal(aut.body.itens.length, 2);
  const minhas = await request(app).get('/minhas-prescricoes').set(auth(tk.pacA));
  assert.equal(minhas.body.find((p) => p.sol_id === sol).itens.length, 2);
});

test('R2 revisão: insumo de outra unidade, lista vazia e frequência inválida são recusados', async () => {
  const [norte] = await knex('insumo').insert({ ins_nome: 'Fita (Norte)', ins_quantidade: 5, pos_id: ids.posto2 }).returning('ins_id');
  const sol = await novaPrescricao();
  const base = { sol_status: 'Revisado', sol_data_vencimento: somar(hoje, 60) };
  const casos = [
    [{ ...base, itens: [{ ins_id: norte.ins_id, quantidade: 1 }] }, 400, /não é do estoque da unidade/],
    [{ ...base, itens: [] }, 400, /pelo menos um insumo/],
    [{ ...base, itens: [{ ins_id: ids.bolsa, quantidade: 0 }] }, 400, /quantidade/],
    [{ ...base, itens: [{ ins_id: ids.bolsa, quantidade: 1 }], sol_periodicidade_dias: 3 }, 400, /frequência/],
    [{ ...base, itens: [{ ins_id: ids.bolsa, quantidade: 1 }], sol_periodicidade_dias: 'mensal' }, 400, /frequência/],
  ];
  for (const [corpo, status, msg] of casos) {
    const r = await request(app).patch(`/solicitacao/${sol}`).set(auth(tk.adm)).send(corpo);
    assert.equal(r.status, status, JSON.stringify(corpo));
    assert.match(r.body.error, msg);
  }
  assert.equal((await knex('solicitacao').where('sol_id', sol).first()).sol_status, 'Pendente');
});

test('R3 uso contínuo: cada retirada concluída libera o próximo ciclo; retirada única não', async () => {
  const sol = await novaPrescricao();
  await request(app).patch(`/solicitacao/${sol}`).set(auth(tk.adm)).send({
    sol_status: 'Revisado', sol_data_vencimento: somar(hoje, 120), sol_periodicidade_dias: 30,
    itens: [{ ins_id: ids.bolsa, quantidade: 2 }, { ins_id: ids.placa, quantidade: 1 }],
  }).expect(200);
  await request(app).patch(`/autorizador/solicitacao/${sol}`).set(auth(tk.aut)).send({ sol_status: 'Autorizado' }).expect(200);

  const agendar = (extra = {}) => request(app).post('/agendamentos').set(auth(tk.adm)).send({
    ...novoAg({ sol_origem_id: sol, itens: [{ ins_id: ids.bolsa, quantidade: 2 }, { ins_id: ids.placa, quantidade: 1 }] }), ...extra,
  });
  const c1 = await agendar();
  assert.equal(c1.status, 201, JSON.stringify(c1.body));
  assert.equal(c1.body.sol_ciclo, 1);
  assert.equal((await agendar()).status, 409); // ciclo 1 ainda em aberto

  await request(app).patch(`/agendamentos/${c1.body.sol_id}/concluir`).set(auth(tk.adm)).expect(200);
  const c2 = await agendar({ sol_data_de_coleta: somar(hoje, 30) });
  assert.equal(c2.status, 201, JSON.stringify(c2.body));
  assert.equal(c2.body.sol_ciclo, 2);

  // retirada única: depois de concluída, não agenda de novo
  const unica = await novaPrescricao();
  await request(app).patch(`/solicitacao/${unica}`).set(auth(tk.adm)).send({
    sol_status: 'Revisado', sol_data_vencimento: somar(hoje, 60), itens: [{ ins_id: ids.bolsa, quantidade: 1 }],
  }).expect(200);
  await request(app).patch(`/autorizador/solicitacao/${unica}`).set(auth(tk.aut)).send({ sol_status: 'Autorizado' }).expect(200);
  const u1 = await agendar({ sol_origem_id: unica, itens: [{ ins_id: ids.bolsa, quantidade: 1 }] });
  assert.equal(u1.status, 201);
  await request(app).patch(`/agendamentos/${u1.body.sol_id}/concluir`).set(auth(tk.adm)).expect(200);
  assert.equal((await agendar({ sol_origem_id: unica, itens: [{ ins_id: ids.bolsa, quantidade: 1 }] })).status, 409);
});

test('R4 tarefa diária cria o próximo ciclo 7 dias antes, uma vez só, e para no vencimento', async () => {
  const { criarProximosCiclos } = await import(pathToFileURL(path.join(BACKEND, 'src/notificacoes/tarefas.js')).href);
  const sol = await novaPrescricao();
  await request(app).patch(`/solicitacao/${sol}`).set(auth(tk.adm)).send({
    sol_status: 'Revisado', sol_data_vencimento: somar(hoje, 50), sol_periodicidade_dias: 30,
    itens: [{ ins_id: ids.bolsa, quantidade: 5 }, { ins_id: ids.placa, quantidade: 2 }],
  }).expect(200);
  await request(app).patch(`/autorizador/solicitacao/${sol}`).set(auth(tk.aut)).send({ sol_status: 'Autorizado' }).expect(200);
  const c1 = await request(app).post('/agendamentos').set(auth(tk.adm))
    .send(novoAg({ sol_origem_id: sol, itens: [{ ins_id: ids.bolsa, quantidade: 5 }] })).expect(201);
  await request(app).patch(`/agendamentos/${c1.body.sol_id}/concluir`).set(auth(tk.adm)).expect(200);

  // próxima = amanhã + 30. Antes dos 7 dias: nada
  const proxima = somar(amanha, 30);
  const ciclosDe = () => knex('solicitacao').where('sol_origem_id', sol).orderBy('sol_id');
  await criarProximosCiclos(somar(proxima, -8));
  assert.equal((await ciclosDe()).length, 1);

  await criarProximosCiclos(somar(proxima, -7));
  await criarProximosCiclos(somar(proxima, -7)); // rodar duas vezes não duplica
  const ciclos = await ciclosDe();
  assert.equal(ciclos.length, 2);
  const c2 = ciclos[1];
  assert.equal(c2.sol_status, 'agendado');
  assert.equal(c2.sol_ciclo, 2);
  assert.ok(c2.sol_protocolo);
  assert.ok(['manha', 'tarde'].includes(c2.sol_turno));
  // mesmos itens da prescrição (não só o que foi pedido no 1º agendamento)
  const coleta = await knex('coleta').where('sol_id', c2.sol_id).orderBy('ins_id');
  assert.deepEqual(coleta.map((c) => [c.ins_id, c.quantidade]), [[ids.bolsa, 5], [ids.placa, 2]]);

  // o 3º ciclo cairia depois do vencimento (50 dias): não é criado
  await request(app).patch(`/agendamentos/${c2.sol_id}/concluir`).set(auth(tk.adm)).expect(200);
  await criarProximosCiclos(somar(proxima, 25));
  assert.equal((await ciclosDe()).length, 2);
});

// ------------------------------------------------------------------
// Etapa 3 — Agenda com turnos e vagas, outra data, presença, prioridade
// ------------------------------------------------------------------

// Posto 3 só atende no dia da semana de "daqui a 3 dias", de manhã, com 1 vaga
const t3 = { dia: somar(hoje, 3) };
const msgDe = (r) => r.body.error ?? r.body.message;
const diaSemana = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();
const agPosto3 = (extra = {}) => ({
  paciente: { pac_id: ids.pacA }, posto: { pos_id: ids.posto3 }, sol_data_de_coleta: t3.dia,
  itens: [{ ins_id: ids.insPosto3, quantidade: 1 }], ...extra,
});

test('T1 horários da unidade: leitura pública, só o admin da unidade altera, validação', async () => {
  const [p3] = await knex('postosdesaude').insert({ pos_nome: 'Posto Leste' }).returning('pos_id');
  ids.posto3 = p3.pos_id;
  const [ins] = await knex('insumo').insert({ ins_nome: 'Sonda', ins_quantidade: 50, pos_id: ids.posto3 }).returning('ins_id');
  ids.insPosto3 = ins.ins_id;
  tk.admLeste = jwt.sign({ email: 'leste@teste.com', posto_id: ids.posto3, tp_universal: false, tipo: 'ADMIN' },
    process.env.ACCESS_TOKEN_SECRET, { expiresIn: '1h' });

  const padrao = await request(app).get(`/postos/${ids.posto3}/horarios`);
  assert.equal(padrao.status, 200);
  assert.equal(padrao.body.padrao, true);
  assert.equal(padrao.body.horarios.length, 10);

  const turno = { dia_semana: diaSemana(t3.dia), turno: 'manha', abre: '08:00', fecha: '12:00', vagas: 1 };
  assert.equal((await request(app).put(`/postos/${ids.posto3}/horarios`).set(auth(tk.adm)).send({ horarios: [turno] })).status, 403);
  assert.equal((await request(app).put(`/postos/${ids.posto3}/horarios`).set(auth(tk.pacA)).send({ horarios: [turno] })).status, 403);
  const invalidos = [
    [[{ ...turno, turno: 'noite' }], /Turno inválido/],
    [[{ ...turno, abre: '8h' }], /HH:MM/],
    [[{ ...turno, abre: '12:00', fecha: '08:00' }], /depois/],
    [[{ ...turno, vagas: 0 }], /Vagas/],
    [[turno, turno], /duas vezes/],
    [[], /pelo menos um turno/],
  ];
  for (const [horarios, msg] of invalidos) {
    const r = await request(app).put(`/postos/${ids.posto3}/horarios`).set(auth(tk.admLeste)).send({ horarios });
    assert.equal(r.status, 400, JSON.stringify(horarios));
    assert.match(msgDe(r), msg);
  }
  const ok = await request(app).put(`/postos/${ids.posto3}/horarios`).set(auth(tk.admLeste)).send({ horarios: [turno] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const lido = await request(app).get(`/postos/${ids.posto3}/horarios`);
  assert.equal(lido.body.padrao, false);
  assert.deepEqual(lido.body.horarios, [turno]);
});

test('T2 vagas por turno: lota, recusa outro turno e dia sem atendimento; remarcar ignora o próprio', async () => {
  const r1 = await request(app).post('/agendamentos').set(auth(tk.admLeste)).send(agPosto3());
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  assert.equal((await knex('solicitacao').where('sol_id', r1.body.sol_id).first()).sol_turno, 'manha');
  ids.agT = r1.body.sol_id;

  const lotado = await request(app).post('/agendamentos').set(auth(tk.admLeste)).send(agPosto3({ paciente: { pac_id: ids.pacB } }));
  assert.equal(lotado.status, 409);
  assert.match(msgDe(lotado), /Não há vagas|lotado/);
  const tarde = await request(app).post('/agendamentos').set(auth(tk.admLeste)).send(agPosto3({ paciente: { pac_id: ids.pacB }, sol_turno: 'tarde' }));
  assert.equal(tarde.status, 409);
  assert.match(msgDe(tarde), /não atende no turno da tarde/);
  const outroDia = await request(app).post('/agendamentos').set(auth(tk.admLeste)).send(agPosto3({ paciente: { pac_id: ids.pacB }, sol_data_de_coleta: somar(hoje, 4) }));
  assert.equal(outroDia.status, 409);
  assert.match(msgDe(outroDia), /não atende neste dia/);

  const agenda = await request(app).get(`/postos/${ids.posto3}/agenda?inicio=${t3.dia}&fim=${t3.dia}`).set(auth(tk.admLeste));
  assert.equal(agenda.status, 200);
  assert.deepEqual(agenda.body.map((a) => [a.turno, a.vagas, a.ocupadas, a.livres]), [['manha', 1, 1, 0]]);

  // a própria vaga não conta contra ela mesma ao remarcar para o mesmo turno
  const sug = await request(app).get(`/agendamentos/datas-sugeridas?pos_id=${ids.posto3}`).set(auth(tk.admLeste));
  assert.equal(sug.status, 200);
  assert.ok(!sug.body.opcoes.some((o) => o.data === t3.dia), 'dia lotado não aparece nas opções');
});

test('T3 dia fechado: bloqueia o agendamento e avisa quantos já estavam marcados', async () => {
  const proxSemana = somar(t3.dia, 7);
  assert.equal((await request(app).post(`/postos/${ids.posto3}/bloqueios`).set(auth(tk.adm)).send({ data: proxSemana })).status, 403);
  assert.equal((await request(app).post(`/postos/${ids.posto3}/bloqueios`).set(auth(tk.admLeste)).send({ data: ontem })).status, 400);

  const b = await request(app).post(`/postos/${ids.posto3}/bloqueios`).set(auth(tk.admLeste)).send({ data: t3.dia, motivo: 'Dedetização' });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal(b.body.agendamentos_no_dia, 1);
  assert.equal((await request(app).post(`/postos/${ids.posto3}/bloqueios`).set(auth(tk.admLeste)).send({ data: t3.dia })).status, 409);

  const fechado = await request(app).post('/agendamentos').set(auth(tk.admLeste)).send(agPosto3({ paciente: { pac_id: ids.pacB } }));
  assert.equal(fechado.status, 409);
  assert.match(msgDe(fechado), /fechada neste dia \(Dedetização\)/);
  const pub = await request(app).get(`/postos/${ids.posto3}/horarios`);
  assert.equal(pub.body.bloqueios[0].motivo, 'Dedetização');

  assert.equal((await request(app).delete(`/postos/${ids.posto3}/bloqueios/${b.body.id}`).set(auth(tk.admLeste))).status, 200);
  assert.equal((await request(app).delete(`/postos/${ids.posto3}/bloqueios/${b.body.id}`).set(auth(tk.admLeste))).status, 404);
});

test('T4 pedido de outra data: só o dono, um por vez, unidade aceita (remarca) ou recusa com motivo', async () => {
  // libera mais vagas para a semana seguinte
  await request(app).put(`/postos/${ids.posto3}/horarios`).set(auth(tk.admLeste)).send({ horarios: [
    { dia_semana: diaSemana(t3.dia), turno: 'manha', abre: '08:00', fecha: '12:00', vagas: 1 },
    { dia_semana: diaSemana(t3.dia), turno: 'tarde', abre: '13:00', fecha: '17:00', vagas: 2 },
  ] }).expect(200);
  const novaData = somar(t3.dia, 7);

  const op = await request(app).get(`/meus-agendamentos/${ids.agT}/opcoes`).set(auth(tk.pacA));
  assert.equal(op.status, 200);
  assert.ok(op.body.some((o) => o.data === t3.dia && o.turno === 'tarde'));
  assert.ok(!op.body.some((o) => o.data === t3.dia && o.turno === 'manha'), 'o turno atual não é opção');
  assert.equal((await request(app).get(`/meus-agendamentos/${ids.agT}/opcoes`).set(auth(tk.pacB))).status, 404);

  const pedir = (corpo, token = tk.pacA) => request(app).post(`/meus-agendamentos/${ids.agT}/outra-data`).set(auth(token)).send(corpo);
  assert.equal((await pedir({ data: novaData, turno: 'tarde' }, tk.pacB)).status, 404);
  assert.equal((await pedir({ data: novaData })).status, 400);
  assert.equal((await pedir({ data: t3.dia, turno: 'manha' })).status, 400);
  assert.equal((await pedir({ data: somar(t3.dia, 1), turno: 'manha' })).status, 409); // não atende
  const p1 = await pedir({ data: novaData, turno: 'tarde', motivo: 'Consulta no mesmo dia' });
  assert.equal(p1.status, 201, JSON.stringify(p1.body));
  assert.equal((await pedir({ data: somar(novaData, 7), turno: 'tarde' })).status, 409);

  const pend = await request(app).get('/agendamentos?pedido=pendente').set(auth(tk.admLeste));
  assert.equal(pend.status, 200);
  const lista = pend.body.dados ?? pend.body;
  const item = lista.find((a) => a.sol_id === ids.agT);
  assert.ok(item, 'aparece na aba de pedidos');
  assert.equal(item.pedido_outra_data.situacao, 'pedido');

  // recusa exige motivo; outra unidade não responde
  const responder = (corpo, token = tk.admLeste) => request(app).patch(`/agendamentos/${ids.agT}/pedido-outra-data`).set(auth(token)).send(corpo);
  assert.equal((await responder({ aceitar: false })).status, 400);
  assert.equal((await responder({ aceitar: true }, tk.adm)).status, 403);
  const recusa = await responder({ aceitar: false, resposta: 'Sem vaga para a sua necessidade' });
  assert.equal(recusa.status, 200, JSON.stringify(recusa.body));
  assert.equal((await knex('solicitacao').where('sol_id', ids.agT).first()).sol_pedido_situacao, 'recusado');
  assert.equal((await notifs('PACIENTE', ids.pacA, 'outra_data_recusada')).length, 1);
  assert.equal((await responder({ aceitar: true })).status, 409);

  // novo pedido e aceite: vira remarcação, presença zerada
  await knex('solicitacao').where('sol_id', ids.agT).update({ sol_presenca: 'vou' });
  assert.equal((await pedir({ data: novaData, turno: 'tarde' })).status, 201);
  const aceite = await responder({ aceitar: true });
  assert.equal(aceite.status, 200, JSON.stringify(aceite.body));
  const linha = await knex('solicitacao').where('sol_id', ids.agT).first();
  assert.equal(linha.sol_pedido_situacao, 'aceito');
  assert.equal(linha.sol_turno, 'tarde');
  assert.equal(new Date(linha.sol_data_de_coleta).toISOString().slice(0, 10), novaData);
  assert.equal(linha.sol_presenca, null);
  const hist = await knex('historico_solicitacao').where('sol_id', ids.agT);
  assert.ok(hist.some((h) => /pedido do paciente/.test(h.his_detalhe ?? '')));
});

test('T5 presença: paciente confirma ou avisa; tarefa pergunta 2 dias antes, uma vez só', async () => {
  const { perguntarPresenca } = await import(pathToFileURL(path.join(BACKEND, 'src/notificacoes/tarefas.js')).href);
  const presenca = (resposta, token = tk.pacA) => request(app).patch(`/meus-agendamentos/${ids.agT}/presenca`).set(auth(token)).send({ resposta });
  assert.equal((await presenca('talvez')).status, 400);
  assert.equal((await presenca('vou', tk.pacB)).status, 404);

  const data = somar(t3.dia, 7);
  const antes = (await notifs('PACIENTE', ids.pacA, 'confirmar_presenca')).length;
  await perguntarPresenca(somar(data, -2));
  await perguntarPresenca(somar(data, -2));
  assert.equal((await notifs('PACIENTE', ids.pacA, 'confirmar_presenca')).length, antes + 1);

  const nao = await presenca('nao_vou');
  assert.equal(nao.status, 200, JSON.stringify(nao.body));
  assert.equal((await knex('solicitacao').where('sol_id', ids.agT).first()).sol_presenca, 'nao_vou');
  const lista = await request(app).get('/agendamentos').set(auth(tk.admLeste));
  const item = (lista.body.dados ?? lista.body).find((a) => a.sol_id === ids.agT);
  assert.equal(item.sol_presenca, 'nao_vou');

  // depois de responder, a tarefa não pergunta de novo
  await knex('notificacao').where({ not_evento: 'confirmar_presenca', not_dest_id: ids.pacA }).del();
  await perguntarPresenca(somar(data, -2));
  assert.equal((await notifs('PACIENTE', ids.pacA, 'confirmar_presenca')).length, 0);

  // paciente cancela: vaga liberada, não dá mais para responder presença
  const cancel = await request(app).patch(`/meus-agendamentos/${ids.agT}/cancelar`).set(auth(tk.pacA)).send({ motivo: 'Mudei de cidade' });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
  assert.equal((await knex('solicitacao').where('sol_id', ids.agT).first()).sol_status, 'cancelado');
  assert.equal((await presenca('vou')).status, 409);
});

test('T6 prioridade legal: 80+ primeiro, depois 60+/PcD conferida, depois os demais', async () => {
  const anos = (n) => `${Number(hoje.slice(0, 4)) - n}${hoje.slice(4)}`;
  const novoPac = async (nome, extra) => (await knex('pacientes').insert({ pac_nome: nome, pac_email: `${nome}@t.com`, ...extra }).returning('pac_id'))[0].pac_id;
  const comum = await novoPac('comum', { pac_data_nasc: anos(30) });
  const pcd = await novoPac('pcd', { pac_data_nasc: anos(30) });
  const idoso = await novoPac('idoso', { pac_data_nasc: anos(85) });
  const sols = {};
  for (const [nome, pac_id] of [['comum', comum], ['pcd', pcd], ['idoso', idoso]]) {
    const [s] = await knex('solicitacao').insert({ pac_id, pos_id: ids.posto1, sol_status: 'Pendente', sol_prescricao: Buffer.from(nome) }).returning('sol_id');
    sols[nome] = s.sol_id;
  }
  const tkPcd = jwt.sign({ id: pcd, tipo: 'PACIENTE' }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '1h' });

  const ordem = async () => {
    const r = await request(app).get('/pendentes').set(auth(tk.adm));
    assert.equal(r.status, 200);
    return r.body.filter((s) => Object.values(sols).includes(s.sol_id)).map((s) => [s.sol_id, s.prioridade?.grupo]);
  };
  // PcD declarada mas não conferida ainda não passa na frente
  const decl = await request(app).patch('/pacientes/minha-prioridade').set(auth(tkPcd)).send({ pcd: true, gestante: false });
  assert.equal(decl.status, 200, JSON.stringify(decl.body));
  assert.equal(decl.body.prioridade.aguardando_conferencia, true);
  assert.deepEqual(await ordem(), [[sols.idoso, 1], [sols.comum, 3], [sols.pcd, 3]]);

  assert.equal((await request(app).patch(`/pacientes/${comum}/prioridade`).set(auth(tk.adm)).send({ conferida: true })).status, 409);
  const conf = await request(app).patch(`/pacientes/${pcd}/prioridade`).set(auth(tk.adm)).send({ conferida: true });
  assert.equal(conf.status, 200, JSON.stringify(conf.body));
  assert.equal(conf.body.prioridade.motivo, 'pcd');
  assert.deepEqual(await ordem(), [[sols.idoso, 1], [sols.pcd, 2], [sols.comum, 3]]);
  const resumo = await request(app).get(`/pacientes/${pcd}/resumo`).set(auth(tk.adm));
  assert.equal(resumo.body.paciente.prioridade.grupo, 2);

  // mudar a declaração volta para "aguardando conferência"
  await request(app).patch('/pacientes/minha-prioridade').set(auth(tkPcd)).send({ pcd: true, gestante: true }).expect(200);
  assert.equal((await knex('pacientes').where('pac_id', pcd).first()).pac_prioridade_conferida, null);
  assert.equal((await request(app).patch('/pacientes/minha-prioridade').set(auth(tkPcd)).send({ pcd: 'sim' })).status, 400);
});

// ------------------------------------------------------------------
// Etapa 4 — Pessoas autorizadas, quem retirou e "Meus insumos"
// ------------------------------------------------------------------

test('U1 pessoas autorizadas: só a unidade do paciente cadastra, valida, limita e desativa', async () => {
  // paciente atendido só no posto 2: o admin do posto 1 não edita
  const [norte] = await knex('pacientes').insert({ pac_nome: 'Carlos Norte', pac_cpf: '935.411.347-80' }).returning('pac_id');
  ids.pacNorte = norte.pac_id;
  await knex('solicitacao').insert({ pac_id: ids.pacNorte, pos_id: ids.posto2, sol_status: 'Pendente' });
  const pessoa = { nome: 'Maria Lima', cpf: '390.533.447-05', parentesco: 'filha', telefone: '(24) 99999-1234' };
  const semVinculo = await request(app).post(`/pacientes/${ids.pacNorte}/autorizados`).set(auth(tk.adm)).send(pessoa);
  assert.equal(semVinculo.status, 403);
  assert.equal((await request(app).post(`/pacientes/${ids.pacNorte}/autorizados`).set(auth(tk.admNorte)).send(pessoa)).status, 201);
  const lista0 = await request(app).get(`/pacientes/${ids.pacNorte}/autorizados`).set(auth(tk.adm));
  assert.equal(lista0.body.pode_editar, false);

  const url = `/pacientes/${ids.pacA}/autorizados`;
  const invalidos = [
    [{ ...pessoa, nome: 'Maria' }, /sobrenome/],
    [{ ...pessoa, cpf: '111.111.111-11' }, /CPF inválido/],
    [{ ...pessoa, cpf: '529.982.247-25' }, /próprio paciente/],
    [{ ...pessoa, telefone: '123' }, /Telefone/],
  ];
  for (const [corpo, msg] of invalidos) {
    const r = await request(app).post(url).set(auth(tk.adm)).send(corpo);
    assert.equal(r.status, 400, JSON.stringify(corpo));
    assert.match(r.body.error, msg);
  }
  const ok = await request(app).post(url).set(auth(tk.adm)).send({ ...pessoa, cpf: '39053344705' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.pau_cpf, '390.533.447-05');
  ids.pau = ok.body.pau_id;
  assert.equal((await request(app).post(url).set(auth(tk.adm)).send(pessoa)).status, 409);

  const editar = await request(app).put(`${url}/${ids.pau}`).set(auth(tk.adm)).send({ ...pessoa, parentesco: 'cuidadora' });
  assert.equal(editar.status, 200);
  assert.equal(editar.body.pau_parentesco, 'cuidadora');

  // paciente vê os próprios; não acessa a rota da unidade
  const meus = await request(app).get('/meus-autorizados').set(auth(tk.pacA));
  assert.deepEqual(meus.body.map((a) => a.pau_nome), ['Maria Lima']);
  assert.equal((await request(app).get('/meus-autorizados').set(auth(tk.pacB))).body.length, 0);
  assert.equal((await request(app).post(url).set(auth(tk.pacA)).send(pessoa)).status, 403);

  // limite de 5 ativas
  const cpfs = ['153.509.460-56', '111.444.777-35', '935.411.347-80', '714.602.380-01'];
  for (const cpf of cpfs) await request(app).post(url).set(auth(tk.adm)).send({ ...pessoa, nome: 'Outra Pessoa', cpf }).expect(201);
  const sexto = await request(app).post(url).set(auth(tk.adm)).send({ ...pessoa, nome: 'Sexta Pessoa', cpf: '248.438.034-80' });
  assert.equal(sexto.status, 409);
  const ultimo = (await request(app).get(url).set(auth(tk.adm))).body.autorizados.at(-1);
  assert.equal((await request(app).delete(`${url}/${ultimo.pau_id}`).set(auth(tk.adm))).status, 200);
  assert.equal((await request(app).delete(`${url}/${ultimo.pau_id}`).set(auth(tk.adm))).status, 404);
  assert.equal((await request(app).get(url).set(auth(tk.adm))).body.autorizados.length, 4);
  // o universal edita qualquer paciente
  assert.equal((await request(app).get(`/pacientes/${ids.pacNorte}/autorizados`).set(auth(tk.admMesmoId))).body.pode_editar, true);
});

test('U2 retirada por pessoa autorizada: aparece no atendimento, fica registrada e no histórico', async () => {
  const ag = await request(app).post('/agendamentos').set(auth(tk.adm))
    .send(novoAg({ sol_origem_id: undefined, itens: [{ ins_id: ids.bolsa, quantidade: 1 }] }));
  assert.equal(ag.status, 201, JSON.stringify(ag.body));
  const atend = await request(app).get(`/agendamentos/${ag.body.sol_id}/atendimento`).set(auth(tk.adm));
  assert.ok(atend.body.autorizados.some((a) => a.pau_id === ids.pau && a.pau_cpf_parcial === '390.***.***-05'));

  // pessoa de outro paciente é recusada
  const [outra] = await knex('paciente_autorizado').insert({ pac_id: ids.pacB, pau_nome: 'Fulano Tal', pau_cpf: '153.509.460-56' }).returning('pau_id');
  const errado = await request(app).patch(`/agendamentos/${ag.body.sol_id}/concluir`).set(auth(tk.adm)).send({ retirado_por: outra.pau_id });
  assert.equal(errado.status, 400);
  assert.equal((await knex('solicitacao').where('sol_id', ag.body.sol_id).first()).sol_status, 'agendado');

  const ok = await request(app).patch(`/agendamentos/${ag.body.sol_id}/concluir`).set(auth(tk.adm)).send({ retirado_por: ids.pau });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const linha = await knex('solicitacao').where('sol_id', ag.body.sol_id).first();
  assert.equal(linha.sol_retirado_por, ids.pau);
  assert.equal(linha.sol_retirado_por_nome, 'Maria Lima');
  const hist = await knex('historico_solicitacao').where({ sol_id: ag.body.sol_id, his_acao: 'concluida' }).first();
  assert.match(hist?.his_detalhe ?? '', /Retirado por Maria Lima \(cuidadora\)/);
  const lista = await request(app).get('/meus-agendamentos').query({ sol_id: ag.body.sol_id }).set(auth(tk.pacA));
  assert.equal(lista.body.itens[0].sol_retirado_por_nome, 'Maria Lima');
});

test('U3 meus insumos: só prescrições autorizadas e válidas, com "indisponível" quando falta', async () => {
  const [pouco] = await knex('insumo').insert({ ins_nome: 'Gaze estéril', ins_quantidade: 3, pos_id: ids.posto1 }).returning('ins_id');
  const sol = await novaPrescricao();
  await request(app).patch(`/solicitacao/${sol}`).set(auth(tk.adm)).send({
    sol_status: 'Revisado', sol_data_vencimento: somar(hoje, 60), sol_periodicidade_dias: 30,
    itens: [{ ins_id: ids.bolsa, quantidade: 2 }, { ins_id: pouco.ins_id, quantidade: 5 }],
  }).expect(200);
  // ainda não autorizada: não aparece
  assert.ok(!(await request(app).get('/meus-insumos').set(auth(tk.pacA))).body.some((p) => p.sol_id === sol));
  await request(app).patch(`/autorizador/solicitacao/${sol}`).set(auth(tk.aut)).send({ sol_status: 'Autorizado' }).expect(200);

  const r = await request(app).get('/meus-insumos').set(auth(tk.pacA));
  assert.equal(r.status, 200);
  const p = r.body.find((x) => x.sol_id === sol);
  assert.equal(p.sol_periodicidade_dias, 30);
  assert.deepEqual(p.itens.map((i) => [i.ins_nome, i.situacao]), [['Bolsa de colostomia', 'disponivel'], ['Gaze estéril', 'indisponivel']]);
  assert.equal(p.itens[0].ins_quantidade, undefined, 'o paciente não vê o número do estoque');

  // a reserva do próprio agendamento não deixa o insumo "indisponível" para ele
  await knex('insumo').where('ins_id', pouco.ins_id).update({ ins_quantidade: 5 });
  await request(app).post('/agendamentos').set(auth(tk.adm))
    .send(novoAg({ sol_origem_id: sol, itens: [{ ins_id: pouco.ins_id, quantidade: 5 }] })).expect(201);
  const depois = (await request(app).get('/meus-insumos').set(auth(tk.pacA))).body.find((x) => x.sol_id === sol);
  assert.equal(depois.itens.find((i) => i.ins_id === pouco.ins_id).situacao, 'disponivel');
  assert.ok(depois.agendamento?.sol_id);

  // vencida some; outro paciente não vê
  await knex('solicitacao').where('sol_id', sol).update({ sol_data_vencimento: ontem });
  assert.ok(!(await request(app).get('/meus-insumos').set(auth(tk.pacA))).body.some((x) => x.sol_id === sol));
  assert.equal((await request(app).get('/meus-insumos').set(auth(tk.adm))).status, 403);
});

// ------------------------------------------------------------------
// Etapa 5: lista de separação do dia e previsão de demanda
// ------------------------------------------------------------------

// Posto Sul, isolado dos outros testes, com coletas e prescrições montadas no banco
const sul = {};
const agSul = async ({ pac_id, data, turno = 'manha', status = 'agendado', presenca = null, origem = null, itens }) => {
  const [s] = await knex('solicitacao').insert({
    pac_id, pos_id: sul.pos_id, sol_status: status, sol_data_de_coleta: data, sol_turno: turno,
    sol_presenca: presenca, sol_origem_id: origem, sol_insumo_quant: 0,
  }).returning('sol_id');
  await knex('solicitacao').where('sol_id', s.sol_id).update({ sol_protocolo: `AG${String(s.sol_id).padStart(6, '0')}` });
  await knex('coleta').insert(itens.map(([ins_id, quantidade]) => ({ sol_id: s.sol_id, ins_id, quantidade })));
  return s.sol_id;
};
const prescSul = async ({ periodicidade = null, vencimento, itens }) => {
  const [s] = await knex('solicitacao').insert({
    pac_id: ids.pacA, pos_id: sul.pos_id, sol_status: 'Autorizado', sol_data_vencimento: vencimento,
    sol_periodicidade_dias: periodicidade, sol_insumo_quant: 0,
  }).returning('sol_id');
  await knex('solicitacao_item').insert(itens.map(([ins_id, q]) => ({ sol_id: s.sol_id, ins_id, sit_quantidade: q })));
  return s.sol_id;
};

test('V1 lista de separação: total por insumo e lista por paciente, só da unidade', async () => {
  const [p] = await knex('postosdesaude').insert({ pos_nome: 'Posto Sul' }).returning('pos_id');
  sul.pos_id = p.pos_id;
  sul.tk = jwt.sign({ email: 'sul@teste.com', posto_id: sul.pos_id, tp_universal: false, tipo: 'ADMIN' },
    process.env.ACCESS_TOKEN_SECRET, { expiresIn: '1h' });
  sul.universal = jwt.sign({ email: 'geral@teste.com', posto_id: null, tp_universal: true, tipo: 'ADMIN' },
    process.env.ACCESS_TOKEN_SECRET, { expiresIn: '1h' });
  const [luva] = await knex('insumo').insert({ ins_nome: 'Luva', ins_quantidade: 10, pos_id: sul.pos_id }).returning('ins_id');
  const [ser] = await knex('insumo').insert({ ins_nome: 'Seringa', ins_quantidade: 100, pos_id: sul.pos_id }).returning('ins_id');
  sul.luva = luva.ins_id; sul.seringa = ser.ins_id;

  await agSul({ pac_id: ids.pacB, data: amanha, turno: 'tarde', presenca: 'nao_vou', itens: [[sul.luva, 3], [sul.seringa, 2]] });
  await agSul({ pac_id: ids.pacA, data: amanha, itens: [[sul.luva, 4]] });
  await agSul({ pac_id: ids.pacA, data: amanha, status: 'concluido', itens: [[sul.seringa, 1]] });
  await agSul({ pac_id: ids.pacA, data: amanha, status: 'cancelado', itens: [[sul.luva, 50]] });

  const r = await request(app).get(`/agendamentos/separacao?data=${amanha}`).set(auth(sul.tk));
  assert.equal(r.status, 200);
  assert.equal(r.body.data, amanha);
  assert.equal(r.body.unidades.length, 1);
  const u = r.body.unidades[0];
  assert.equal(u.pos_nome, 'Posto Sul');
  assert.deepEqual(u.por_insumo.map((i) => [i.ins_nome, i.separar, i.nao_vai, i.entregue]),
    [['Luva', 4, 3, 0], ['Seringa', 0, 2, 1]]);
  assert.deepEqual(u.por_paciente.map((x) => [x.turno, x.primeiro_nome, x.situacao]),
    [['manha', 'Ana', 'separar'], ['manha', 'Ana', 'entregue'], ['tarde', 'Bruno', 'nao_vai']]);
  assert.equal(u.por_paciente[0].pac_cpf, undefined, 'a lista impressa não leva CPF');

  // admin de outra unidade não vê; universal escolhe a unidade
  const outro = await request(app).get(`/agendamentos/separacao?data=${amanha}`).set(auth(tk.adm));
  assert.ok(!outro.body.unidades.some((x) => x.pos_id === sul.pos_id));
  const geral = await request(app).get(`/agendamentos/separacao?data=${amanha}&pos_id=${sul.pos_id}`).set(auth(sul.universal));
  assert.deepEqual(geral.body.unidades.map((x) => x.pos_id), [sul.pos_id]);

  assert.equal((await request(app).get('/agendamentos/separacao?data=31/12/2026').set(auth(sul.tk))).status, 400);
  assert.equal((await request(app).get(`/agendamentos/separacao?data=${amanha}`).set(auth(tk.pacA))).status, 403);
});

test('V2 previsão de demanda: agendadas + ciclos futuros + a agendar + média das avulsas', async () => {
  // uso contínuo a cada 10 dias, última retirada há 5 dias, vence em 25 dias:
  // ciclos em +5, +15 e +25 (2 luvas cada)
  const continua = await prescSul({ periodicidade: 10, vencimento: somar(hoje, 25), itens: [[sul.luva, 2]] });
  await agSul({ pac_id: ids.pacA, data: somar(hoje, -5), status: 'concluido', origem: continua, itens: [[sul.luva, 2]] });
  // autorizada e ainda não agendada: 5 seringas
  await prescSul({ vencimento: somar(hoje, 60), itens: [[sul.seringa, 5]] });
  // avulsa concluída há 10 dias: 9 seringas em 90 dias = 3 em 30 dias
  await agSul({ pac_id: ids.pacB, data: somar(hoje, -10), status: 'concluido', itens: [[sul.seringa, 9]] });

  const r = await request(app).get('/indicadores/previsao?dias=30').set(auth(sul.tk));
  assert.equal(r.status, 200);
  assert.equal(r.body.dias, 30);
  const [luva, seringa] = r.body.insumos;
  assert.equal(luva.ins_nome, 'Luva', 'ordenado pela falta');
  assert.deepEqual([luva.estoque, luva.agendado, luva.recorrente, luva.a_agendar, luva.avulso, luva.necessidade, luva.falta],
    [10, 7, 6, 0, 0, 13, 3]);
  // 4 + 3 amanhã, +2 em +5 = 9, +2 em +15 = 11 > 10
  assert.equal(luva.acaba_em, somar(hoje, 15));
  assert.deepEqual([seringa.agendado, seringa.a_agendar, seringa.avulso, seringa.necessidade, seringa.falta, seringa.acaba_em],
    [2, 5, 3, 10, 0, null]);

  // 60 dias: o vencimento corta os ciclos (continua 6 luvas) e a média dobra
  const r60 = await request(app).get('/indicadores/previsao?dias=60').set(auth(sul.tk));
  const s60 = r60.body.insumos.find((i) => i.ins_id === sul.seringa);
  assert.equal(r60.body.insumos.find((i) => i.ins_id === sul.luva).recorrente, 6);
  assert.equal(s60.avulso, 6);

  // cada admin vê só a própria unidade; o universal vê todas
  const doCentro = await request(app).get('/indicadores/previsao?dias=30').set(auth(tk.adm));
  assert.ok(doCentro.body.insumos.every((i) => i.pos_id === ids.posto1));
  const todas = await request(app).get('/indicadores/previsao?dias=30').set(auth(sul.universal));
  assert.ok(new Set(todas.body.insumos.map((i) => i.pos_id)).size >= 2);

  assert.equal((await request(app).get('/indicadores/previsao?dias=45').set(auth(sul.tk))).status, 400);
  assert.equal((await request(app).get('/indicadores/previsao?dias=30').set(auth(tk.pacA))).status, 403);
});
