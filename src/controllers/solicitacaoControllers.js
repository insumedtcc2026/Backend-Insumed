import knex from './../database/index.js';

export default {

    async createSolicitacao(req, res) {

        try {

            // ==========================
            // PACIENTE VEM DO JWT
            // ==========================
const pac_id = req.session.id;


            if (!pac_id) {
                return res.status(401).json({
                    error: 'Paciente não identificado'
                });
            }


            // ==========================
            // DADOS ENVIADOS PELO FRONT
            // ==========================

            const {
                pos_id,
                sol_prescricao,
                sol_observacao
            } = req.body;


            if (!pos_id) {
                return res.status(400).json({
                    error: 'Posto de saúde não informado'
                });
            }


            if (!sol_prescricao) {
                return res.status(400).json({
                    error: 'Prescrição não fornecida'
                });
            }


            // ==========================
            // CONVERTE BASE64
            // ==========================

            const imagemBuffer = Buffer.from(
                sol_prescricao,
                'base64'
            );


            // ==========================
            // SALVA SOLICITAÇÃO
            // ==========================

            const [solicitacao] =
                await knex('solicitacao')
                    .insert({

                        pac_id: pac_id,

                        pos_id: pos_id,

                        sol_prescricao:
                            imagemBuffer,

                        sol_observacao:
                            sol_observacao || null,

                        sol_status:
                            'Pendente',
                            
                                    sol_insumo_quant: 0


                    })
                    .returning([
                        'sol_id',
                        'pac_id',
                        'pos_id',
                        'sol_data_solicitacao',
                        'sol_status',
                        'sol_observacao'
                    ]);


            return res.status(201).json({

                message:
                    'Solicitação enviada com sucesso',

                solicitacao

            });


        } catch (error) {

            console.error(
                'Erro ao criar solicitação:',
                error
            );

            return res.status(500).json({
                error: error.message
            });
        }
    },


    async buscarSolicitacoes(req, res) {

        try {

            const resultado =
                await knex('solicitacao as sol')
                    .join(
                        'postosdesaude as pos',
                        'pos.pos_id',
                        'sol.pos_id'
                    )
                    .join(
                        'pacientes as pac',
                        'pac.pac_id',
                        'sol.pac_id'
                    )
                    .select(
                        'sol.sol_id',
                        'sol.sol_data_solicitacao',
                        'sol.sol_status',
                        'sol.sol_observacao',
                        'sol.sol_prescricao',
                        'pac.pac_id',
                        'pac.pac_nome',
                        'pos.pos_id',
                        'pos.pos_nome'
                    );


            const solicitacoes =
                resultado.map(item => ({

                    ...item,

                    sol_prescricao:
                        item.sol_prescricao
                            ? item.sol_prescricao
                                .toString('base64')
                            : null

                }));


            return res.status(200).json(
                solicitacoes
            );


        } catch (error) {

            console.error(
                'Erro ao buscar solicitações:',
                error
            );

            return res.status(500).json({
                error: error.message
            });
        }
    },


    async alterarStatus(req, res) {

        try {

            const { id } = req.params;

            const { sol_status } = req.body;


            if (!sol_status) {
                return res.status(400).json({
                    error: 'Status não informado'
                });
            }


            await knex('solicitacao')
                .where('sol_id', id)
                .update({
                    sol_status
                });


            return res.status(200).json({
                message:
                    'Status atualizado com sucesso'
            });


        } catch (error) {

            console.error(error);

            return res.status(500).json({
                error: error.message
            });
        }
    }

};