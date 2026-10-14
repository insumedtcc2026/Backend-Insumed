import knex from './../database/index.js';
import { dataHojeBrasil, idValido, validarDataISO, validarMotivo } from '../utils/validacoes.js';
import { ACOES, linhaDoTempo, registrarHistorico } from '../utils/historico.js';

// Mesmo limite do formulário de envio (EnviarSolicitacao.tsx)
const TAMANHO_MAX_PRESCRICAO = 5 * 1024 * 1024;
const TAMANHO_MAX_OBSERVACAO = 1000;
const REGEX_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

// Prescrições em andamento e agendamentos ainda não realizados
const STATUS_TRANSFERIVEIS = ["Pendente", "Revisado", "Autorizado", "agendado"];

// Textos dos motivos de reenvio (mesmos da tela do admin)
const MOTIVOS_REENVIO = {
    FOTO_SEM_QUALIDADE: "Foto sem qualidade",
    PRESCRICAO_VENCIDA: "Prescrição vencida",
    INFORMACAO_DIFERENTE: "Informação diferente",
    OUTRO: "Outro motivo",
};

// O formulário aceita "image/*,.pdf"
const tipoPrescricaoPermitido = (tipo) =>
    typeof tipo === 'string' && (/^image\/[a-z0-9.+-]+$/i.test(tipo) || tipo === 'application/pdf');

