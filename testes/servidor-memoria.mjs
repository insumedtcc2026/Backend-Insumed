// Backend local com banco EM MEMÓRIA (pg-mem) e dados fictícios, para testar
// o site inteiro sem tocar no Neon. Os dados somem ao parar o servidor.
// Uso: npm run dev:memoria   (e no frontend: VITE_API_URL=http://localhost:3344)
//
// Contas de teste (todas com a senha Teste@1234):
//   paciente     ana.teste@insumed.test
//   admin        admin.teste@insumed.test
//   autorizador  aut.teste@insumed.test
import { mock } from 'node:test';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { newDb } from 'pg-mem';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireBackend = createRequire(path.join(BACKEND, 'package.json'));
const bcrypt = requireBackend('bcrypt');

process.env.ACCESS_TOKEN_SECRET = 'segredo-local-de-teste';
// tarefa diária local: GET /tarefas/diaria com Authorization: Bearer cron-local
process.env.CRON_SECRET = process.env.CRON_SECRET || 'cron-local';

const db = newDb();
db.public.registerFunction({ name: 'replace', args: ['text', 'text', 'text'], returns: 'text', implementation: (a, b, c) => (a == null ? null : a.split(b).join(c)) });
// REGEXP_REPLACE(texto, padrão, troca, 'g') usado na matrícula
db.public.registerFunction({ name: 'regexp_replace', args: ['text', 'text', 'text', 'text'], returns: 'text', implementation: (a, b, c, f) => a == null ? null : a.replace(new RegExp(b, f), c) });
// gen_random_uuid() é nativo no Postgres 13+ (Neon)
db.public.registerFunction({ name: 'trim', args: ['text'], returns: 'text', implementation: (a) => (a == null ? null : a.trim()) });
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
  create table coleta (sol_id int, ins_id int, quantidade int);
