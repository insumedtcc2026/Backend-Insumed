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


   async buscarprescricoespendetes(req, res) {
    try {

        const solicitacoes = await knex("solicitacao as sol")
            .innerJoin(
                "pacientes as pac",
                "pac.pac_id",
                "sol.pac_id"
            )
            .select(
                "sol.sol_id",
                "sol.pac_id",
                "sol.sol_status",
                "sol.sol_data_solicitacao",
                "pac.pac_nome",
                "pac.pac_cpf"
            )
            .where("sol.sol_status", "Pendente")
            .orderBy("sol.sol_data_solicitacao", "asc");

        console.log("Solicitações encontradas:", solicitacoes);

        return res.status(200).json(solicitacoes);

    } catch (error) {

        console.error("ERRO NO /PENDENTES:", error);

        return res.status(500).json({
            error: error.message
        });
    }
},

async buscarPrescricao(req, res) {
    try {
        const { id } = req.params;

        const solicitacao = await knex("solicitacao")
            .select("sol_prescricao")
            .where("sol_id", id)
            .first();

        if (!solicitacao) {
            return res.status(404).json({
                error: "Solicitação não encontrada"
            });
        }

        if (!solicitacao.sol_prescricao) {
            return res.status(404).json({
                error: "Prescrição não encontrada"
            });
        }

        res.setHeader("Content-Type", "image/png");

        return res.send(solicitacao.sol_prescricao);

    } catch (error) {
        console.error("Erro ao buscar prescrição:", error);

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
    },
async buscarSolicitacaoPorId(req, res) {
  try {
    const { id } = req.params;

    const solicitacao = await knex("solicitacao as sol")
      .innerJoin("pacientes as pac", "pac.pac_id", "sol.pac_id")
      .innerJoin("postosdesaude as pos", "pos.pos_id", "sol.pos_id")
      .select(
        "sol.sol_id",
        "sol.pac_id",
        "sol.pos_id",
        "sol.sol_data_solicitacao",
        "sol.sol_status",
        "sol.sol_observacao",

        "pac.pac_nome",
        "pac.pac_cpf",

        "pos.pos_nome"
      )
      .where("sol.sol_id", id)
      .first();

    if (!solicitacao) {
      return res.status(404).json({
        error: "Solicitação não encontrada"
      });
    }

    return res.status(200).json(solicitacao);

  } catch (error) {

    console.error(
      "Erro ao buscar solicitação:",
      error
    );

    return res.status(500).json({
      error: error.message
    });
  }
},
async pedirReenvio(req, res) {
  try {

    const { id } = req.params;
    const { motivo } = req.body;

    if (!motivo) {
      return res.status(400).json({
        error: "Motivo do reenvio é obrigatório"
      });
    }

    const motivosValidos = [
      "FOTO_SEM_QUALIDADE",
      "PRESCRICAO_VENCIDA",
      "INFORMACAO_DIFERENTE",
      "OUTRO"
    ];

    if (!motivosValidos.includes(motivo)) {
      return res.status(400).json({
        error: "Motivo inválido"
      });
    }

    const [solicitacao] = await knex("solicitacao")
      .where("sol_id", id)
      .update({
        sol_status: "Reenvio",
        sol_motivo_reenvio: motivo
      })
      .returning([
        "sol_id",
        "sol_status",
        "sol_motivo_reenvio"
      ]);

    if (!solicitacao) {
      return res.status(404).json({
        error: "Solicitação não encontrada"
      });
    }

    return res.status(200).json({
      message: "Pedido de reenvio enviado com sucesso",
      solicitacao
    });

  } catch (error) {

    console.error(
      "Erro ao pedir reenvio:",
      error
    );

    return res.status(500).json({
      error: error.message
    });
  }
},
};