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
// REGEXP_REPLACE(texto, padrão, troca, 'g') usado na matrícula
db.public.registerFunction({ name: 'regexp_replace', args: ['text', 'text', 'text', 'text'], returns: 'text', implementation: (a, b, c, f) => a == null ? null : a.replace(new RegExp(b, f), c) });
db.public.none(`
  create table postosdesaude (pos_id serial primary key, pos_nome text, pos_endereco text, pos_latitude float, pos_longitude float);
  create table pacientes (pac_id serial primary key, pac_nome text, pac_email text, pac_senha text, pac_cpf text,
    pac_telefone text, pac_cep text, pac_data_nasc date, pac_endereco text, pac_sexo text, pac_raca text, pac_avatar text);
  create table administrador (adm_matricula text, adm_nome text, adm_email text, adm_tel text,
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
    const r = await request(app).post('/administrador').send({ ...base, matricula, email: 'rui@teste.com', cpf: '879.376.059-01' });
    assert.equal(r.status, 400, `matrícula ${JSON.stringify(matricula)}`);
  }

  const ok = await request(app).post('/administrador').send({ ...base, matricula: ' sms-1234 ', email: 'rui@teste.com', cpf: '879.376.059-01', tp_universal: true });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const rui = await knex('administrador').where('adm_email', 'rui@teste.com').first();
  assert.equal(rui.adm_matricula, 'SMS-1234');
  assert.equal(rui.tp_universal, false, 'universal nunca vem do formulário');

  // mesma matrícula escrita de outro jeito (minúsculas, espaço, sem separador)
  for (const matricula of ['sms1234', 'SMS 1234', 'sms/1234']) {
    const dup = await request(app).post('/administrador').send({ ...base, matricula, email: 'rui2@teste.com', cpf: '300.264.746-20' });
    assert.equal(dup.status, 409, matricula);
    assert.ok(dup.body.erros.includes('Matrícula já cadastrada.'));
  }

  const postoRuim = await request(app).post('/administrador').send({ ...base, posto_id: 9999, matricula: 'B-77', email: 'rui3@teste.com', cpf: '300.264.746-20' });
  assert.equal(postoRuim.status, 400);
  const postoTexto = await request(app).post('/administrador').send({ ...base, posto_id: 'abc', matricula: 'B-77', email: 'rui3@teste.com', cpf: '300.264.746-20' });
  assert.equal(postoTexto.status, 400);

  const emailPaciente = await request(app).post('/administrador').send({ ...base, matricula: 'B-78', email: 'ana@teste.com', cpf: '300.264.746-20' });
  assert.equal(emailPaciente.status, 409);
  assert.ok(emailPaciente.body.erros.includes('E-mail já cadastrado.'));

  const autEmailUsado = await request(app).post('/autorizador').send({ nome: 'Ivo Reis', email: 'rui@teste.com', telefone: '24991234567', cpf: '300.264.746-20', senha: 'Senha@123', confirmacao_senha: 'Senha@123' });
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
