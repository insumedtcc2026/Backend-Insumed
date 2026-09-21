import knex from '../database/index.js';

// Monta o protocolo de atendimento a partir do sol_id, ex: sol_id 42 -> "AG000042"
function gerarProtocolo(sol_id) {
    return `AG${String(sol_id).padStart(6, '0')}`;
}

// Agrupa as linhas "achatadas" do JOIN (uma linha por insumo) no formato
// aninhado que o frontend espera (um objeto por agendamento, com um
// array de insumos dentro).
function agruparPorAgendamento(resultado) {
    const mapa = new Map();

    resultado.forEach((linha) => {
        if (!mapa.has(linha.sol_id)) {
            mapa.set(linha.sol_id, {
                sol_id: linha.sol_id,
                sol_protocolo: linha.sol_protocolo,
                sol_data_de_coleta: linha.sol_data_de_coleta,
                status: linha.sol_status,

                paciente: {
                    pac_id: linha.pac_id,
                    pac_nome: linha.pac_nome,
                    pac_cpf: linha.pac_cpf,
                    pac_telefone: linha.pac_telefone
                },

                posto: {
                    pos_id: linha.pos_id,
                    pos_nome: linha.pos_nome
                },

                insumos: []
            });
        }

        const agendamento = mapa.get(linha.sol_id);

        if (linha.ins_id !== null) {
            agendamento.insumos.push({
                ins_id: linha.ins_id,
                ins_nome: linha.ins_nome,
                quantidade: linha.quantidade
            });
        }
    });

    return Array.from(mapa.values());
}

const SELECT_AGENDAMENTO = [
    'sol.sol_id',
    'sol.sol_protocolo',
    'sol.sol_data_de_coleta',
    'sol.sol_status',

    'pac.pac_id',
    'pac.pac_nome',
    'pac.pac_cpf',
    'pac.pac_telefone',

    'pos.pos_id',
    'pos.pos_nome',

    'ins.ins_id',
    'ins.ins_nome',

    'col.quantidade'
];

function baseQueryAgendamentos() {
    return knex('solicitacao as sol')
        .leftJoin('pacientes as pac', 'pac.pac_id', 'sol.pac_id')
        // permite manter as solicitações mesmo quando alguma informação relacionada não existe
        .leftJoin('postosdesaude as pos', 'pos.pos_id', 'sol.pos_id')
        .leftJoin('coleta as col', 'col.sol_id', 'sol.sol_id')
        .leftJoin('insumo as ins', 'ins.ins_id', 'col.ins_id')
        // a tabela solicitacao também guarda pedidos de prescrição (outro
        // status: Pendente/Aprovado/Reenvio) — nunca misturar com agendamento
        .whereIn('sol.sol_status', ['agendado', 'concluido', 'cancelado'])
        .select(SELECT_AGENDAMENTO);
}

