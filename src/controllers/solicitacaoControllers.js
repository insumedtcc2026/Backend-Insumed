import knex from './../database/index.js';
import { dataHojeBrasil, idValido, validarDataISO, validarMotivo } from '../utils/validacoes.js';
import { ACOES, linhaDoTempo, registrarHistorico } from '../utils/historico.js';
import { filtroBuscaPaciente, paginar } from '../utils/paginacao.js';
import { COLUNA_VERSOES, numerarVersoes, versoesJoin } from '../utils/versoes.js';
import { dataBR, prescricaoVencida, STATUS_AGENDAMENTO, STATUS_AGENDAMENTO_SEM_ENTREGA } from '../utils/status.js';
import { notificar } from '../notificacoes/processador.js';

// Mesmo limite do formulário de envio (EnviarSolicitacao.tsx)
const TAMANHO_MAX_PRESCRICAO = 5 * 1024 * 1024;
const TAMANHO_MAX_OBSERVACAO = 1000;
const REGEX_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

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

// Confere o arquivo e a observação enviados pelo paciente (envio novo e
// reenvio usam as mesmas regras). Devolve { erro } ou { buffer, tipo, observacao }.
function validarArquivoPrescricao({ sol_prescricao, sol_prescricao_tipo, sol_observacao }) {
    if (!sol_prescricao) return { erro: 'Prescrição não fornecida' };
    if (typeof sol_prescricao !== 'string' || !REGEX_BASE64.test(sol_prescricao)) {
        return { erro: 'Arquivo da prescrição inválido. Envie novamente.' };
    }
    if (sol_prescricao_tipo && !tipoPrescricaoPermitido(sol_prescricao_tipo)) {
        return { erro: 'Formato não suportado. Envie uma imagem ou um PDF.' };
    }
    if (sol_observacao != null && typeof sol_observacao !== 'string') {
        return { erro: 'Observação inválida' };
    }
    if (sol_observacao && sol_observacao.trim().length > TAMANHO_MAX_OBSERVACAO) {
        return { erro: `A observação deve ter no máximo ${TAMANHO_MAX_OBSERVACAO} caracteres` };
    }
    const buffer = Buffer.from(sol_prescricao, 'base64');
    if (!buffer.length) return { erro: 'Arquivo da prescrição vazio' };
    if (buffer.length > TAMANHO_MAX_PRESCRICAO) return { erro: 'A prescrição deve ter no máximo 5 MB.' };
    return { buffer, tipo: sol_prescricao_tipo || null, observacao: sol_observacao?.trim() || null };
}

