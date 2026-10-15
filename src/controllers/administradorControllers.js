import knex from '../database/index.js';
import bcrypt from 'bcrypt';
import jsonwebtoken from 'jsonwebtoken';
import {
  coletarErros, formatarCPF, formatarTelefone, normalizarEmail, normalizarNome, somenteDigitos,
  validarConfirmacaoSenha, validarCPF, validarEmail, validarNome,
  validarSenha, validarTelefone, whereCpf,
  chaveMatricula, idValido, mensagemErroBanco, normalizarMatricula, validarMatricula, whereMatricula,
} from '../utils/validacoes.js';
import { emailEmUso } from '../utils/contas.js';
import { registrarFalhaLogin, registrarSucessoLogin } from '../middleware/limiteLogin.js';

export default {

  // busca todos os administradores
  async administradorall(req, res) {
    try {
      const dados = (await knex('administrador')).map(({ adm_senha, ...resto }) => resto);
      return res.status(200).send(dados);
    } catch (error) {
      return res.status(500).send({
        message: 'Erro ao buscar administradores'
      });
    }
  },

async createadministrador(req, res) {
  try {
    const {
      matricula,
      nome,
      email,
      telefone,
      senha,
      confirmacao_senha,
      cpf,
      posto_id,
    } = req.body ?? {};

    const erros = coletarErros(
      validarMatricula(matricula),
      validarNome(nome),
      validarEmail(email),
      validarTelefone(telefone),
      validarCPF(cpf),
      idValido(posto_id) ? null : "Selecione a unidade de saúde.",
      validarSenha(senha),
      validarConfirmacaoSenha(senha, confirmacao_senha),
    );
    if (erros.length) {
      return res.status(400).json({ sucesso: false, erros });
    }

    // Duplicidades: todos os conflitos de uma vez, para o formulário
    // mostrar tudo o que precisa ser corrigido.
    const conflitos = [];

    const matriculaExiste = await knex('administrador')
      .whereRaw(...whereMatricula('adm_matricula'), [chaveMatricula(matricula)])
      .first('adm_matricula');
    if (matriculaExiste) conflitos.push('Matrícula já cadastrada.');

    if (await emailEmUso(email)) conflitos.push('E-mail já cadastrado.');

    const cpfExiste = await knex('administrador')
      .whereRaw(...whereCpf('adm_cpf'), [somenteDigitos(cpf)])
      .first('adm_cpf');
    if (cpfExiste) conflitos.push('CPF já cadastrado como administrador.');

    if (conflitos.length) {
      return res.status(409).json({ sucesso: false, erros: conflitos });
    }

    const postoExiste = await knex('postosdesaude')
      .where('pos_id', Number(posto_id))
      .first('pos_id');
    if (!postoExiste) {
      return res.status(400).json({ sucesso: false, erros: ['Unidade de saúde não encontrada.'] });
    }

    const hashSenha = await bcrypt.hash(senha, 10);

    // tp_universal nunca vem do formulário: o cadastro público sempre cria
    // um administrador ligado a uma unidade. Admin universal só pelo banco.
    await knex('administrador').insert({
      adm_matricula: normalizarMatricula(matricula),
      adm_nome: normalizarNome(nome),
      adm_email: normalizarEmail(email),
      adm_tel: formatarTelefone(telefone),
      adm_senha: hashSenha,
      adm_cpf: formatarCPF(cpf),
      pos_id: Number(posto_id),
      tp_universal: false,
    });

    return res.status(201).send({
      message: 'Administrador criado com sucesso',
      tp_universal: false,
      vinculado_a_posto: Number(posto_id)
    });

  } catch (error) {
    console.error('Erro ao criar administrador:', error);
    // índice único da matrícula (cadastro simultâneo)
    if (error?.code === '23505') {
      return res.status(409).json({ sucesso: false, erros: ['Matrícula já cadastrada.'] });
    }
    const doBanco = mensagemErroBanco(error);
    if (doBanco) return res.status(400).json({ sucesso: false, erros: [doBanco] });
    return res.status(500).send({
      erro: 'Erro ao criar administrador. Tente novamente.'
    });
  }
},


async loginGeral(req, res) {
    try {
        const { email, senha } = req.body;

        if (!email || !senha) {
            return res.status(400).json({
                erro: "E-mail e senha são obrigatórios"
            });
        }

        if (typeof email !== "string" || typeof senha !== "string" || validarEmail(email)) {
            return res.status(400).json({ erro: "Informe um e-mail válido." });
        }

        const emailNormalizado = normalizarEmail(email);

        const secret = process.env.ACCESS_TOKEN_SECRET;

        if (!secret) {
            console.error("ACCESS_TOKEN_SECRET não configurada");
            return res.status(500).json({
                erro: "Chave de autenticação não configurada"
            });
        }
const admin = await knex("administrador")
    .whereRaw("LOWER(adm_email) = ?", [emailNormalizado])
    .first();

const autorizador = await knex("autorizador")
    .whereRaw("LOWER(aut_email) = ?", [emailNormalizado])
    .first();

const paciente = await knex("pacientes")
    .whereRaw("LOWER(pac_email) = ?", [emailNormalizado])
    .first();

// 1. TENTA LOGIN COMO ADMINISTRADOR
       


        if (admin) {
            const senhaValida = await bcrypt.compare(
                senha,
                admin.adm_senha
            );

            if (senhaValida) {

                const token = jsonwebtoken.sign(
                    {
                        email: admin.adm_email,
                        posto_id: admin.pos_id,
                        tp_universal: admin.tp_universal,
                        tipo: "ADMIN"
                    },
                    secret,
                    {
                        expiresIn: "7d"
                    }
                );

                registrarSucessoLogin(req);
                return res.status(200).json({
                    msg: "Autenticação realizada com sucesso",
                    token,

                    usuario: {
    adm_nome: admin.adm_nome,
    adm_cpf: admin.adm_cpf,
    adm_email: admin.adm_email,
    adm_tel: admin.adm_tel,

    // informações necessárias para autorização
    posto_id: admin.pos_id,
    tp_universal: admin.tp_universal,

    tipo: "ADMIN"
}
                });
            }
        }


        
        

        if (autorizador) {
            const senhaValida = await bcrypt.compare(
                senha,
                autorizador.aut_senha
            );

            if (senhaValida) {

                const token = jsonwebtoken.sign(
                    {
                        id: autorizador.aut_id,
                        email: autorizador.aut_email,
                      
                        tipo: "AUTORIZADOR"
                    },
                    secret,
                    {
                        expiresIn: "7d"
                    }
                );

                registrarSucessoLogin(req);
                return res.status(200).json({
                    msg: "Autenticação realizada com sucesso",
                    token,

                    usuario: {
    aut_id: autorizador.aut_id,
    aut_nome: autorizador.aut_nome,
    aut_cpf: autorizador.aut_cpf,
    aut_email: autorizador.aut_email,
    aut_tel: autorizador.aut_tel,

    // informações necessárias para autorização
    

    tipo: "AUTORIZADOR"
}
                });
            }
        }

        // 2. TENTA LOGIN COMO PACIENTE
       

        if (paciente) {
            const senhaValida = await bcrypt.compare(
                senha,
                paciente.pac_senha
            );

            if (senhaValida) {

                const token = jsonwebtoken.sign(
                    {
                        id: paciente.pac_id,
                        email: paciente.pac_email,
                        tipo: "PACIENTE"
                    },
                    secret,
                    {
                        expiresIn: "7d"
                    }
                );

                registrarSucessoLogin(req);
                return res.status(200).json({
                    msg: "Autenticação realizada com sucesso",
                    token,

                    usuario: {
                pac_id: paciente.pac_id,
                pac_nome: paciente.pac_nome,
                pac_email: paciente.pac_email,
                pac_telefone: paciente.pac_telefone,
                pac_cpf: paciente.pac_cpf,
                pac_cep: paciente.pac_cep,
                pac_data_nasc: paciente.pac_data_nasc,
                pac_endereco: paciente.pac_endereco,
                pac_sexo: paciente.pac_sexo,
                pac_raca: paciente.pac_raca,
                tipo: "PACIENTE"
            },

                    tipo: "PACIENTE"
                });
            }
        }

       
        // NENHUM USUÁRIO ENCONTRADO
        

        const tentativasRestantes = registrarFalhaLogin(req);

        if (tentativasRestantes === 0) {
            return res.status(429).json({
                erro: "Muitas tentativas de login. Seu acesso foi bloqueado por 15 minutos.",
                tentar_novamente_em: 15 * 60
            });
        }

        return res.status(401).json({
            msg: "E-mail ou senha inválidos",
            tentativas_restantes: tentativasRestantes
        });

    } catch (error) {

        console.error("ERRO NO LOGIN:", error);

        return res.status(500).json({
            erro: "Erro interno ao fazer login. Tente novamente."
        });

      
      }}
};