export default {

    // LISTAR AGENDAMENTOS (visão do ADM)
    //
    // Página única do admin, com filtro de status, busca por nome/CPF/
    // protocolo e intervalo de data. Substitui as antigas páginas
    // separadas de "hoje", "todos" e "histórico".
    async listar(req, res) {
        try {
            const {
                status,       // 'agendado' | 'concluido' | 'cancelado' | 'todos' | (vazio)
                busca,        // nome, CPF ou protocolo
                data_inicio,
                data_fim,
                // mantidos por compatibilidade com chamadas antigas:
                data,
                excluir_data,
                order
            } = req.query;

            let query = baseQueryAgendamentos();

            if (status && status !== 'todos') {
                query = query.where('sol.sol_status', status);
            }

            if (busca && busca.trim()) {
                const termo = busca.trim();
                const termoCpf = termo.replace(/\D/g, '');

                query = query.where((qb) => {
                    qb.whereILike('pac.pac_nome', `%${termo}%`)
                        .orWhereILike('sol.sol_protocolo', `%${termo}%`);

                    if (termoCpf) {
                        qb.orWhereRaw(
                            "REPLACE(REPLACE(pac.pac_cpf, '.', ''), '-', '') LIKE ?",
                            [`%${termoCpf}%`]
                        );
                    }
                });
            }

            if (data_inicio) {
                query = query.where('sol.sol_data_de_coleta', '>=', data_inicio);
            }

            if (data_fim) {
                query = query.where('sol.sol_data_de_coleta', '<=', data_fim);
            }

            // --- compatibilidade com o formato antigo (hoje / exceto hoje) ---
            if (data === 'hoje') {
                query = query.whereRaw('sol.sol_data_de_coleta = CURRENT_DATE');
            }
            if (excluir_data === 'hoje') {
                query = query.whereRaw('sol.sol_data_de_coleta != CURRENT_DATE');
            }

            if (order === 'proximidade') {
                query = query.orderByRaw('ABS(sol.sol_data_de_coleta - CURRENT_DATE)');
            } else {
                query = query.orderBy('sol.sol_data_de_coleta', 'asc');
            }

            const resultado = await query;

            return res.status(200).send(agruparPorAgendamento(resultado));

        } catch (error) {
            console.error('Erro ao buscar agendamentos:', error);

            return res.status(500).send({
                message: 'Erro ao buscar agendamentos',
                error: error.message
            });
        }
    },


    // CRIAR AGENDAMENTO
    async criar(req, res) {

        const trx = await knex.transaction();

        try {

            const { paciente, sol_data_de_coleta, posto, itens } = req.body;

            // VALIDAÇÕES

            if (!paciente || !paciente.pac_id) {
                await trx.rollback();
                return res.status(400).send({ message: 'Paciente não informado' });
            }

            if (!posto || !posto.pos_id) {
                await trx.rollback();
                return res.status(400).send({ message: 'Posto não informado' });
            }

            if (!sol_data_de_coleta) {
                await trx.rollback();
                return res.status(400).send({ message: 'Data de coleta não informada' });
            }

            if (!Array.isArray(itens) || itens.length === 0) {
                await trx.rollback();
                return res.status(400).send({ message: 'Nenhum insumo informado' });
            }

            for (const item of itens) {
                if (!item.ins_nome || !String(item.ins_nome).trim() || !item.quantidade) {
                    await trx.rollback();
                    return res.status(400).send({
                        message: 'Cada insumo precisa de nome e quantidade'
                    });
                }
            }

            // CRIAR SOLICITAÇÃO

            const resultado = await trx('solicitacao')
                .insert({
                    pac_id: paciente.pac_id,
                    pos_id: posto.pos_id,
                    sol_data_de_coleta,
                    sol_status: 'agendado',
                    sol_insumo_quant: 0
                })
                .returning('sol_id');

            const sol_id =
                typeof resultado[0] === 'object' ? resultado[0].sol_id : resultado[0];

            // GERAR PROTOCOLO DE ATENDIMENTO
            // Só dá pra montar depois de saber o sol_id gerado, então é um
            // segundo passo (update), dentro da mesma transação.

            const protocolo = gerarProtocolo(sol_id);

            await trx('solicitacao')
                .where('sol_id', sol_id)
                .update({ sol_protocolo: protocolo });

            // CRIAR ITENS DA COLETA
            // O admin digita o nome do produto (não escolhe um já
            // cadastrado). Por isso, pra cada item: se já existir um
            // insumo com esse nome (ignorando maiúsculas/minúsculas),
            // reaproveita o ins_id dele; senão, cria um insumo novo.

            const linhasColeta = [];

            for (const item of itens) {
                const nome = String(item.ins_nome).trim();

                let insumoExistente = await trx('insumo')
                    .whereRaw('LOWER(ins_nome) = LOWER(?)', [nome])
                    .first();

                let ins_id;

                if (insumoExistente) {
                    ins_id = insumoExistente.ins_id;
                } else {
                    const novoInsumo = await trx('insumo')
                        .insert({ ins_nome: nome, ins_quantidade: 0 })
                        .returning('ins_id');

                    ins_id =
                        typeof novoInsumo[0] === 'object' ? novoInsumo[0].ins_id : novoInsumo[0];
                }

                linhasColeta.push({ sol_id, ins_id, quantidade: item.quantidade });
            }

            await trx('coleta').insert(linhasColeta);

            await trx.commit();

            return res.status(201).send({
                message: 'Agendamento criado com sucesso',
                sol_id,
                sol_protocolo: protocolo
            });

        } catch (error) {
            await trx.rollback();

            console.error('Erro ao criar agendamento:', error);

            return res.status(500).send({
                message: 'Erro ao criar agendamento',
                error: error.message
            });
        }
    },


    // CONCLUIR AGENDAMENTO
    async concluir(req, res) {
        try {
            const { id } = req.params;

            const quantidadeAlterada = await knex('solicitacao')
                .where('sol_id', id)
                .update({ sol_status: 'concluido' });

            if (quantidadeAlterada === 0) {
                return res.status(404).send({ message: 'Agendamento não encontrado' });
            }

            return res.status(200).send({ message: 'Agendamento concluído' });

        } catch (error) {
            console.error('Erro ao concluir agendamento:', error);

            return res.status(500).send({
                message: 'Erro ao concluir agendamento',
                error: error.message
            });
        }
    },


    // CANCELAR AGENDAMENTO
    async cancelar(req, res) {
        try {
            const { id } = req.params;

            const quantidadeAlterada = await knex('solicitacao')
                .where('sol_id', id)
                .update({ sol_status: 'cancelado' });

            if (quantidadeAlterada === 0) {
                return res.status(404).send({ message: 'Agendamento não encontrado' });
            }

            return res.status(200).send({ message: 'Agendamento cancelado' });

        } catch (error) {
            console.error('Erro ao cancelar agendamento:', error);

            return res.status(500).send({
                message: 'Erro ao cancelar agendamento',
                error: error.message
            });
        }
    },


    // MEUS AGENDAMENTOS (visão do PACIENTE, paginado)
    async listarMeusAgendamentos(req, res) {
        try {
            if (req.session.tipo !== 'PACIENTE') {
                return res.status(403).send({ error: 'Rota exclusiva de paciente' });
            }

            const page = Number(req.query.page) || 1;
            const porPagina = Number(req.query.porPagina) || 4;
            const offset = (page - 1) * porPagina;

            const resultado = await baseQueryAgendamentos()
                .where('sol.pac_id', req.session.id)
                .orderBy('sol.sol_data_de_coleta', 'desc');

            const todosAgendamentos = agruparPorAgendamento(resultado);

            const total = todosAgendamentos.length;
            const totalPaginas = Math.max(1, Math.ceil(total / porPagina));
            const paginaValida = Math.min(Math.max(1, page), totalPaginas);
            const inicio = (paginaValida - 1) * porPagina;
            const itens = todosAgendamentos.slice(inicio, inicio + porPagina);

            return res.status(200).send({ itens, paginaAtual: paginaValida, totalPaginas });

        } catch (error) {
            console.error('Erro ao buscar meus agendamentos:', error);

            return res.status(500).send({
                message: 'Erro ao buscar seus agendamentos',
                error: error.message
            });
        }
    },


    // PRÓXIMO AGENDAMENTO (visão do PACIENTE, usado na Home)
    //
    // Devolve só o agendamento mais próximo da data de hoje pra frente,
    // ainda com status 'agendado'. Se não houver nenhum, devolve null
    // (não é erro — só significa "sem próximo agendamento").
    async proximoAgendamento(req, res) {
        try {
            if (req.session.tipo !== 'PACIENTE') {
                return res.status(403).send({ error: 'Rota exclusiva de paciente' });
            }

            const resultado = await baseQueryAgendamentos()
                .where('sol.pac_id', req.session.id)
                .where('sol.sol_status', 'agendado')
                .whereRaw('sol.sol_data_de_coleta >= CURRENT_DATE')
                .orderBy('sol.sol_data_de_coleta', 'asc');

            const agendamentos = agruparPorAgendamento(resultado);

            return res.status(200).send(agendamentos[0] ?? null);

        } catch (error) {
            console.error('Erro ao buscar próximo agendamento:', error);

            return res.status(500).send({
                message: 'Erro ao buscar próximo agendamento',
                error: error.message
            });
        }
    }

};