export default {

    async createSolicitacao(req, res) {
    try {
        const pac_id = req.session.id;

        if (!pac_id) {
            return res.status(401).json({ error: 'Paciente não identificado' });
        }

        const {
            pos_id,
            sol_prescricao,
            sol_observacao,
            sol_prescricao_tipo
        } = req.body;

        if (!pos_id) {
            return res.status(400).json({ error: 'Posto de saúde não informado' });
        }

        if (!idValido(pos_id)) {
            return res.status(400).json({ error: 'Posto de saúde inválido' });
        }

        if (!sol_prescricao) {
            return res.status(400).json({ error: 'Prescrição não fornecida' });
        }

        if (typeof sol_prescricao !== 'string' || !REGEX_BASE64.test(sol_prescricao)) {
            return res.status(400).json({ error: 'Arquivo da prescrição inválido. Envie novamente.' });
        }

        if (sol_prescricao_tipo && !tipoPrescricaoPermitido(sol_prescricao_tipo)) {
            return res.status(400).json({ error: 'Formato não suportado. Envie uma imagem ou um PDF.' });
        }

        if (sol_observacao != null && typeof sol_observacao !== 'string') {
            return res.status(400).json({ error: 'Observação inválida' });
        }

        if (sol_observacao && sol_observacao.trim().length > TAMANHO_MAX_OBSERVACAO) {
            return res.status(400).json({
                error: `A observação deve ter no máximo ${TAMANHO_MAX_OBSERVACAO} caracteres`
            });
        }

        const imagemBuffer = Buffer.from(sol_prescricao, 'base64');

        if (!imagemBuffer.length) {
            return res.status(400).json({ error: 'Arquivo da prescrição vazio' });
        }

        if (imagemBuffer.length > TAMANHO_MAX_PRESCRICAO) {
            return res.status(400).json({ error: 'A prescrição deve ter no máximo 5 MB.' });
        }

        const posto = await knex('postosdesaude').where('pos_id', Number(pos_id)).first('pos_id');
        if (!posto) {
            return res.status(400).json({ error: 'Posto de saúde não encontrado' });
        }

        // Evita a mesma prescrição pendente duas vezes (duplo clique,
        // reenvio do formulário): mesmo paciente, mesmo arquivo, ainda Pendente.
        const duplicada = await knex('solicitacao')
            .where({ pac_id, sol_status: 'Pendente' })
            .where('sol_prescricao', imagemBuffer)
            .first('sol_id');

        if (duplicada) {
            return res.status(409).json({
                error: 'Esta prescrição já foi enviada e está aguardando análise.'
            });
        }

        const solicitacao = await knex.transaction(async (trx) => {
            const [nova] = await trx('solicitacao')
                .insert({
                    pac_id: pac_id,
                    pos_id: Number(pos_id),
                    sol_prescricao: imagemBuffer,
                    sol_prescricao_tipo: sol_prescricao_tipo || null,
                    sol_observacao: sol_observacao?.trim() || null,
                    sol_status: 'Pendente',
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

            await registrarHistorico(trx, req.session, {
                sol_id: nova.sol_id, acao: ACOES.ENVIADA, para: 'Pendente',
            });

            return nova;
        });

        return res.status(201).json({
            message: 'Solicitação enviada com sucesso',
            solicitacao
        });

    } catch (error) {
        console.error('Erro ao criar solicitação:', error);
        return res.status(500).json({ error: "Erro ao processar a solicitação. Tente novamente." });
    }
},

async buscarprescricoespendetes(req, res) {
    try {

        const admin = req.session;

        const query = knex("solicitacao as sol")
            .innerJoin(
                "pacientes as pac",
                "pac.pac_id",
                "sol.pac_id"
            )
            .select(
                "sol.sol_id",
                "sol.pac_id",
                "sol.pos_id",
                "sol.sol_status",
                "sol.sol_data_solicitacao",
                "pac.pac_nome",
                "pac.pac_cpf",
                "pac.pac_avatar",
                // prescrição autorizada que já virou agendamento (agendado ou
                // concluído): a tela troca "Agendar" por "Ver agendamento"
                knex.raw("(ag.sol_origem_id IS NOT NULL) AS agendamento_ativo")
            )
            .leftJoin(
                knex("solicitacao")
                    .select("sol_origem_id")
                    .whereNotNull("sol_origem_id")
                    .whereIn("sol_status", ["agendado", "concluido"])
                    .groupBy("sol_origem_id")
                    .as("ag"),
                "ag.sol_origem_id",
                "sol.sol_id"
            )
            .whereIn("sol.sol_status", [
                "Pendente",
                "Autorizado",
                "Revisado",
                "Nao Autorizado"
            ])
            .orderBy(
                "sol.sol_data_solicitacao",
                "asc"
            );


        // ADMINISTRADOR LIMITADO AO POSTO
        if (!admin.tp_universal) {

            query.andWhere(
                "sol.pos_id",
                admin.posto_id
            );

        }


        const solicitacoes = await query;



        return res.status(200).json(
            solicitacoes
        );


    } catch (error) {

        console.error(
            "ERRO NO /PENDENTES:",
            error
        );

        return res.status(500).json({
            error: "Erro ao processar a solicitação. Tente novamente."
        });

    }
},



async buscarPrescricao(req, res) {
  try {
    const { id } = req.params;

    const solicitacao = await knex("solicitacao")
      .select("sol_prescricao", "sol_prescricao_tipo")
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

    const tipoImagem =
      solicitacao.sol_prescricao_tipo || "image/jpeg";

    const tiposPermitidos = [
      "image/jpeg",
      "image/png",
      "image/webp"
    ];

    res.setHeader(
      "Content-Type",
      tiposPermitidos.includes(tipoImagem)
        ? tipoImagem
        : "application/octet-stream"
    );

    return res.send(solicitacao.sol_prescricao);

  } catch (error) {
    console.error("Erro ao buscar prescrição:", error);

    return res.status(500).json({
      error: "Erro ao buscar prescrição"
    });
  }
},


   // Buscar prescrições atraves do id do paciente
 async prescicaodopaciente (req, res) {
  try {
    const buscapac = await knex('solicitacao as sol')
      .innerJoin("pacientes as pac", "pac.pac_id", "sol.pac_id")
      .select(
          "sol.sol_id",
          "sol.sol_data_solicitacao",
          "sol.sol_status",
          "sol.sol_observacao",
          "sol.sol_prescricao_tipo",
          knex.raw("(sol.sol_prescricao IS NOT NULL) as tem_prescricao")
      )
      .where("sol.pac_id", req.session.id)
      .orderBy("sol.sol_data_solicitacao", "desc");

    return res.status(200).json(buscapac);
  } catch (error) {
    console.error("Erro ao buscar prescrições", error);
    return res.status(500).json({ error: "Erro ao processar a solicitação. Tente novamente." });
  }
},

async detalhesPrescricaoPaciente(req, res) {
  try {
    const { id } = req.params;
    const pac_id = req.session.id;

    const solicitacao = await knex("solicitacao")
      .select(
        "sol_id",
        "pac_id",
        "sol_status",
        "sol_data_solicitacao",
        "sol_observacao",
        "sol_prescricao",
        "sol_prescricao_tipo"
      )
      .where("sol_id", id)
      .first();

    if (!solicitacao) {
      return res.status(404).json({ error: "Solicitação não encontrada" });
    }

    if (solicitacao.pac_id !== pac_id) {
      return res.status(403).json({ error: "Prescrição não se refere a este paciente" });
    }

    return res.status(200).json({
      sol_id: solicitacao.sol_id,
      sol_status: solicitacao.sol_status,
      sol_data_solicitacao: solicitacao.sol_data_solicitacao,
      sol_observacao: solicitacao.sol_observacao,
      sol_prescricao_mimetype: solicitacao.sol_prescricao_tipo || null,
      sol_prescricao_base64: solicitacao.sol_prescricao
        ? solicitacao.sol_prescricao.toString('base64')
        : null
    });

  } catch (error) {
    console.error("Erro ao buscar detalhes da prescrição:", error);
    return res.status(500).json({ error: "Erro ao processar a solicitação. Tente novamente." });
  }
},
// REVISÃO PELO ADMINISTRADOR
//
// O único status que o administrador grava por esta rota é "Revisado"
// (envio para o autorizador, com insumo, quantidade e vencimento). Quem
// decide "Autorizado"/"Nao Autorizado" é o autorizador, na rota dele, e o
// reenvio tem rota própria. Só prescrições "Pendente" podem ser revisadas.
async alterarStatus(req, res) {
    try {
        const { id } = req.params;

        const {
            sol_status,
            sol_data_vencimento,
            ins_id,
            sol_insumo_quant
        } = req.body ?? {};

        if (!sol_status) {
            return res.status(400).json({
                error: "Status não informado"
            });
        }

        if (sol_status !== "Revisado") {
            return res.status(400).json({
                error: "Status inválido. O administrador só pode enviar a prescrição para o autorizador."
            });
        }

        if (!ins_id) {
            return res.status(400).json({
                error: "Insumo não informado"
            });
        }

        if (!idValido(ins_id)) {
            return res.status(400).json({
                error: "Insumo inválido"
            });
        }

        const quantidade = Number(sol_insumo_quant);

        if (!Number.isInteger(quantidade) || quantidade <= 0) {
            return res.status(400).json({
                error: "Quantidade de insumo inválida"
            });
        }

        if (!sol_data_vencimento) {
            return res.status(400).json({
                error: "Informe a data de vencimento da prescrição"
            });
        }

        if (validarDataISO(sol_data_vencimento)) {
            return res.status(400).json({
                error: "Data de vencimento inválida"
            });
        }

        if (sol_data_vencimento < dataHojeBrasil()) {
            return res.status(400).json({
                error: "A prescrição está vencida. Use \"Pedir reenvio\" com o motivo Prescrição vencida."
            });
        }

        const insumo = await knex("insumo").where("ins_id", Number(ins_id)).first("ins_id", "ins_nome");

        if (!insumo) {
            return res.status(404).json({
                error: "Insumo não encontrado"
            });
        }

        // UPDATE condicional: só sai de "Pendente". Duas revisões
        // simultâneas não sobrescrevem uma à outra.
        const quantidadeAtualizada = await knex.transaction(async (trx) => {
            const n = await trx("solicitacao")
                .where("sol_id", id)
                .where("sol_status", "Pendente")
                .update({
                    sol_status,
                    sol_data_vencimento,
                    ins_id: Number(ins_id),
                    sol_insumo_quant: quantidade
                });

            if (n) {
                await registrarHistorico(trx, req.session, {
                    sol_id: Number(id), acao: ACOES.REVISADA, de: "Pendente", para: "Revisado",
                    detalhe: `${quantidade}x ${insumo.ins_nome} · vence em ${sol_data_vencimento.split("-").reverse().join("/")}`,
                });
            }
            return n;
        });

        if (!quantidadeAtualizada) {
            const existe = await knex("solicitacao").where("sol_id", id).first("sol_status");

            if (!existe) {
                return res.status(404).json({
                    error: "Solicitação não encontrada"
                });
            }

            return res.status(409).json({
                error: "Esta prescrição já foi analisada e não pode ser revisada novamente."
            });
        }

        return res.status(200).json({
            message: "Solicitação atualizada com sucesso",
            sol_status,
            ins_id: Number(ins_id),
            quantidade
        });

    } catch (error) {
        console.error(
            "Erro ao alterar solicitação:",
            error
        );

        return res.status(500).json({
            error: "Erro ao atualizar a solicitação"
        });
    }
},

async buscarSolicitacaoPorId(req, res) {
  try {
    const { id } = req.params;

    const solicitacao = await knex("solicitacao as sol")
      .leftJoin("pacientes as pac", "pac.pac_id", "sol.pac_id")
      .leftJoin("postosdesaude as pos", "pos.pos_id", "sol.pos_id")
      .leftJoin("insumo as ins", "ins.ins_id", "sol.ins_id")
      .select(
        "sol.sol_id",
        "sol.pac_id",
        "sol.pos_id",
        "sol.ins_id",
        "sol.sol_insumo_quant",
        "sol.sol_data_solicitacao",
        "sol.sol_status",
        "sol.sol_observacao",
        "sol.sol_prescricao_tipo",
        "sol.sol_motivo_nao_autorizado",
        "sol.sol_data_vencimento",
        "pac.pac_nome",
        "pac.pac_cpf",
        "pos.pos_nome",
        "ins.ins_nome"
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
    console.error("Erro ao buscar solicitação:", error);

    return res.status(500).json({
      error: "Erro ao buscar solicitação"
    });
  }
},


//buscar historico das prescrições 
async buscarHistoricoPrescricoes(req, res) {
    try {
        const admin = req.session;

        const query = knex("solicitacao as sol")
            .innerJoin(
                "pacientes as pac",
                "pac.pac_id",
                "sol.pac_id"
            )
            .leftJoin(
                "insumo as ins",
                "ins.ins_id",
                "sol.ins_id"
            )
            .leftJoin(
                "postosdesaude as pos",
                "pos.pos_id",
                "sol.pos_id"
            )
            .select(
                "sol.sol_id",
                "sol.pac_id",
                "sol.pos_id",
                "sol.sol_status",
                "sol.sol_data_solicitacao",
                "sol.sol_data_vencimento",
                "sol.sol_motivo_nao_autorizado",
                "sol.sol_motivo_reenvio",
                "sol.sol_insumo_quant",
                "sol.sol_observacao",
                "sol.sol_prescricao_tipo",

                "pac.pac_nome",
                "pac.pac_cpf",
                "pac.pac_avatar",

                "ins.ins_nome",
                "pos.pos_nome"
            )
            .whereIn("sol.sol_status", [
                "Aprovado",
                "Reenvio",
                "Revisado",
                "Nao Autorizado"
            ]);

        if (!admin.tp_universal) {
            query.andWhere("sol.pos_id", admin.posto_id);
        }

        const historico = await query;

        return res.status(200).json(historico);

    } catch (error) {

        console.error(
            "Erro ao buscar histórico:",
            error
        );

        return res.status(500).json({
            error: "Erro ao processar a solicitação. Tente novamente."
        });


    }

},



async pedirReenvio(req, res) {
  try {

    const { id } = req.params;
    const { motivo } = req.body ?? {};

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

    // Só prescrições ainda não analisadas (Pendente) podem voltar para o paciente.
    const solicitacao = await knex.transaction(async (trx) => {
      const [alterada] = await trx("solicitacao")
        .where("sol_id", id)
        .where("sol_status", "Pendente")
        .update({
          sol_status: "Reenvio",
          sol_motivo_reenvio: motivo
        })
        .returning([
          "sol_id",
          "sol_status",
          "sol_motivo_reenvio"
        ]);

      if (alterada) {
        await registrarHistorico(trx, req.session, {
          sol_id: alterada.sol_id, acao: ACOES.REENVIO, de: "Pendente", para: "Reenvio",
          detalhe: MOTIVOS_REENVIO[motivo] ?? motivo,
        });
      }
      return alterada;
    });

    if (!solicitacao) {
      const existe = await knex("solicitacao").where("sol_id", id).first("sol_status");

      if (!existe) {
        return res.status(404).json({
          error: "Solicitação não encontrada"
        });
      }

      return res.status(409).json({
        error: "Esta prescrição já foi analisada e não pode mais receber pedido de reenvio."
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
      error: "Erro ao pedir reenvio"
    });
  }
},

// TRANSFERIR PARA OUTRA UNIDADE (admin)
//
// Vale para prescrições ainda em andamento (Pendente, Revisado,
// Autorizado) e para agendamentos ainda não realizados (agendado).
// O motivo é obrigatório e fica no histórico, com quem transferiu.
async transferirUnidade(req, res) {
  try {
    const { id } = req.params;
    const { pos_id, motivo } = req.body ?? {};

    if (!idValido(pos_id)) {
      return res.status(400).json({ error: "Selecione a unidade de destino" });
    }

    const erroMotivo = validarMotivo(motivo, "da transferência");
    if (erroMotivo) {
      return res.status(400).json({ error: erroMotivo });
    }

    const destino = await knex("postosdesaude").where("pos_id", Number(pos_id)).first("pos_id", "pos_nome");
    if (!destino) {
      return res.status(404).json({ error: "Unidade de destino não encontrada" });
    }

    const resultado = await knex.transaction(async (trx) => {
      const atual = await trx("solicitacao as sol")
        .leftJoin("postosdesaude as pos", "pos.pos_id", "sol.pos_id")
        .where("sol.sol_id", id)
        .forUpdate()
        .first("sol.sol_id", "sol.sol_status", "sol.pos_id", "pos.pos_nome");

      if (!atual) return { status: 404, corpo: { error: "Solicitação não encontrada" } };

      if (!STATUS_TRANSFERIVEIS.includes(atual.sol_status)) {
        return {
          status: 409,
          corpo: { error: "Só é possível transferir prescrições em andamento ou agendamentos ainda não realizados." },
        };
      }

      if (Number(atual.pos_id) === Number(destino.pos_id)) {
        return { status: 400, corpo: { error: "A solicitação já está nesta unidade" } };
      }

      await trx("solicitacao").where("sol_id", id).update({ pos_id: destino.pos_id });

      await registrarHistorico(trx, req.session, {
        sol_id: Number(id),
        acao: ACOES.TRANSFERIDA,
        de: atual.sol_status,
        para: atual.sol_status,
        detalhe: `De ${atual.pos_nome ?? "unidade não informada"} para ${destino.pos_nome}. Motivo: ${motivo.trim()}`,
      });

      return {
        status: 200,
        corpo: { message: `Transferido para ${destino.pos_nome}`, pos_id: destino.pos_id, pos_nome: destino.pos_nome },
      };
    });

    return res.status(resultado.status).json(resultado.corpo);

  } catch (error) {
    console.error("Erro ao transferir de unidade:", error);
    return res.status(500).json({ error: "Erro ao transferir de unidade" });
  }
},

// HISTÓRICO ("quem fez o quê") de uma solicitação/agendamento.
// Admin e autorizador veem os nomes; o paciente vê só os próprios itens
// e o papel de quem fez (não o nome do servidor).
async historico(req, res) {
  try {
    const { id } = req.params;
    const sessao = req.session;

    const solicitacao = await knex("solicitacao")
      .where("sol_id", id)
      .first("sol_id", "pac_id", "pos_id", "sol_origem_id");

    if (!solicitacao) {
      return res.status(404).json({ error: "Solicitação não encontrada" });
    }

    if (sessao.tipo === "PACIENTE" && Number(solicitacao.pac_id) !== Number(sessao.id)) {
      return res.status(403).json({ error: "Esta solicitação não é sua" });
    }

    if (sessao.tipo === "ADMIN" && !sessao.tp_universal && Number(sessao.posto_id) !== Number(solicitacao.pos_id)) {
      return res.status(403).json({ error: "Acesso negado: solicitação de outro posto" });
    }

    // agendamento criado a partir de uma prescrição: mostra também o
    // histórico da prescrição de origem (e vice-versa, os agendamentos dela)
    const relacionados = await knex("solicitacao")
      .where("sol_origem_id", solicitacao.sol_id)
      .pluck("sol_id");
    const ids = [solicitacao.sol_id, solicitacao.sol_origem_id, ...relacionados].filter(Boolean);

    const eventos = await linhaDoTempo(ids, { ocultarNomesDaEquipe: sessao.tipo === "PACIENTE" });
    return res.status(200).json(eventos);

  } catch (error) {
    console.error("Erro ao buscar histórico:", error);
    return res.status(500).json({ error: "Erro ao buscar o histórico" });
  }
},

// MINHAS PRESCRIÇÕES (paciente) — base do rastreio "estilo entrega".
// Cada prescrição vem com o agendamento mais recente feito a partir dela
// e com a linha do tempo (sem o nome de quem fez na unidade).
async minhasPrescricoes(req, res) {
  try {
    const pac_id = req.session.id;

    const prescricoes = await knex("solicitacao as sol")
      .leftJoin("postosdesaude as pos", "pos.pos_id", "sol.pos_id")
      .leftJoin("insumo as ins", "ins.ins_id", "sol.ins_id")
      .where("sol.pac_id", pac_id)
      .whereNotIn("sol.sol_status", ["agendado", "concluido", "cancelado"])
      .select(
        "sol.sol_id", "sol.sol_status", "sol.sol_data_solicitacao", "sol.sol_data_vencimento",
        "sol.sol_observacao", "sol.sol_prescricao_tipo", "sol.sol_insumo_quant",
        "sol.sol_motivo_nao_autorizado", "sol.sol_motivo_reenvio",
        "pos.pos_nome", "ins.ins_nome",
        knex.raw("(sol.sol_prescricao IS NOT NULL) AS tem_prescricao"),
      )
      .orderBy("sol.sol_data_solicitacao", "desc")
      .orderBy("sol.sol_id", "desc");

    const ids = prescricoes.map((p) => p.sol_id);

    const agendamentos = ids.length
      ? await knex("solicitacao as ag")
        .leftJoin("postosdesaude as pos", "pos.pos_id", "ag.pos_id")
        .whereIn("ag.sol_origem_id", ids)
        .where("ag.pac_id", pac_id)
        .select(
          "ag.sol_id", "ag.sol_origem_id", "ag.sol_status", "ag.sol_protocolo", "ag.sol_data_de_coleta",
          "ag.sol_motivo_cancelamento", "ag.sol_recado", "pos.pos_nome", "pos.pos_endereco",
        )
        .orderBy("ag.sol_id", "desc")
      : [];

    const eventos = ids.length
      ? await linhaDoTempo([...ids, ...agendamentos.map((a) => a.sol_id)], { ocultarNomesDaEquipe: true })
      : [];

    const resposta = prescricoes.map((p) => {
      const doItem = agendamentos.filter((a) => a.sol_origem_id === p.sol_id);
      const idsDoItem = new Set([p.sol_id, ...doItem.map((a) => a.sol_id)]);
      return {
        ...p,
        // o mais recente (se o primeiro foi cancelado e houve reagendamento, vem o novo)
        agendamento: doItem[0] ?? null,
        eventos: eventos.filter((e) => idsDoItem.has(e.sol_id)),
      };
    });

    return res.status(200).json(resposta);

  } catch (error) {
    console.error("Erro ao buscar minhas prescrições:", error);
    return res.status(500).json({ error: "Erro ao buscar suas prescrições" });
  }
},
};
