import knex from '../database/index.js';
import { comItens } from '../utils/itensPrescricao.js';
import { STATUS_AGENDAMENTO } from '../utils/status.js';
import bcrypt from 'bcrypt';
import {
  coletarErros, formatarCEP, formatarCPF, formatarTelefone, normalizarEmail, normalizarNome,
  somenteDigitos, validarCEP, validarConfirmacaoSenha, validarCPF, validarDataNascimento,
  validarEmail, validarNome, validarObrigatorio, validarSenha, validarTelefone, whereCpf,
  mensagemErroBanco, normalizarRaca, normalizarSexo,
} from '../utils/validacoes.js';
import { emailEmUso } from '../utils/contas.js';


// Nunca devolver o hash da senha nas respostas da API.
const semSenha = ({ pac_senha, ...resto }) => resto;

export default {
  // Busca todos os dados da tabela pacientes
  async pacientesall(req, res) {
    try {
      const pacientes = (await knex('pacientes')).map(semSenha);
      return res.status(200).send(pacientes);
    } catch (error) {
      return res.status(500).send({ message: 'Erro ao buscar pacientes' });
    }
  },

  // Cria um novo paciente
  async createpaciente(req, res) {
    try {
      const {
        nome,
        email,
        telefone,
        cpf,
        data_nasc,
        sexo,
        endereco,
        raca,
        senha,
        confirmacao_senha,
        cep,
      } = req.body ?? {};

      // Gênero e cor/raça são opcionais: vazio vira "não informado" ("N" e
      // "Não informado"). Se vier preenchido, precisa ser uma das opções do
      // formulário (inclusive "Outro" e "Prefiro não responder").
      const sexoFormatado = normalizarSexo(sexo);
      const racaFinal = normalizarRaca(raca);

      // Valida todos os campos de uma vez para devolver todos os erros juntos.
      const erros = coletarErros(
        validarNome(nome),
        validarEmail(email),
        validarTelefone(telefone),
        validarCPF(cpf),
        validarDataNascimento(data_nasc),
        sexoFormatado ? null : "Selecione um gênero válido.",
        racaFinal ? null : "Selecione uma cor/raça válida.",
        validarCEP(cep),
        String(endereco ?? "").trim().length >= 5 ? null : "Informe o endereço completo.",
        validarSenha(senha),
        validarConfirmacaoSenha(senha, confirmacao_senha),
      );

      if (erros.length) {
        return res.status(400).json({ sucesso: false, erros });
      }

      const emailNormalizado = normalizarEmail(email);

      if (await emailEmUso(emailNormalizado)) {
        return res.status(409).json({ sucesso: false, erros: ["E-mail já cadastrado."] });
      }

      const cpfExistente = await knex('pacientes')
        .whereRaw(...whereCpf('pac_cpf'), [somenteDigitos(cpf)])
        .first();
      if (cpfExistente) {
        return res.status(409).json({ sucesso: false, erros: ["CPF já cadastrado."] });
      }

      // Geração automática do avatar (iniciais do nome)
      const partesNome = normalizarNome(nome).split(" ");
      const pac_avatar =
        partesNome[0].charAt(0).toUpperCase() +
        partesNome[partesNome.length - 1].charAt(0).toUpperCase();

      const hashSenha = await bcrypt.hash(senha, 10);

      await knex('pacientes').insert({
        pac_nome: normalizarNome(nome),
        pac_email: emailNormalizado,
        pac_telefone: formatarTelefone(telefone),
        pac_senha: hashSenha,
        pac_cpf: formatarCPF(cpf),
        pac_data_nasc: data_nasc,
        pac_sexo: sexoFormatado,
        pac_endereco: String(endereco).trim(),
        pac_raca: racaFinal,
        pac_cep: formatarCEP(cep),
        pac_avatar
      });

      return res.status(201).json({ msg: "Usuário cadastrado com êxito" });

    } catch (erro) {
      console.error("ERRO NO CADASTRO DE PACIENTE:", erro);
      const doBanco = mensagemErroBanco(erro);
      if (doBanco) return res.status(400).json({ sucesso: false, erros: [doBanco] });
      return res.status(500).json({ erro: "Erro ao cadastrar paciente. Tente novamente." });
    }
  },

  async atualizarPerfil(req, res) {
    try {
        const pacienteId = req.session.id;

        const { campo, valor } = req.body;

        const camposPermitidos = {
            nome: "pac_nome",
            cpf: "pac_cpf",
            cep: "pac_cep",
            data_nascimento: "pac_data_nasc",
            email: "pac_email",
            endereco: "pac_endereco",
            telefone: "pac_telefone",
            raca: "pac_raca"
        };

        const coluna = camposPermitidos[campo];

        if (!coluna) {
            return res.status(400).json({
                erro: "Campo não permitido para alteração."
            });
        }

        if (
            valor === undefined ||
            valor === null ||
            valor.toString().trim() === ""
        ) {
            return res.status(400).json({
                erro: "O novo valor é obrigatório."
            });
        }

        // Mesmas regras do cadastro, para o perfil não aceitar dados inválidos.
        const validadores = {
            nome: () => validarNome(valor),
            cpf: () => validarCPF(valor),
            cep: () => validarCEP(valor),
            data_nascimento: () => validarDataNascimento(valor),
            email: () => validarEmail(valor),
            telefone: () => validarTelefone(valor),
            endereco: () => String(valor).trim().length >= 5 ? null : "Informe o endereço completo.",
            raca: () => normalizarRaca(valor) ? null : "Selecione uma cor/raça válida.",
        };
        const erroValidacao = validadores[campo]?.();
        if (erroValidacao) {
            return res.status(400).json({ erro: erroValidacao });
        }

        const formatadores = {
            nome: normalizarNome,
            cpf: formatarCPF,
            cep: formatarCEP,
            email: normalizarEmail,
            telefone: formatarTelefone,
            raca: normalizarRaca,
        };
        const valorFinal = formatadores[campo] ? formatadores[campo](valor) : String(valor).trim();

        if (campo === "email" || campo === "cpf") {
            const duplicado = await knex("pacientes")
                .whereNot("pac_id", pacienteId)
                .modify((q) => campo === "email"
                    ? q.whereRaw("LOWER(pac_email) = ?", [valorFinal])
                    : q.whereRaw(...whereCpf("pac_cpf"), [somenteDigitos(valorFinal)]))
                .first();
            const emOutroPerfil = campo === "email" &&
                await emailEmUso(valorFinal, { tabela: "pacientes", filtro: (q) => q.where("pac_id", pacienteId) });
            if (duplicado || emOutroPerfil) {
                return res.status(409).json({
                    erro: campo === "email" ? "E-mail já cadastrado." : "CPF já cadastrado."
                });
            }
        }

        // 🔹 ALTERA O CAMPO NO BANCO
        await knex("pacientes")
            .where("pac_id", pacienteId)
            .update({
                [coluna]: valorFinal
            });

        // 🔹 BUSCA OS DADOS ATUALIZADOS
        const pacienteAtualizado = await knex("pacientes")
            .where("pac_id", pacienteId)
            .first();

        return res.status(200).json({
            mensagem: "Perfil atualizado com sucesso",
            usuario: semSenha(pacienteAtualizado)
        });

    } catch (error) {
        console.error("Erro ao atualizar perfil:", error);

        return res.status(500).json({
            erro: "Erro ao atualizar informação do paciente."
        });
    }
},
  

  // Busca de pacientes para o admin: por CPF (com ou sem pontuação) ou por
  // nome. Aceita ?cpf= (formato antigo) ou ?busca=.
  async buscarPorCpf(req, res) {
    try {
      const termo = String(req.query.busca ?? req.query.cpf ?? '').trim();
      const digitos = termo.replace(/\D/g, '');
      const temLetras = /[A-Za-zÀ-ÿ]/.test(termo);

      if (!digitos && !temLetras) return res.status(200).send([]);
      if (temLetras && termo.length < 2) return res.status(200).send([]);

      const consulta = knex('pacientes').select('pac_id', 'pac_nome', 'pac_cpf', 'pac_telefone');
      if (temLetras) {
        consulta.whereILike('pac_nome', `%${termo}%`).orderBy('pac_nome');
      } else {
        consulta.whereRaw("REPLACE(REPLACE(REPLACE(pac_cpf, '.', ''), '-', ''), ' ', '') LIKE ?", [`%${digitos}%`]);
      }

      return res.status(200).send(await consulta.limit(10));
    } catch (error) {
      console.error('Erro ao buscar pacientes:', error);
      return res.status(500).send({ message: 'Erro ao buscar pacientes' });
    }
  },

  // FICHA DO PACIENTE (visão do admin): dados cadastrais, prescrições e
  // agendamentos, para atender sem precisar abrir várias telas.
  async resumoPaciente(req, res) {
    try {
      const { id } = req.params;

      const paciente = await knex('pacientes').where('pac_id', id).first();
      if (!paciente) return res.status(404).send({ message: 'Paciente não encontrado' });

      const solicitacoes = await knex('solicitacao as sol')
        .leftJoin('postosdesaude as pos', 'pos.pos_id', 'sol.pos_id')
        .leftJoin('insumo as ins', 'ins.ins_id', 'sol.ins_id')
        .where('sol.pac_id', id)
        .select(
          'sol.sol_id', 'sol.sol_status', 'sol.sol_protocolo', 'sol.sol_data_solicitacao',
          'sol.sol_data_de_coleta', 'sol.sol_data_vencimento', 'sol.sol_insumo_quant',
          'sol.sol_motivo_nao_autorizado', 'sol.sol_motivo_reenvio', 'sol.sol_motivo_cancelamento',
          'sol.sol_origem_id', 'sol.sol_ciclo', 'sol.sol_periodicidade_dias', 'sol.pos_id', 'pos.pos_nome', 'ins.ins_nome',
          knex.raw('(sol.sol_prescricao IS NOT NULL) AS tem_prescricao'),
        )
        .orderBy('sol.sol_id', 'desc');

      const ehAgendamento = (s) => STATUS_AGENDAMENTO.includes(s.sol_status);

      // insumos de cada agendamento
      const idsAgendamento = solicitacoes.filter(ehAgendamento).map((s) => s.sol_id);
      const itens = idsAgendamento.length
        ? await knex('coleta as col')
          .leftJoin('insumo as ins', 'ins.ins_id', 'col.ins_id')
          .whereIn('col.sol_id', idsAgendamento)
          .select('col.sol_id', 'ins.ins_nome', 'col.quantidade')
        : [];

      const agendamentos = solicitacoes.filter(ehAgendamento).map((a) => ({
        ...a,
        insumos: itens.filter((i) => i.sol_id === a.sol_id).map(({ ins_nome, quantidade }) => ({ ins_nome, quantidade })),
      }));

      return res.status(200).send({
        paciente: semSenha(paciente),
        prescricoes: await comItens(solicitacoes.filter((s) => !ehAgendamento(s))),
        agendamentos,
      });
    } catch (error) {
      console.error('Erro ao montar ficha do paciente:', error);
      return res.status(500).send({ message: 'Erro ao buscar dados do paciente' });
    }
  },
};
