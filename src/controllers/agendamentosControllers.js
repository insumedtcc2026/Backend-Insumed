import knex from '../database/index.js';
export default {
async listar(req, res) {
try {
const { status, data, excluir_data, order } = req.query;
let query = knex('solicitacao as sol')
.join('pacientes as pac', 'pac.pac_id', 'sol.pac_id')//relacionamento
.join('postosdesaude as pos', 'pos.pos_id', 'sol.pos_id')//relacionamento
.select(
'sol.sol_id',
'sol.sol_data_de_coleta',
'sol.sol_status',
'pac.pac_id', 'pac.pac_nome', 'pac.pac_cpf', 'pac.pac_telefone',
'pos.pos_id', 'pos.pos_nome'
);
if (status) query = query.where('sol.sol_status', status);
if (data === 'hoje') query = query.whereRaw('sol.sol_data_de_coleta = CURRENT_DATE')
if (excluir_data === 'hoje') query = query.whereRaw('sol.sol_data_de_coleta != CURRENT_DATE');
if (order === 'proximidade') {
query = query.orderByRaw('ABS(sol_data_de_coleta - CURRENT_DATE)');
} else {
query = query.orderBy('sol.sol_data_de_coleta', 'asc');
}
const solicitacoes = await query;
return res.status(200).send(solicitacoes);
} catch (error) {
return res.status(500).send({ message: 'Erro ao buscar agendamentos', error: error.message });
}
},


async criar(req, res) {
    const trx = await knex.transaction();

    try {
        const { paciente, sol_data_de_coleta, posto, itens } = req.body;

        const [sol_id] = await trx('solicitacao')
            .insert({
                pac_id: paciente.pac_id,
                pos_id: posto.pos_id,
                sol_data_de_coleta,
                sol_status: 'agendado',
            })
            .returning('sol_id');

        const linhasColeta = itens.map((item) => ({
            sol_id: sol_id.sol_id ?? sol_id,
            ins_id: item.ins_id,
            sol_insumo_quan: item.quantidade,
        }));

        await trx('coleta').insert(linhasColeta);

        await trx.commit();

        return res.status(201).send({
            message: 'Agendamento criado com sucesso',
            sol_id: sol_id.sol_id ?? sol_id
        });

    } catch (error) {
        await trx.rollback();

        return res.status(500).send({
            message: 'Erro ao criar agendamento',
            error: error.message
        });
    }
},

async concluir(req, res) {
try {
await knex('solicitacao')
.where('sol_id', req.params.id)
.update({ sol_status: 'concluido' });
return res.status(200).send({ message: 'Agendamento concluído' });
} catch (error) {
return res.status(500).send({ message: 'Erro ao concluir agendamento', error: error.message });
}
},

async cancelar(req, res) {
try {
await knex('solicitacao')
.where('sol_id', req.params.id)
.update({ sol_status: 'cancelado' });
return res.status(200).send({ message: 'Agendamento cancelado' });
} catch (error) {
return res.status(500).send({ message: 'Erro ao cancelar agendamento', error: error.message });
}
},


async listarMeusAgendamentos(req, res) {
try {
if (req.session.tipo !== 'PACIENTE') {
return res.status(403).send({ error: 'Rota exclusiva de paciente' });
}
const { page = 1, porPagina = 4 } = req.query;
const offset = (page - 1) * porPagina;
const solicitacoes = await knex('solicitacao')
.where('pac_id', req.session.id) // vem do TOKEN, não da URL
.orderBy('sol_data_de_coleta', 'desc')
.limit(porPagina)
.offset(offset);
const [{ count }] = await knex('solicitacao')
.where('pac_id', req.session.id)
.count('* as count');
return res.status(200).send({
itens: solicitacoes,
paginaAtual: Number(page),
totalPaginas: Math.ceil(count / porPagina),
});
} catch (error) {
return res.status(500).send({ message: 'Erro ao buscar seus agendamentos', error: 
error.message });
}
},


};