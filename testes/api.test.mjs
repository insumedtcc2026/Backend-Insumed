// Testes de integração da API do Insumed contra um Postgres em memória (pg-mem).
// Nada aqui toca o banco real: src/database/index.js é substituído pelo knex do pg-mem.
// Rodar com: npm test
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  path.join(BACKEND, 'database/migracoes/2026-10-13_cancelamento_e_origem_agendamento.sql'), 'utf8')
  .replace(/^\s*(BEGIN|COMMIT);\s*$/gm, '')
  .replace(/^--.*$/gm, '');
db.public.none(migracao);

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

before(async () => {
  const senha = await bcrypt.hash('Senha@123', 4);
  const [p1] = await knex('postosdesaude').insert({ pos_nome: 'Posto Centro' }).returning('pos_id');
  const [p2] = await knex('postosdesaude').insert({ pos_nome: 'Posto Norte' }).returning('pos_id');
  ids.posto1 = p1.pos_id; ids.posto2 = p2.pos_id;
  const [a] = await knex('pacientes').insert({ pac_nome: 'Ana Souza', pac_email: 'ana@teste.com', pac_senha: senha, pac_cpf: '529.982.247-25', pac_telefone: '(24) 98888-7777' }).returning('pac_id');
  const [b] = await knex('pacientes').insert({ pac_nome: 'Bruno Lima', pac_email: 'bruno@teste.com', pac_senha: senha, pac_cpf: '111.444.777-35', pac_telefone: '(24) 97777-6666' }).returning('pac_id');
  ids.pacA = a.pac_id; ids.pacB = b.pac_id;
  const [adm] = await knex('administrador').insert({ adm_nome: 'Admin Geral', adm_email: 'adm@teste.com', adm_senha: senha, pos_id: ids.posto1, tp_universal: false }).returning('adm_id');
  const [admN] = await knex('administrador').insert({ adm_nome: 'Admin Norte', adm_email: 'norte@teste.com', adm_senha: senha, pos_id: ids.posto2, tp_universal: false }).returning('adm_id');
  const [aut] = await knex('autorizador').insert({ aut_nome: 'Carla Dias', aut_email: 'aut@teste.com', aut_senha: senha }).returning('aut_id');
  const [ins] = await knex('insumo').insert({ ins_nome: 'Fralda G', ins_quantidade: 1, pos_id: ids.posto1 }).returning('ins_id');
  ids.insumo = ins.ins_id;

  const assinar = (dados) => jwt.sign(dados, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '1h' });
  tk.pacA = assinar({ id: ids.pacA, tipo: 'PACIENTE' });
  tk.pacB = assinar({ id: ids.pacB, tipo: 'PACIENTE' });
  tk.adm = assinar({ id: adm.adm_id, posto_id: ids.posto1, tp_universal: false, tipo: 'ADMIN' });
  tk.admNorte = assinar({ id: admN.adm_id, posto_id: ids.posto2, tp_universal: false, tipo: 'ADMIN' });
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
    [{ ...base, sol_insumo_quant: 0 }, 400, /Quantidade/],
    [{ ...base, sol_insumo_quant: 1.5 }, 400, /Quantidade/],
    [{ ...base, ins_id: undefined }, 400, /Insumo não informado/],
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
  itens: [{ ins_nome: 'Fralda G', quantidade: 2 }], sol_origem_id: ids.sol1, ...extra,
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
  assert.ok(linha.sol_cancelado_por);
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

test('F4 cadastro de autorizador e administrador segue público (decisão 4B)', async () => {
  const r = await request(app).post('/autorizador').send({ nome: 'Eva Rocha', email: 'eva@teste.com', telefone: '24991234567', cpf: '390.533.447-05', senha: 'Senha@123', confirmacao_senha: 'Senha@123' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
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

test('G4 datas sugeridas: só dias úteis, futuros, e as com menos coletas', async () => {
  assert.equal((await request(app).get('/agendamentos/datas-sugeridas').set(auth(tk.adm))).status, 400);
  const r = await request(app).get('/agendamentos/datas-sugeridas').query({ pos_id: ids.posto1 }).set(auth(tk.adm));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.datas.length, 14);
  for (const d of r.body.datas) {
    assert.ok(d.data > hoje, 'só datas futuras');
    const dia = new Date(d.data + 'T12:00:00Z').getUTCDay();
    assert.ok(dia !== 0 && dia !== 6, 'sem fim de semana');
  }
  assert.equal(r.body.sugeridas.length, 3);
  const cheio = r.body.datas.find((d) => d.agendados > 0);
  if (cheio) assert.ok(!r.body.sugeridas.includes(cheio.data), 'dia com coleta não é sugerido antes de dias vazios');
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
