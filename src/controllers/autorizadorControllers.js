import knex from '../database/index.js';
import bcrypt from 'bcrypt';
import {
  coletarErros, formatarCPF, formatarTelefone, normalizarEmail, normalizarNome, somenteDigitos,
  validarConfirmacaoSenha, validarCPF, validarEmail, validarNome, validarSenha,
  validarMotivo, validarTelefone, whereCpf,
} from '../utils/validacoes.js';
import { ACOES, registrarHistorico } from '../utils/historico.js';

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
                "sol.sol_id",
                "sol.pac_id",
                "sol.pos_id",
                "sol.ins_id",
                "sol.sol_status",
                "sol.sol_data_solicitacao",
                "sol.sol_data_vencimento",
                "sol.sol_observacao",
                "sol.sol_prescricao_tipo",
                "sol.sol_insumo_quant",

                "pac.pac_nome",
                "pac.pac_cpf",
                "pac.pac_avatar",

                "ins.ins_nome",

                "pos.pos_nome"
            )
            .whereIn("sol.sol_status", [
                 
                 "Revisado",
                 "Autorizado",
                 "Nao Autorizado"
])
            .orderBy(
                "sol.sol_data_solicitacao",
                "asc"
            );


        return res.status(200).json(prescricoes);

    } catch (error) {

        console.error(
            "ERRO COMPLETO AO BUSCAR PRESCRIÇÕES:",
            error
        );

        return res.status(500).json({
            error: "Erro ao buscar prescrições."
        });
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
 

  async createautorizador(req, res) {

    try {

      const {
        nome,
        email,
        telefone,
        senha,
        confirmacao_senha,
        cpf
      } = req.body ?? {};

      const erros = coletarErros(
        validarNome(nome),
        validarEmail(email),
        validarTelefone(telefone),
        validarCPF(cpf),
        validarSenha(senha),
        validarConfirmacaoSenha(senha, confirmacao_senha),
      );
      if (erros.length) {
        return res.status(400).json({ sucesso: false, erros });
      }

      const emailExiste = await knex('autorizador')
        .whereRaw('LOWER(aut_email) = ?', [normalizarEmail(email)])
        .first();
      if (emailExiste) {
        return res.status(409).json({ erro: 'E-mail já cadastrado' });
      }

      const cpfExiste = await knex('autorizador')
        .whereRaw(...whereCpf('aut_cpf'), [somenteDigitos(cpf)])
        .first();
      if (cpfExiste) {
        return res.status(409).json({ erro: 'CPF já cadastrado' });
      }

      const hashSenha = await bcrypt.hash(senha, 10);

      await knex('autorizador').insert({
        aut_nome: normalizarNome(nome),
        aut_email: normalizarEmail(email),
        aut_tel: formatarTelefone(telefone),
        aut_senha: hashSenha,
        aut_cpf: formatarCPF(cpf)
      });

      return res.status(201).send({
        message: 'Autorizador criado com sucesso'
      });

    } catch (error) {

      console.error('Erro ao criar autorizador:', error);

      return res.status(500).send({
        erro: 'Erro ao criar autorizador. Tente novamente.'
      });

    }

  }

};
