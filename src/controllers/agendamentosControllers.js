import knex from '../database/index.js';

export default {

    
    // LISTAR AGENDAMENTOS
    
    async listar(req, res) {
        try {
            const {
                status,
                data,
                excluir_data,
                order
            } = req.query;

            let query = knex('solicitacao as sol')
                .leftJoin(
                    'pacientes as pac',
                    'pac.pac_id',
                    'sol.pac_id'
                )
                .leftJoin(//permite manter as solicitações mesmo quando alguma informação relacionada não existe
                    'postosdesaude as pos',
                    'pos.pos_id',
                    'sol.pos_id'
                )
                .leftJoin(
                    'coleta as col',
                    'col.sol_id',
                    'sol.sol_id'
                )
                .leftJoin(
                    'insumo as ins',
                    'ins.ins_id',
                    'col.ins_id'
                )
                .select(
                    'sol.sol_id',
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
                );

           
            // FILTRO POR STATUS
          

            if (status) {
                query = query.where(
                    'sol.sol_status',
                    status
                );
            }

           
            // SOMENTE HOJE
           

            if (data === 'hoje') {
                query = query.whereRaw(
                    'sol.sol_data_de_coleta = CURRENT_DATE'
                );
            }

          
            // EXCETO HOJE
           

            if (excluir_data === 'hoje') {
                query = query.whereRaw(
                    'sol.sol_data_de_coleta != CURRENT_DATE'
                );
            }

           
            // ORDENAÇÃO
           
            if (order === 'proximidade') {
                query = query.orderByRaw(
                    'ABS(sol.sol_data_de_coleta - CURRENT_DATE)'
                );
            } else {
                query = query.orderBy(
                    'sol.sol_data_de_coleta',
                    'asc'
                );
            }

            const resultado = await query;

           
            // TRANSFORMAR RESULTADO DO BANCO
            // NO FORMATO QUE O FRONTEND ESPERA
           

            const mapa = new Map();

            resultado.forEach((linha) => {

                if (!mapa.has(linha.sol_id)) {

                    mapa.set(linha.sol_id, {
                        sol_id: linha.sol_id,

                        sol_data_de_coleta:
                            linha.sol_data_de_coleta,

                        status:
                            linha.sol_status,

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

                const agendamento =
                    mapa.get(linha.sol_id);

               
                // ADICIONAR INSUMO
                
                if (linha.ins_id !== null) {

                    agendamento.insumos.push({
                        ins_id: linha.ins_id,
                        ins_nome: linha.ins_nome,
                        quantidade: linha.quantidade
                    });
                }
            });

            return res.status(200).send(
                Array.from(mapa.values())
            );

        } catch (error) {

            console.error(
                'Erro ao buscar agendamentos:',
                error
            );

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

            const {
                paciente,
                sol_data_de_coleta,
                posto,
                itens
            } = req.body;

           
            // VALIDAÇÕES
           

            if (!paciente || !paciente.pac_id) {
                await trx.rollback();

                return res.status(400).send({
                    message: 'Paciente não informado'
                });
            }

            if (!posto || !posto.pos_id) {
                await trx.rollback();

                return res.status(400).send({
                    message: 'Posto não informado'
                });
            }

            if (!sol_data_de_coleta) {
                await trx.rollback();

                return res.status(400).send({
                    message: 'Data de coleta não informada'
                });
            }

            if (!Array.isArray(itens) || itens.length === 0) {
                await trx.rollback();

                return res.status(400).send({
                    message: 'Nenhum insumo informado'
                });
            }

           
            // CRIAR SOLICITAÇÃO
        

            const resultado = await trx('solicitacao')
                .insert({
                    pac_id: paciente.pac_id,
                    pos_id: posto.pos_id,
                    sol_data_de_coleta,
                    sol_status: 'agendado'
                })
                .returning('sol_id');

            const sol_id =
                typeof resultado[0] === 'object'
                    ? resultado[0].sol_id
                    : resultado[0];

           
            // CRIAR ITENS DA COLETA
            

            const linhasColeta = itens.map((item) => ({
                sol_id: sol_id,
                ins_id: item.ins_id,
                quantidade: item.quantidade
            }));

            await trx('coleta').insert(
                linhasColeta
            );

           
            // FINALIZAR TRANSAÇÃO
           

            await trx.commit();

            return res.status(201).send({
                message: 'Agendamento criado com sucesso',
                sol_id: sol_id
            });

        } catch (error) {

            await trx.rollback();

            console.error(
                'Erro ao criar agendamento:',
                error
            );

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

            const quantidadeAlterada =
                await knex('solicitacao')
                    .where('sol_id', id)
                    .update({
                        sol_status: 'concluido'
                    });

            if (quantidadeAlterada === 0) {

                return res.status(404).send({
                    message: 'Agendamento não encontrado'
                });
            }

            return res.status(200).send({
                message: 'Agendamento concluído'
            });

        } catch (error) {

            console.error(
                'Erro ao concluir agendamento:',
                error
            );

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

            const quantidadeAlterada =
                await knex('solicitacao')
                    .where('sol_id', id)
                    .update({
                        sol_status: 'cancelado'
                    });

            if (quantidadeAlterada === 0) {

                return res.status(404).send({
                    message: 'Agendamento não encontrado'
                });
            }

            return res.status(200).send({
                message: 'Agendamento cancelado'
            });

        } catch (error) {

            console.error(
                'Erro ao cancelar agendamento:',
                error
            );

            return res.status(500).send({
                message: 'Erro ao cancelar agendamento',
                error: error.message
            });
        }
    },


   
    // MEUS AGENDAMENTOS
   
    async listarMeusAgendamentos(req, res) {

        try {

           
            // VERIFICAR SE É PACIENTE
           

            if (req.session.tipo !== 'PACIENTE') {

                return res.status(403).send({
                    error: 'Rota exclusiva de paciente'
                });
            }

            
            // PAGINAÇÃO
          
            const page =
                Number(req.query.page) || 1;

            const porPagina =
                Number(req.query.porPagina) || 4;

            const offset =
                (page - 1) * porPagina;

           
            // BUSCAR AGENDAMENTOS
           
            const resultado =
                await knex('solicitacao as sol')
                    .leftJoin(
                        'pacientes as pac',
                        'pac.pac_id',
                        'sol.pac_id'
                    )
                    .leftJoin(
                        'postosdesaude as pos',
                        'pos.pos_id',
                        'sol.pos_id'
                    )
                    .leftJoin(
                        'coleta as col',
                        'col.sol_id',
                        'sol.sol_id'
                    )
                    .leftJoin(
                        'insumo as ins',
                        'ins.ins_id',
                        'col.ins_id'
                    )
                    .where(
                        'sol.pac_id',
                        req.session.id
                    )
                    .select(
                        'sol.sol_id',
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
                    )
                    .orderBy(
                        'sol.sol_data_de_coleta',
                        'desc'
                    );

           
            // AGRUPAR OS RESULTADOS
         

            const mapa = new Map();

            resultado.forEach((linha) => {

                if (!mapa.has(linha.sol_id)) {

                    mapa.set(linha.sol_id, {

                        sol_id: linha.sol_id,

                        sol_data_de_coleta:
                            linha.sol_data_de_coleta,

                        status:
                            linha.sol_status,

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

                const agendamento =
                    mapa.get(linha.sol_id);

                if (linha.ins_id !== null) {

                    agendamento.insumos.push({

                        ins_id: linha.ins_id,

                        ins_nome: linha.ins_nome,

                        quantidade: linha.quantidade
                    });
                }
            });

           
            // TRANSFORMAR MAP EM ARRAY
            

            const todosAgendamentos =
                Array.from(mapa.values());

           
            // PAGINAÇÃO
        
            const total =
                todosAgendamentos.length;

            const totalPaginas =
                Math.max(
                    1,
                    Math.ceil(total / porPagina)
                );

            const paginaValida =
                Math.min(
                    Math.max(1, page),
                    totalPaginas
                );

            const inicio =
                (paginaValida - 1) * porPagina;

            const itens =
                todosAgendamentos.slice(
                    inicio,
                    inicio + porPagina
                );

           
            // RESPOSTA
            

            return res.status(200).send({

                itens,

                paginaAtual: paginaValida,

                totalPaginas
            });

        } catch (error) {

            console.error(
                'Erro ao buscar meus agendamentos:',
                error
            );

            return res.status(500).send({
                message: 'Erro ao buscar seus agendamentos',
                error: error.message
            });
        }
    }

};