// Quem pode ver uma solicitação (histórico, versões): o paciente dono, o
// admin do posto (ou universal) e o autorizador. Devolve null se pode, ou
// { status, error }.
function negarAcesso(sessao, solicitacao) {
    if (sessao.tipo === "PACIENTE" && Number(solicitacao.pac_id) !== Number(sessao.id)) {
        return { status: 403, error: "Esta solicitação não é sua" };
    }
    if (sessao.tipo === "ADMIN" && !sessao.tp_universal && Number(sessao.posto_id) !== Number(solicitacao.pos_id)) {
        return { status: 403, error: "Acesso negado: solicitação de outro posto" };
    }
    if (!["PACIENTE", "ADMIN", "AUTORIZADOR"].includes(sessao.tipo)) {
        return { status: 403, error: "Perfil sem permissão" };
    }
    return null;
}

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

        const arquivo = validarArquivoPrescricao({ sol_prescricao, sol_prescricao_tipo, sol_observacao });
        if (arquivo.erro) {
            return res.status(400).json({ error: arquivo.erro });
        }
        const imagemBuffer = arquivo.buffer;

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
                    sol_prescricao_tipo: arquivo.tipo,
                    sol_observacao: arquivo.observacao,
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

        await notificar();

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
            .leftJoin(...versoesJoin("sol"))
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
                knex.raw("(ag.sol_origem_id IS NOT NULL) AS agendamento_ativo"),
                // quantas versões anteriores (> 0 = o paciente já corrigiu após pedido de reenvio)
                COLUNA_VERSOES
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


        const solicitacoes = numerarVersoes(await query);

        return res.status(200).json(solicitacoes);


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

        await notificar();

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
        "sol.sol_observacao_equipe",
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
// Com ?page= a busca, os filtros e a paginação são feitos no banco
// ({ itens, total, paginaAtual, totalPaginas }); sem ele, a lista inteira.
async buscarHistoricoPrescricoes(req, res) {
    try {
        const admin = req.session;
        const { busca, status, data_inicio, data_fim } = req.query;

        const STATUS_HISTORICO = ["Aprovado", "Reenvio", "Revisado", "Nao Autorizado"];
        if (status && status !== "TODOS" && !STATUS_HISTORICO.includes(status)) {
            return res.status(400).json({ error: "Filtro de status inválido" });
        }
        if ((data_inicio && validarDataISO(data_inicio)) || (data_fim && validarDataISO(data_fim))) {
            return res.status(400).json({ error: "Intervalo de datas inválido" });
        }

        const query = knex("solicitacao as sol")
            .innerJoin("pacientes as pac", "pac.pac_id", "sol.pac_id")
            .leftJoin("insumo as ins", "ins.ins_id", "sol.ins_id")
            .leftJoin("postosdesaude as pos", "pos.pos_id", "sol.pos_id")
            .whereIn("sol.sol_status", STATUS_HISTORICO)
            .modify(filtroBuscaPaciente(busca))
            .modify((qb) => {
                if (!admin.tp_universal) qb.where("sol.pos_id", admin.posto_id ?? null);
                // "Revisado" inclui o status antigo "Aprovado" (mesma etapa)
                if (status === "Revisado") qb.whereIn("sol.sol_status", ["Revisado", "Aprovado"]);
                else if (status && status !== "TODOS") qb.where("sol.sol_status", status);
                if (data_inicio) qb.where("sol.sol_data_solicitacao", ">=", `${data_inicio}T00:00:00-03:00`);
                if (data_fim) qb.where("sol.sol_data_solicitacao", "<=", `${data_fim}T23:59:59.999-03:00`);
            });

        const montar = (qb) => qb.select(
            "sol.sol_id", "sol.pac_id", "sol.pos_id", "sol.sol_status",
            "sol.sol_data_solicitacao", "sol.sol_data_vencimento",
            "sol.sol_motivo_nao_autorizado", "sol.sol_motivo_reenvio",
            "sol.sol_insumo_quant", "sol.sol_observacao", "sol.sol_prescricao_tipo",
            "pac.pac_nome", "pac.pac_cpf", "pac.pac_avatar",
            "ins.ins_nome", "pos.pos_nome",
        ).orderBy("sol.sol_data_solicitacao", "desc").orderBy("sol.sol_id", "desc");

        if (req.query.page !== undefined) {
            return res.status(200).json(await paginar(query, montar, req.query));
        }

        return res.status(200).json(await query.modify(montar));

    } catch (error) {
        console.error("Erro ao buscar histórico:", error);
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

    await notificar();

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

    const negado = negarAcesso(sessao, solicitacao);
    if (negado) {
      return res.status(negado.status).json({ error: negado.error });
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
//
// ?situacao=andamento|encerradas&page=&porPagina= devolve só uma página
// daquela aba ({ itens, total, paginaAtual, totalPaginas, contagem }).
// Sem "situacao", devolve a lista inteira (formato antigo).
async minhasPrescricoes(req, res) {
  try {
    const pac_id = req.session.id;
    const { situacao } = req.query;

    if (situacao && !["andamento", "encerradas"].includes(situacao)) {
      return res.status(400).json({ error: "Situação inválida" });
    }

    // encerrada = não autorizada ou já retirada (agendamento concluído)
    const retiradas = () => knex("solicitacao")
      .select("sol_origem_id")
      .whereNotNull("sol_origem_id")
      .where("sol_status", "concluido");
    const encerradas = (qb) => qb.where((w) => w.where("sol.sol_status", "Nao Autorizado").orWhereIn("sol.sol_id", retiradas()));
    const emAndamento = (qb) => qb.whereNot("sol.sol_status", "Nao Autorizado").whereNotIn("sol.sol_id", retiradas());

    const base = () => knex("solicitacao as sol")
      .where("sol.pac_id", pac_id)
      .whereNotIn("sol.sol_status", STATUS_AGENDAMENTO);

    const contar = async (filtro) => Number((await base().modify(filtro).count({ total: "*" }).first())?.total ?? 0);

    let pagina = null;
    let consulta = base()
      .leftJoin("postosdesaude as pos", "pos.pos_id", "sol.pos_id")
      .leftJoin("insumo as ins", "ins.ins_id", "sol.ins_id")
      .leftJoin(...versoesJoin("sol"))
      .select(
        "sol.sol_id", "sol.sol_status", "sol.sol_data_solicitacao", "sol.sol_data_vencimento",
        "sol.sol_observacao", "sol.sol_prescricao_tipo", "sol.sol_insumo_quant",
        "sol.sol_motivo_nao_autorizado", "sol.sol_motivo_reenvio",
        "sol.pos_id", "pos.pos_nome", "pos.pos_whatsapp", "ins.ins_nome",
        knex.raw("(sol.sol_prescricao IS NOT NULL) AS tem_prescricao"),
        COLUNA_VERSOES,
      )
      .orderBy("sol.sol_data_solicitacao", "desc")
      .orderBy("sol.sol_id", "desc");

    if (situacao) {
      const [andamento, total_encerradas] = await Promise.all([contar(emAndamento), contar(encerradas)]);
      const total = situacao === "andamento" ? andamento : total_encerradas;
      const porPagina = Math.min(Math.max(Number(req.query.porPagina) || 10, 1), 50);
      const totalPaginas = Math.max(1, Math.ceil(total / porPagina));
      const paginaAtual = Math.min(Math.max(1, Number(req.query.page) || 1), totalPaginas);
      pagina = { total, paginaAtual, totalPaginas, contagem: { andamento, encerradas: total_encerradas } };
      consulta = consulta
        .modify(situacao === "andamento" ? emAndamento : encerradas)
        .limit(porPagina)
        .offset((paginaAtual - 1) * porPagina);
    }

    const prescricoes = numerarVersoes(await consulta);
    const ids = prescricoes.map((p) => p.sol_id);

    const agendamentos = ids.length
      ? await knex("solicitacao as ag")
        .leftJoin("postosdesaude as pos", "pos.pos_id", "ag.pos_id")
        .whereIn("ag.sol_origem_id", ids)
        .where("ag.pac_id", pac_id)
        .select(
          "ag.sol_id", "ag.sol_origem_id", "ag.sol_status", "ag.sol_protocolo", "ag.sol_data_de_coleta",
          "ag.sol_motivo_cancelamento", "ag.sol_data_cancelamento", "ag.sol_recado", "ag.sol_data_anterior",
          "pos.pos_nome", "pos.pos_endereco", "pos.pos_whatsapp",
        )
        .orderBy("ag.sol_id", "desc")
      : [];

    const eventos = ids.length
      ? await linhaDoTempo([...ids, ...agendamentos.map((a) => a.sol_id)], { ocultarNomesDaEquipe: true })
      : [];

    const itens = prescricoes.map((p) => {
      const doItem = agendamentos.filter((a) => a.sol_origem_id === p.sol_id);
      const idsDoItem = new Set([p.sol_id, ...doItem.map((a) => a.sol_id)]);
      return {
        ...p,
        // o mais recente (se o primeiro foi cancelado e houve reagendamento, vem o novo)
        agendamento: doItem[0] ?? null,
        // agendamentos cancelados antes do atual (continuam no histórico)
        // (inclui os de "não compareceu", que também não tiveram entrega)
        agendamentos_cancelados: doItem.slice(1).filter((a) => STATUS_AGENDAMENTO_SEM_ENTREGA.includes(a.sol_status))
          .map(({ sol_id, sol_status, sol_protocolo, sol_data_de_coleta, sol_motivo_cancelamento, sol_data_cancelamento }) =>
            ({ sol_id, sol_status, sol_protocolo, sol_data_de_coleta, sol_motivo_cancelamento, sol_data_cancelamento })),
        eventos: eventos.filter((e) => idsDoItem.has(e.sol_id)),
      };
    });

    return res.status(200).json(pagina ? { ...pagina, itens } : itens);

  } catch (error) {
    console.error("Erro ao buscar minhas prescrições:", error);
    return res.status(500).json({ error: "Erro ao buscar suas prescrições" });
  }
},

// REENVIO PELO PACIENTE (correção dentro da MESMA solicitação)
//
// Quando a unidade pede reenvio, a solicitação fica em "Reenvio". O
// paciente manda o arquivo corrigido por aqui: o arquivo anterior é
// guardado em prescricao_versao, a solicitação mantém o mesmo número e o
// histórico, e volta para "Pendente" (nova análise da unidade).
async corrigirPrescricao(req, res) {
  try {
    const { id } = req.params;
    const pac_id = req.session.id;
    const { sol_prescricao, sol_prescricao_tipo, sol_observacao } = req.body ?? {};

    const arquivo = validarArquivoPrescricao({ sol_prescricao, sol_prescricao_tipo, sol_observacao });
    if (arquivo.erro) {
      return res.status(400).json({ error: arquivo.erro });
    }

    const resultado = await knex.transaction(async (trx) => {
      const atual = await trx("solicitacao")
        .where("sol_id", id)
        .forUpdate()
        .first("sol_id", "pac_id", "sol_status", "sol_prescricao", "sol_prescricao_tipo",
          "sol_observacao", "sol_motivo_reenvio", "sol_data_solicitacao");

      if (!atual) return { status: 404, corpo: { error: "Solicitação não encontrada" } };
      if (Number(atual.pac_id) !== Number(pac_id)) {
        return { status: 403, corpo: { error: "Esta solicitação não é sua" } };
      }
      if (atual.sol_status !== "Reenvio") {
        return { status: 409, corpo: { error: "A unidade não pediu reenvio desta prescrição." } };
      }

      // quando a versão que sai foi enviada (o último envio ou reenvio)
      const ultimoEnvio = await trx("historico_solicitacao")
        .where("sol_id", id)
        .whereIn("his_acao", [ACOES.ENVIADA, ACOES.REENVIADA])
        .orderBy("his_criado_em", "desc")
        .first("his_criado_em");

      const versoesAnteriores = Number(
        (await trx("prescricao_versao").where("sol_id", id).count({ total: "*" }).first())?.total ?? 0
      );
      const numeroGuardado = versoesAnteriores + 1;

      await trx("prescricao_versao").insert({
        sol_id: atual.sol_id,
        ver_numero: numeroGuardado,
        ver_prescricao: atual.sol_prescricao,
        ver_prescricao_tipo: atual.sol_prescricao_tipo,
        ver_observacao: atual.sol_observacao,
        ver_motivo_reenvio: atual.sol_motivo_reenvio,
        ver_enviada_em: ultimoEnvio?.his_criado_em ?? atual.sol_data_solicitacao,
      });

      // UPDATE condicional (outro reenvio simultâneo não passa)
      const n = await trx("solicitacao")
        .where("sol_id", id)
        .where("sol_status", "Reenvio")
        .update({
          sol_prescricao: arquivo.buffer,
          sol_prescricao_tipo: arquivo.tipo,
          sol_observacao: arquivo.observacao,
          sol_status: "Pendente",
        });
      if (!n) return { status: 409, corpo: { error: "A unidade não pediu reenvio desta prescrição." } };

      const versaoNova = numeroGuardado + 1;
      await registrarHistorico(trx, req.session, {
        sol_id: atual.sol_id,
        acao: ACOES.REENVIADA,
        de: "Reenvio",
        para: "Pendente",
        detalhe: `Versão ${versaoNova} da prescrição enviada (a versão ${numeroGuardado} fica guardada).` +
          (arquivo.observacao ? `
Resposta do paciente: ${arquivo.observacao}` : ""),
      });

      return {
        status: 200,
        corpo: { message: "Prescrição reenviada. Ela voltou para análise da unidade.", sol_id: atual.sol_id, versao: versaoNova },
      };
    });

    if (resultado.status === 200) await notificar();

    return res.status(resultado.status).json(resultado.corpo);

  } catch (error) {
    console.error("Erro ao reenviar prescrição:", error);
    return res.status(500).json({ error: "Erro ao reenviar a prescrição. Tente novamente." });
  }
},

// REFAZER PEDIDO (admin)
//
// Uma prescrição "Nao Autorizado" volta para o autorizador (status
// "Revisado"), com uma observação obrigatória da unidade explicando o que
// mudou. O motivo da não autorização anterior continua no histórico.
// Prescrição vencida não volta: é preciso pedir uma nova ao paciente.
async refazerPedido(req, res) {
  try {
    const { id } = req.params;
    const observacao = req.body?.observacao;

    if (validarMotivo(observacao)) {
      return res.status(400).json({
        error: typeof observacao === "string" && observacao.trim()
          ? "A observação deve ter no máximo 500 caracteres."
          : "Informe a observação para o autorizador.",
      });
    }

    const atual = await knex("solicitacao").where("sol_id", id).first("sol_status", "sol_data_vencimento");
    if (!atual) return res.status(404).json({ error: "Solicitação não encontrada" });
    if (atual.sol_status !== "Nao Autorizado") {
      return res.status(409).json({ error: "Só é possível refazer o pedido de uma prescrição não autorizada." });
    }
    if (prescricaoVencida(atual.sol_data_vencimento, dataHojeBrasil())) {
      return res.status(409).json({
        error: `Esta prescrição venceu em ${dataBR(atual.sol_data_vencimento)}. Peça ao paciente uma prescrição nova.`,
      });
    }

    const texto = observacao.trim();
    const alterada = await knex.transaction(async (trx) => {
      const n = await trx("solicitacao")
        .where({ sol_id: id, sol_status: "Nao Autorizado" })
        .update({ sol_status: "Revisado", sol_observacao_equipe: texto, sol_motivo_nao_autorizado: null });
      if (n) {
        await registrarHistorico(trx, req.session, {
          sol_id: Number(id), acao: ACOES.REFEITA, de: "Nao Autorizado", para: "Revisado", detalhe: texto,
        });
      }
      return n;
    });

    if (!alterada) {
      return res.status(409).json({ error: "Só é possível refazer o pedido de uma prescrição não autorizada." });
    }

    await notificar();

    return res.status(200).json({ message: "Pedido reenviado ao autorizador.", sol_id: Number(id), sol_status: "Revisado" });
  } catch (error) {
    console.error("Erro ao refazer pedido:", error);
    return res.status(500).json({ error: "Erro ao refazer o pedido. Tente novamente." });
  }
},

// VERSÕES ANTERIORES DA PRESCRIÇÃO (só os dados; o arquivo vem em outra rota)
async versoes(req, res) {
  try {
    const { id } = req.params;
    const solicitacao = await knex("solicitacao").where("sol_id", id).first("sol_id", "pac_id", "pos_id");
    if (!solicitacao) return res.status(404).json({ error: "Solicitação não encontrada" });

    const negado = negarAcesso(req.session, solicitacao);
    if (negado) return res.status(negado.status).json({ error: negado.error });

    const lista = await knex("prescricao_versao")
      .where("sol_id", id)
      .orderBy("ver_numero", "asc")
      .select("ver_numero", "ver_prescricao_tipo", "ver_observacao", "ver_motivo_reenvio",
        "ver_enviada_em", "ver_substituida_em");

    return res.status(200).json(lista.map((v) => ({
      ...v,
      ver_motivo_reenvio_texto: MOTIVOS_REENVIO[v.ver_motivo_reenvio] ?? v.ver_motivo_reenvio,
    })));
  } catch (error) {
    console.error("Erro ao listar versões:", error);
    return res.status(500).json({ error: "Erro ao listar as versões da prescrição" });
  }
},

// ARQUIVO DE UMA VERSÃO ANTERIOR
async arquivoVersao(req, res) {
  try {
    const { id, versao } = req.params;
    if (!idValido(versao)) return res.status(400).json({ error: "Versão inválida" });

    const solicitacao = await knex("solicitacao").where("sol_id", id).first("sol_id", "pac_id", "pos_id");
    if (!solicitacao) return res.status(404).json({ error: "Solicitação não encontrada" });

    const negado = negarAcesso(req.session, solicitacao);
    if (negado) return res.status(negado.status).json({ error: negado.error });

    const v = await knex("prescricao_versao")
      .where({ sol_id: id, ver_numero: Number(versao) })
      .first("ver_prescricao", "ver_prescricao_tipo");
    if (!v?.ver_prescricao) return res.status(404).json({ error: "Versão não encontrada" });

    res.setHeader("Content-Type", tipoPrescricaoPermitido(v.ver_prescricao_tipo) ? v.ver_prescricao_tipo : "application/octet-stream");
    return res.send(v.ver_prescricao);
  } catch (error) {
    console.error("Erro ao buscar versão:", error);
    return res.status(500).json({ error: "Erro ao buscar a versão da prescrição" });
  }
},
};
