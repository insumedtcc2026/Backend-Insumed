import knex from '../database/index.js';
import bcrypt from 'bcrypt';
import jsonwebtoken from 'jsonwebtoken';

export default {
  // Busca todos os dados da tabela pacientes
  async pacientesall(req, res) {
    try {
      const pacientes = await knex('pacientes');
      return res.status(200).send(pacientes);
    } catch (error) {
      return res.status(500).send({ message: 'Erro ao buscar pacientes', error: error.message });
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
        cep,
      } = req.body;

      const sexoLimpo = (sexo || "").trim().toLowerCase();
      let sexoFormatado;

      switch (sexoLimpo) {
        case "masculino":
          sexoFormatado = "M";
          break;
        case "feminino":
          sexoFormatado = "F";
          break;
        case "outro":
          sexoFormatado = "O";
          break;
        case "prefiro não responder":
          sexoFormatado = "N";
          break;
        default:
          return res.status(400).json({
            erro: "Sexo inválido",
            recebido: sexo
          });
      }

      if (!senha) {
        return res.status(400).json({ erro: "Senha é obrigatória" });
      }

      const hashSenha = await bcrypt.hash(senha, 10);

      const dadoscreate = {
        pac_nome: nome,
        pac_email: email,
        pac_telefone: telefone,
        pac_senha: hashSenha,
        pac_cpf: cpf,
        pac_data_nasc: data_nasc || null,
        pac_sexo: sexoFormatado || null,
        pac_endereco: endereco,
        pac_raca: raca || null,
        pac_cep: cep || null,
      };

      await knex('pacientes').insert(dadoscreate);

      return res.status(201).json({ msg: "Usuário cadastrado com êxito" });

    } catch (erro) {
      console.error("ERRO NO BACKEND:", erro);
      return res.status(500).json({ erro: erro.message });
    }
  },

  // Login unificado (Paciente, Prescritor ou Admin)
  async login(req, res) {
    try {
      const { email, senha } = req.body;

      if (!email || !senha) {
        return res.status(400).json({ erro: "E-mail e senha são obrigatórios" });
      }

      const secret = process.env.ACCESS_TOKEN_SECRET || 'sua_chave_secreta_fallback';

      // 1º Tenta Paciente
      const paciente = await knex("pacientes").where("pac_email", email).first();
      if (paciente) {
        const senhaValida = await bcrypt.compare(senha, paciente.pac_senha);
        if (senhaValida) {
          const token = jsonwebtoken.sign(
            { id: paciente.pac_id || paciente.id, email: paciente.pac_email, tipo: 'PACIENTE' },
            secret,
            { expiresIn: '7d' }
          );
          //console.log("RESPOSTA:", response.data);
//console.log("TOKEN:", response.data.token);
          return res.status(200).json({
            msg: "Autenticação realizada com sucesso",
            token,
            usuario: paciente,
            tipo: 'PACIENTE'
          });
        }
      }

      // 2º Tenta Prescritor
      const prescritor = await knex("prescritor").where({ pre_email: email }).first();
      if (prescritor) {
        const senhaValida = await bcrypt.compare(senha, prescritor.pre_senha);
        if (senhaValida) {
          const token = jsonwebtoken.sign(
            { id: prescritor.pre_id, email: prescritor.pre_email, tipo: 'PRESCRITOR' },
            secret,
            { expiresIn: "7d" }
          );
          return res.status(200).json({
            msg: "Autenticação realizada com sucesso",
            token,
            usuario: prescritor,
            tipo: "PRESCRITOR"
          });
        }
      }

      // 3º Tenta Admin
      const admin = await knex("administrador").where({ adm_email: email }).first();
      if (admin) {
        const senhaValida = await bcrypt.compare(senha, admin.adm_senha);
        if (senhaValida) {
          const token = jsonwebtoken.sign(
            { id: admin.adm_id, email: admin.adm_email, tipo: 'ADMIN' },
            secret,
            { expiresIn: "7d" }
          );
          return res.status(200).json({
            msg: "Autenticação realizada com sucesso",
            token,
            usuario: admin,
            tipo: "ADMIN"
          });
        }
      }

      // Se não encontrou usuário ou a senha estava errada
      return res.status(401).json({ msg: "E-mail ou senha inválidos" });

    } catch (erro) {
      console.error("ERRO NO LOGIN:", erro);
      return res.status(500).json({ erro: erro.message });
    }
  },

  async buscarPorCpf (req, res) {
try {
const { cpf } = req.query;
if (!cpf) return res.status(200).send([]);
const termoLimpo = cpf.replace(/\D/g, '');
const pacientes = await knex('pacientes')
.whereRaw("REPLACE(REPLACE(REPLACE(pac_cpf, '.', ''), '-', ''), ' ', '') LIKE ?", [`%${termoLimpo}%`])
.select('pac_id', 'pac_nome', 'pac_cpf', 'pac_telefone').limit(10);
return res.status(200).send(pacientes);
} catch (error) {
return res.status(500).send({ message: 'Erro ao buscar pacientes', error: error.message });
}
}
};