`);
db.public.none(
  fs.readFileSync(path.join(BACKEND, 'database/migracoes/2026-10-13_melhorias_insumed.sql'), 'utf8')
    .replace(/^\s*(BEGIN|COMMIT);\s*$/gm, '').replace(/^--.*$/gm, '')
);
// pg-mem usa o índice parcial de forma errada (some com os cancelados); ver api.test.mjs
db.public.none('DROP INDEX ux_solicitacao_origem_ativa; CREATE INDEX ix_teste_origem ON solicitacao (sol_origem_id);');
// migração de 15/10: só o trecho que o pg-mem executa
const migracao2 = fs.readFileSync(path.join(BACKEND, 'database/migracoes/2026-10-15_reenvio_e_cadastros.sql'), 'utf8');
db.public.none(
  migracao2.slice(migracao2.indexOf('-- @pgmem-inicio'), migracao2.indexOf('-- @pgmem-fim')).replace(/^--.*$/gm, '')
);
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

// ---- dados de teste ----
const credenciais = {
  senha: 'Teste@1234',
  paciente: 'ana.teste@insumed.test',
  admin: 'admin.teste@insumed.test',
  autorizador: 'aut.teste@insumed.test',
};
const senha = await bcrypt.hash(credenciais.senha, 4);
const hojeBR = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const daqui10 = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
// PNG 1x1 só para ter um arquivo de prescrição
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const [p1] = await knex('postosdesaude').insert({ pos_nome: 'UBS Centro', pos_endereco: 'Rua Central, 100', pos_latitude: -22.52, pos_longitude: -44.10 }).returning('pos_id');
const [p2] = await knex('postosdesaude').insert({ pos_nome: 'UBS Vila Nova', pos_endereco: 'Av. Brasil, 2000', pos_latitude: -22.50, pos_longitude: -44.08 }).returning('pos_id');
const [ana] = await knex('pacientes').insert({ pac_nome: 'Ana Paula Souza', pac_email: credenciais.paciente, pac_senha: senha, pac_cpf: '529.982.247-25', pac_telefone: '(24) 98888-7777', pac_cep: '27200-000', pac_data_nasc: '1985-04-12', pac_endereco: 'Rua das Flores, 45', pac_sexo: 'Feminino', pac_raca: 'Parda' }).returning('pac_id');
const [bruno] = await knex('pacientes').insert({ pac_nome: 'Bruno Henrique Lima', pac_email: 'bruno.teste@insumed.test', pac_senha: senha, pac_cpf: '111.444.777-35', pac_telefone: '(24) 97777-6666' }).returning('pac_id');
await knex('administrador').insert({ adm_matricula: 'A001', adm_nome: 'Marcos Admin Teste', adm_email: credenciais.admin, adm_senha: senha, adm_cpf: '390.533.447-05', adm_tel: '(24) 99999-0000', pos_id: p1.pos_id, tp_universal: true });
await knex('autorizador').insert({ aut_nome: 'Carla Autorizadora Teste', aut_email: credenciais.autorizador, aut_senha: senha, aut_cpf: '153.509.460-56', aut_tel: '(24) 99999-1111' });
const [fralda] = await knex('insumo').insert({ ins_nome: 'Fralda Geriátrica G', ins_quantidade: 40, ins_marca: 'Bigfral', pos_id: p1.pos_id }).returning('ins_id');
const [curativo] = await knex('insumo').insert({ ins_nome: 'Curativo Hidrocoloide', ins_quantidade: 3, ins_marca: 'DuoDERM', pos_id: p1.pos_id }).returning('ins_id');
await knex('insumo').insert({ ins_nome: 'Sonda Uretral nº 12', ins_quantidade: 0, ins_marca: 'Medsonda', pos_id: p1.pos_id });

const sol = (dados) => knex('solicitacao').insert({ sol_insumo_quant: 0, sol_prescricao: png, sol_prescricao_tipo: 'image/png', ...dados }).returning('sol_id').then((r) => r[0].sol_id);
await sol({ pac_id: ana.pac_id, pos_id: p1.pos_id, sol_status: 'Pendente', sol_observacao: 'Uso contínuo, troca 4x ao dia' });
await sol({ pac_id: bruno.pac_id, pos_id: p1.pos_id, sol_status: 'Pendente' });
await sol({ pac_id: ana.pac_id, pos_id: p1.pos_id, sol_status: 'Revisado', ins_id: curativo.ins_id, sol_insumo_quant: 2, sol_data_vencimento: daqui10 });
await sol({ pac_id: bruno.pac_id, pos_id: p1.pos_id, sol_status: 'Revisado', ins_id: fralda.ins_id, sol_insumo_quant: 30, sol_data_vencimento: daqui10 });
await sol({ pac_id: ana.pac_id, pos_id: p1.pos_id, sol_status: 'Autorizado', ins_id: fralda.ins_id, sol_insumo_quant: 10, sol_data_vencimento: daqui10 });
await sol({ pac_id: bruno.pac_id, pos_id: p1.pos_id, sol_status: 'Nao Autorizado', ins_id: fralda.ins_id, sol_insumo_quant: 90, sol_data_vencimento: daqui10, sol_motivo_nao_autorizado: 'Quantidade acima do protocolo mensal.' });

// agendamentos (fluxo antigo, sem vínculo)
for (const [pac, status, motivo, data] of [[ana.pac_id, 'agendado', null, amanha], [bruno.pac_id, 'concluido', null, amanha], [ana.pac_id, 'cancelado', null, amanha], [bruno.pac_id, 'agendado', null, hojeBR], [ana.pac_id, 'agendado', null, hojeBR], [bruno.pac_id, 'concluido', null, hojeBR]]) {
  const id = await sol({ pac_id: pac, pos_id: p1.pos_id, sol_status: status, sol_data_de_coleta: data, sol_prescricao: null, sol_prescricao_tipo: null, sol_motivo_cancelamento: motivo });
  await knex('solicitacao').where('sol_id', id).update({ sol_protocolo: `AG${String(id).padStart(6, '0')}`, sol_codigo_qr: randomUUID() });
  await knex('coleta').insert({ sol_id: id, ins_id: fralda.ins_id, quantidade: 5 });
}

// etapa 3: a UBS Centro atende todos os dias (para testar em qualquer dia),
// com vagas por turno; a UBS Vila Nova fica no horário padrão
for (let dia = 0; dia <= 6; dia++) {
  await knex('posto_horario').insert([
    { pos_id: p1.pos_id, phr_dia_semana: dia, phr_turno: 'manha', phr_abre: '08:00', phr_fecha: '12:00', phr_vagas: 6 },
    { pos_id: p1.pos_id, phr_dia_semana: dia, phr_turno: 'tarde', phr_abre: '13:00', phr_fecha: '17:00', phr_vagas: 4 },
  ]);
}
// a Ana pediu outra data para o agendamento de amanhã; o Bruno declarou deficiência
const [agAmanha] = await knex('solicitacao').where({ pac_id: ana.pac_id, sol_status: 'agendado', sol_data_de_coleta: amanha }).select('sol_id');
await knex('solicitacao').where('sol_id', agAmanha.sol_id).update({
  sol_turno: 'manha', sol_pedido_data: daqui10, sol_pedido_turno: 'tarde', sol_pedido_motivo: 'Tenho consulta no mesmo horário',
  sol_pedido_situacao: 'pedido', sol_pedido_em: new Date(),
});
await knex('pacientes').where('pac_id', bruno.pac_id).update({ pac_pcd: true });

// etapa 4: a filha da Ana pode retirar por ela; uma prescrição de uso
// contínuo com um insumo em falta (curativo: 3 no estoque, pede 5)
await knex('paciente_autorizado').insert({ pac_id: ana.pac_id, pau_nome: 'Juliana Souza', pau_cpf: '153.509.460-56', pau_parentesco: 'filha', pau_telefone: '(24) 98888-1111' });
const continua = await sol({ pac_id: ana.pac_id, pos_id: p1.pos_id, sol_status: 'Autorizado', ins_id: fralda.ins_id, sol_insumo_quant: 20, sol_data_vencimento: new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10), sol_periodicidade_dias: 30 });
await knex('solicitacao_item').insert([
  { sol_id: continua, ins_id: fralda.ins_id, sit_quantidade: 20 },
  { sol_id: continua, ins_id: curativo.ins_id, sit_quantidade: 5 },
]);

// etapa 5: retiradas avulsas dos últimos meses (histórico), um
// paciente que avisou que não vai amanhã e o estoque da UBS Vila Nova
const diasAtras = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
for (const [n, qtd] of [[12, 30], [35, 25], [61, 35], [80, 20]]) {
  const id = await sol({ pac_id: bruno.pac_id, pos_id: p1.pos_id, sol_status: 'concluido', sol_data_de_coleta: diasAtras(n), sol_prescricao: null, sol_prescricao_tipo: null });
  await knex('solicitacao').where('sol_id', id).update({ sol_protocolo: `AG${String(id).padStart(6, '0')}` });
  await knex('coleta').insert({ sol_id: id, ins_id: fralda.ins_id, quantidade: qtd });
}
const naoVai = await sol({ pac_id: bruno.pac_id, pos_id: p1.pos_id, sol_status: 'agendado', sol_data_de_coleta: amanha, sol_turno: 'tarde', sol_presenca: 'nao_vou', sol_prescricao: null, sol_prescricao_tipo: null });
await knex('solicitacao').where('sol_id', naoVai).update({ sol_protocolo: `AG${String(naoVai).padStart(6, '0')}`, sol_codigo_qr: randomUUID() });
await knex('coleta').insert([{ sol_id: naoVai, ins_id: fralda.ins_id, quantidade: 10 }, { sol_id: naoVai, ins_id: curativo.ins_id, quantidade: 2 }]);
await knex('insumo').insert([
  { ins_nome: 'Fralda Geriátrica G', ins_quantidade: 180, ins_marca: 'Bigfral', pos_id: p2.pos_id },
  { ins_nome: 'Luva de Procedimento M', ins_quantidade: 300, ins_marca: 'Descarpack', pos_id: p2.pos_id },
]);

await import(pathToFileURL(path.join(BACKEND, 'src/server.js')).href);
console.log('Backend local de teste pronto (pg-mem) em http://localhost:3344');
