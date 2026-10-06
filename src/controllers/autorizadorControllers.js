import knex from '../database/index.js';
import bcrypt from 'bcrypt';

export default {

  // =========================================================
  // BUSCAR TODOS OS AUTORIZADORES
  // =========================================================

  async autorizadorrall(req, res) {
    try {

      const dados = await knex('autorizador');

      console.log(dados);

      return res.status(200).send(dados);

    } catch (error) {

      return res.status(500).send({
        message: 'Erro ao buscar autorizadores',
        error: error.message
      });

    }
  },


  // =========================================================
  // BUSCAR PRESCRIÇÕES APROVADAS
  // =========================================================
  // Essa função é usada na tela do Autorizador.
  //
  // Ela busca somente solicitações que o ADMINISTRADOR
  // já aprovou.
  // =========================================================

  async buscarPrescricoesAprovadas(req, res) {

    try {

      console.log(
        "========== BUSCANDO PRESCRIÇÕES APROVADAS =========="
      );

      console.log(
        "Sessão:",
        req.session
      );

      const prescricoes = await knex("solicitacao as sol")

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

          // SOLICITAÇÃO
          "sol.sol_id",
          "sol.pac_id",
          "sol.pos_id",
          "sol.ins_id",

          "sol.sol_status",

          "sol.sol_data_solicitacao",
          "sol.sol_data_vencimento",

          "sol.sol_observacao",
          "sol.sol_prescricao_tipo",

          // QUANTIDADE SOLICITADA
          "sol.sol_insumo_quant",

          // PACIENTE
          "pac.pac_nome",
          "pac.pac_cpf",
          "pac.pac_avatar",

          // INSUMO
          "ins.ins_nome",
         

          // POSTO
          "pos.pos_nome"
        )

        .where(
          "sol.sol_status",
          "Aprovado"
        );


      console.log(
        "Prescrições encontradas:",
        prescricoes
      );


      return res.status(200).json(
        prescricoes
      );


    } catch (error) {

      console.error(
        "Erro ao buscar prescrições aprovadas:",
        error
      );

      return res.status(500).json({
        error: "Erro ao buscar prescrições aprovadas."
      });

    }

  },


  // =========================================================
  // BUSCAR UMA SOLICITAÇÃO APROVADA
  // =========================================================
  // Usada quando o Autorizador clica em VER MAIS.
  // =========================================================

  async buscarSolicitacaoAprovada(req, res) {

    try {

      const { id } = req.params;


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

          "sol.sol_observacao",
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
        .where(
          "sol.sol_status",
          "Aprovado"
        )

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


  // =========================================================
  // BUSCAR IMAGEM DA PRESCRIÇÃO APROVADA
  // =========================================================

  async buscarPrescricaoAprovada(req, res) {

    try {

      const { id } = req.params;


      const solicitacao = await knex("solicitacao")

        .select(
          "sol_prescricao",
          "sol_prescricao_tipo",
          "sol_status"
        )

        .where(
          "sol_id",
          id
        )

        .where(
          "sol_status",
          "Aprovado"
        )

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


  // =========================================================
  // AUTORIZAR OU NÃO AUTORIZAR
  // =========================================================
  //
  // O AUTORIZADOR só pode escolher:
  //
  // Autorizado
  // Nao Autorizado
  //
  // Ele não pode alterar diretamente para Aprovado,
  // Reenvio ou outros status.
  // =========================================================

  async alterarStatusAutorizador(req, res) {

    try {

      const { id } = req.params;

      const { sol_status } = req.body;


      // =====================================================
      // VALIDAR STATUS
      // =====================================================

      if (
        sol_status !== "Autorizado" &&
        sol_status !== "Nao Autorizado"
      ) {

        return res.status(400).json({
          error: "Status inválido."
        });

      }


      // =====================================================
      // BUSCAR SOLICITAÇÃO
      // =====================================================

      const solicitacao = await knex("solicitacao")

        .where(
          "sol_id",
          id
        )

        .first();


      if (!solicitacao) {

        return res.status(404).json({
          error: "Solicitação não encontrada."
        });

      }


      // =====================================================
      // SÓ PODE AUTORIZAR UMA SOLICITAÇÃO APROVADA
      // PELO ADMINISTRADOR
      // =====================================================

      if (
        solicitacao.sol_status !== "Aprovado"
      ) {

        return res.status(400).json({

          error:
            "Somente prescrições aprovadas pelo administrador podem ser autorizadas."

        });

      }


      // =====================================================
      // ATUALIZAR STATUS
      // =====================================================

      await knex("solicitacao")

        .where(
          "sol_id",
          id
        )

        .update({

          sol_status: sol_status

        });


      return res.status(200).json({

        message:
          `Prescrição ${sol_status} com sucesso.`,

        status:
          sol_status

      });


    } catch (error) {

      console.error(
        "Erro ao alterar status pelo autorizador:",
        error
      );

      return res.status(500).json({

        error:
          "Erro ao alterar status da prescrição."

      });

    }

  },


  // =========================================================
  // CRIAR AUTORIZADOR
  // =========================================================

  async createautorizador(req, res) {

    try {

      console.log(
        "BODY:",
        req.body
      );


      const {
        nome,
        email,
        telefone,
        senha,
        cpf
      } = req.body;


      const hashSenha =
        await bcrypt.hash(
          senha,
          10
        );


      const dadoscreate = {

        aut_nome: nome,

        aut_email: email,

        aut_tel: telefone,

        aut_senha: hashSenha,

        aut_cpf: cpf

      };


      await knex(
        'autorizador'
      ).insert(
        dadoscreate
      );


      return res.status(201).send({

        message:
          'Autorizador criado com sucesso'

      });


    } catch (error) {

      return res.status(500).send({

        message:
          'Erro ao criar Autorizador',

        error:
          error.message

      });

    }

  }

};