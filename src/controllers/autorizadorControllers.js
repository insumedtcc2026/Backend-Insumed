import knex from '../database/index.js';
import {
  validarMotivo, mensagemErroBanco, validarDataISO,
} from '../utils/validacoes.js';
import { cadastrarComConvite } from '../utils/equipe.js';
import { ACOES, registrarHistorico } from '../utils/historico.js';
import { filtroBuscaPaciente, paginar } from '../utils/paginacao.js';
import { COLUNA_VERSOES, comVersaoAnterior, numerarVersoes, versoesJoin } from '../utils/versoes.js';
import { dataBR, prescricaoVencida } from '../utils/status.js';
import { dataHojeBrasil } from '../utils/validacoes.js';
import { notificar } from '../notificacoes/processador.js';

export default {

  
  // BUSCAR TODOS OS AUTORIZADORES


  async autorizadorrall(req, res) {
    try {

      const dados = (await knex('autorizador')).map(({ aut_senha, ...resto }) => resto);


      return res.status(200).send(dados);

    } catch (error) {

      return res.status(500).send({
        message: 'Erro ao buscar autorizadores'
      });

    }
  },


  
  // BUSCAR PRESCRIÇÕES APROVADAS
 
  // Essa função é usada na tela do Autorizador.
  
  // Ela busca somente solicitações que o ADMINISTRADOR
  // já aprovou.
  

 async buscarPrescricoesAprovadas(req, res) {
    try {
        // ?status=Revisado|Autorizado|Nao Autorizado|Todos, ?busca=, ?page=
        // Com ?page= a lista vem paginada pelo banco; sem ele, inteira (como antes).
        const { status, busca, data_inicio, data_fim } = req.query;
        const STATUS_AUT = ["Aprovado", "Revisado", "Autorizado", "Nao Autorizado"];

        if (status && status !== "Todos" && !STATUS_AUT.includes(status)) {
            return res.status(400).json({ error: "Filtro de status inválido." });
        }
        if ((data_inicio && validarDataISO(data_inicio)) || (data_fim && validarDataISO(data_fim))) {
            return res.status(400).json({ error: "Intervalo de datas inválido." });
        }

        const query = knex("solicitacao as sol")
            .innerJoin("pacientes as pac", "pac.pac_id", "sol.pac_id")
            .leftJoin("insumo as ins", "ins.ins_id", "sol.ins_id")
            .leftJoin("postosdesaude as pos", "pos.pos_id", "sol.pos_id")
            .whereIn("sol.sol_status", STATUS_AUT)
            .modify(filtroBuscaPaciente(busca))
            .modify((qb) => {
                // "Revisado" inclui o status antigo "Aprovado" (mesma etapa)
                if (status === "Revisado") qb.whereIn("sol.sol_status", ["Revisado", "Aprovado"]);
                else if (status && status !== "Todos") qb.where("sol.sol_status", status);
                if (data_inicio) qb.where("sol.sol_data_solicitacao", ">=", `${data_inicio}T00:00:00-03:00`);
                if (data_fim) qb.where("sol.sol_data_solicitacao", "<=", `${data_fim}T23:59:59.999-03:00`);
            });

        const montar = (qb) => qb.leftJoin(...versoesJoin("sol")).select(
            "sol.sol_id", "sol.pac_id", "sol.pos_id", "sol.ins_id", "sol.sol_status",
            "sol.sol_data_solicitacao", "sol.sol_data_vencimento", "sol.sol_observacao",
            "sol.sol_prescricao_tipo", "sol.sol_insumo_quant", "sol.sol_observacao_equipe",
            "pac.pac_nome", "pac.pac_cpf", "pac.pac_avatar",
            "ins.ins_nome", "pos.pos_nome",
            // > 0 = o paciente reenviou uma versão corrigida antes da revisão
            COLUNA_VERSOES,
        ).orderBy("sol.sol_data_solicitacao", "asc").orderBy("sol.sol_id", "asc");

        const numerar = numerarVersoes;

        if (req.query.page !== undefined) {
            const pagina = await paginar(query, montar, req.query);
            return res.status(200).json({ ...pagina, itens: numerar(pagina.itens) });
        }

        return res.status(200).json(numerar(await query.modify(montar)));

    } catch (error) {
        console.error("ERRO COMPLETO AO BUSCAR PRESCRIÇÕES:", error);
        return res.status(500).json({
            error: "Erro ao buscar prescrições."
        });
    }
},

  // PAINEL DO AUTORIZADOR (Home): o que espera a decisão dele e as
  // decisões que ele mesmo tomou (pelo histórico).
  async painelAutorizador(req, res) {
    try {
      const aut_id = req.session.id;
      const contar = async (q) => Number((await q.count({ total: "*" }).first())?.total ?? 0);
      const trintaDias = new Date(Date.now() - 30 * 86400000).toISOString();

      const aguardandoQ = () => knex("solicitacao as sol").whereIn("sol.sol_status", ["Revisado", "Aprovado"]);
      const comVersao = comVersaoAnterior("sol.sol_id");
      const minhasDecisoes = () => knex("historico_solicitacao")
        .where({ his_usuario_tipo: "AUTORIZADOR", his_usuario_id: aut_id })
        .whereIn("his_acao", [ACOES.AUTORIZADA, ACOES.NAO_AUTORIZADA]);

      const [aguardando, comNovaVersao, autorizadas30, naoAutorizadas30, fila, recentes] = await Promise.all([
        contar(aguardandoQ()),
        contar(aguardandoQ().modify(comVersao)),
        contar(minhasDecisoes().where("his_acao", ACOES.AUTORIZADA).where("his_criado_em", ">=", trintaDias)),
        contar(minhasDecisoes().where("his_acao", ACOES.NAO_AUTORIZADA).where("his_criado_em", ">=", trintaDias)),
        aguardandoQ()
          .innerJoin("pacientes as pac", "pac.pac_id", "sol.pac_id")
          .leftJoin("insumo as ins", "ins.ins_id", "sol.ins_id")
          .leftJoin(...versoesJoin("sol"))
          .select("sol.sol_id", "sol.sol_data_solicitacao", "sol.sol_insumo_quant", "pac.pac_nome", "ins.ins_nome",
            COLUNA_VERSOES)
          .orderBy("sol.sol_data_solicitacao", "asc")
          .limit(5),
        minhasDecisoes()
          .select("sol_id", "his_acao", "his_criado_em")
          .orderBy("his_criado_em", "desc")
          .limit(5),
      ]);

      return res.status(200).json({
        aguardando,
        comNovaVersao,
        autorizadas30,
        naoAutorizadas30,
        fila: numerarVersoes(fila),
        recentes: recentes.map((r) => ({ sol_id: r.sol_id, acao: r.his_acao, quando: r.his_criado_em })),
      });
    } catch (error) {
      console.error("Erro ao montar painel do autorizador:", error);
      return res.status(500).json({ error: "Erro ao carregar o painel" });
    }
  },


  // BUSCAR UMA SOLICITAÇÃO APROVADA
  
  // Usada quando o Autorizador clica em VER MAIS.
  

  async buscarSolicitacaoAprovada(req, res) {

    try {

      const { id } = req.params;

if (!/^\d+$/.test(id)) {
  return res.status(400).json({
    error: "ID da solicitação inválido."
  });
}

      const solicitacao = await knex("solicitacao as sol")

        .innerJoin(
          "pacientes as pac",
          "pac.pac_id",
          "sol.pac_id"
        )

        .leftJoin(
          "postosdesaude as pos",
          "pos.pos_id",
          "sol.pos_id"
        )

        .leftJoin(
          "insumo as ins",
          "ins.ins_id",
          "sol.ins_id"
        )

        .select(

          // SOLICITAÇÃO
          "sol.sol_id",
          "sol.pac_id",
          "sol.pos_id",
          "sol.ins_id",

          "sol.sol_status",

          "sol.sol_data_solicitacao",
          "sol.sol_data_vencimento",
          "sol.sol_motivo_nao_autorizado",

          "sol.sol_observacao",
          // observação da unidade ao refazer um pedido não autorizado
          "sol.sol_observacao_equipe",
          "sol.sol_prescricao_tipo",

          // QUANTIDADE
          "sol.sol_insumo_quant",

          // PACIENTE
          "pac.pac_nome",
          "pac.pac_cpf",
          "pac.pac_avatar",

          // POSTO
          "pos.pos_nome",

          // INSUMO
          "ins.ins_nome",
          

        )

        .where(
          "sol.sol_id",
          id
        )

        // O AUTORIZADOR só pode abrir
        // prescrições que foram aprovadas.
       .whereIn("sol.sol_status", [
    "Aprovado",
    "Revisado",
    "Autorizado",
    "Nao Autorizado"
])

        .first();


      if (!solicitacao) {

        return res.status(404).json({
          error: "Prescrição aprovada não encontrada."
        });

      }


      return res.status(200).json(
        solicitacao
      );


    } catch (error) {

      console.error(
        "Erro ao buscar solicitação aprovada:",
        error
      );

      return res.status(500).json({
        error: "Erro ao buscar solicitação aprovada."
      });

    }

  },


  
  // BUSCAR IMAGEM DA PRESCRIÇÃO APROVADA

  async buscarPrescricaoAprovada(req, res) {

    try {

      const { id } = req.params;


      const solicitacao = await knex("solicitacao")

        .select(
          "sol_prescricao",
          "sol_prescricao_tipo",
          "sol_status",
          
        )

        .where(
          "sol_id",
          id
        )

       .whereIn("sol_status", [
    "Aprovado",
    "Revisado",
    "Autorizado",
    "Nao Autorizado"
])

        .first();


      if (!solicitacao) {

        return res.status(404).json({
          error: "Prescrição aprovada não encontrada."
        });

      }


      if (!solicitacao.sol_prescricao) {

        return res.status(404).json({
          error: "Imagem da prescrição não encontrada."
        });

      }


      const tipo =
        solicitacao.sol_prescricao_tipo ||
        "image/png";


      res.setHeader(
        "Content-Type",
        tipo
      );


      return res.send(
        solicitacao.sol_prescricao
      );


    } catch (error) {

      console.error(
        "Erro ao buscar imagem da prescrição:",
        error
      );

      return res.status(500).json({
        error: "Erro ao buscar imagem da prescrição."
      });

    }

  },


  // AUTORIZAR OU NÃO AUTORIZAR

  //
  // O AUTORIZADOR só pode escolher:

  // Autorizado
  // Nao Autorizado

  // Ele não pode alterar diretamente para Aprovado,
  // Reenvio ou outros status.
  

 
async alterarStatusAutorizador(req, res) {
    try {
        const { id } = req.params;
        const { sol_status, sol_motivo_nao_autorizado } = req.body ?? {};

        if (
            sol_status !== "Autorizado" &&
            sol_status !== "Nao Autorizado"
        ) {
            return res.status(400).json({
                error: "Status inválido."
            });
        }

        if (sol_status === "Nao Autorizado") {
            const erroMotivo = validarMotivo(sol_motivo_nao_autorizado, "da não autorização");
            if (erroMotivo) {
                return res.status(400).json({ error: erroMotivo });
            }
        }

        // Buscar antes de atualizar
        const solicitacao = await knex("solicitacao")
            .where("sol_id", id)
            .first();

        if (!solicitacao) {
            return res.status(404).json({
                error: "Solicitação não encontrada."
            });
        }

        // Impedir nova decisão sobre prescrições finalizadas
        if (
            solicitacao.sol_status !== "Aprovado" &&
            solicitacao.sol_status !== "Revisado"
        ) {
            return res.status(400).json({
                error: "Esta prescrição já foi finalizada ou não está disponível para análise."
            });
        }
// Prescrição vencida não pode mais ser autorizada (só não autorizada)
if (sol_status === "Autorizado" && prescricaoVencida(solicitacao.sol_data_vencimento, dataHojeBrasil())) {
    return res.status(409).json({
        error: `Esta prescrição venceu em ${dataBR(solicitacao.sol_data_vencimento)} e não pode mais ser autorizada.`
    });
}

const motivoSalvo =
    sol_status === "Nao Autorizado"
        ? sol_motivo_nao_autorizado.trim()
        : null;

// UPDATE condicional: se outro autorizador decidiu no meio tempo,
// nenhuma linha muda e a segunda decisão é recusada.
const alteradas = await knex.transaction(async (trx) => {
    const n = await trx("solicitacao")
        .where("sol_id", id)
        .whereIn("sol_status", ["Aprovado", "Revisado"])
        .update({
            sol_status,
            sol_motivo_nao_autorizado: motivoSalvo,
        });

    // assinatura de quem decidiu, na mesma transação
    if (n) {
        await registrarHistorico(trx, req.session, {
            sol_id: Number(id),
            acao: sol_status === "Autorizado" ? ACOES.AUTORIZADA : ACOES.NAO_AUTORIZADA,
            de: solicitacao.sol_status,
            para: sol_status,
            detalhe: motivoSalvo,
        });
    }
    return n;
});

if (!alteradas) {
    return res.status(409).json({
        error: "Esta prescrição já foi finalizada ou não está disponível para análise."
    });
}

await notificar();

const solicitacaoAtualizada = await knex("solicitacao")
    .select(
        "sol_id",
        "sol_status",
        "sol_motivo_nao_autorizado"
    )
    .where("sol_id", id)
    .first();


return res.status(200).json({
    message: "Prescrição atualizada com sucesso.",
    solicitacao: solicitacaoAtualizada,
});

    } catch (error) {
        console.error(
            "Erro ao alterar status pelo autorizador:",
            error
        );

        return res.status(500).json({
            error: "Erro ao alterar status da prescrição."
        });
    }
},


  
  // CRIAR AUTORIZADOR
 

  // Cadastro pelo link do convite gerado pelo admin universal.
  async createautorizador(req, res) {
    try {
      const { status, body } = await cadastrarComConvite('AUTORIZADOR', req.body ?? {});
      return res.status(status).send(body);
    } catch (error) {
      console.error('Erro ao criar autorizador:', error);
      const doBanco = mensagemErroBanco(error);
      if (doBanco) return res.status(400).json({ sucesso: false, erros: [doBanco] });

      return res.status(500).send({
        erro: 'Erro ao criar autorizador. Tente novamente.'
      });
    }
  }

};
