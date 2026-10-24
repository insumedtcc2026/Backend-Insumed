// Cadastro da equipe (administrador e autorizador).
// O cadastro não é mais público: entra quem recebeu um convite do admin
// universal, ou quem o próprio admin universal cadastrou (senha provisória).
// As regras de validação ficam aqui para valer nos dois caminhos.

import bcrypt from 'bcrypt';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import knex from '../database/index.js';
import {
  coletarErros, formatarCPF, formatarTelefone, normalizarEmail, normalizarNome, somenteDigitos,
  validarConfirmacaoSenha, validarCPF, validarEmail, validarNome, validarSenha, validarTelefone, whereCpf,
  chaveMatricula, idValido, normalizarMatricula, validarMatricula, whereMatricula,
} from './validacoes.js';
import { emailEmUso } from './contas.js';

export const PERFIS_EQUIPE = ['ADMIN', 'AUTORIZADOR'];
export const VALIDADE_CONVITE_DIAS = 7;

// Código do convite: 16 caracteres aleatórios (96 bits), seguros para URL.
// Só o hash vai para o banco; o código existe apenas no link entregue.
export const gerarCodigoConvite = () => randomBytes(12).toString('base64url');
export const hashCodigo = (codigo) => createHash('sha256').update(String(codigo ?? '').trim()).digest('hex');

// Convite válido = do perfil certo, não usado, não cancelado e dentro da
// validade. A linha fica travada (FOR UPDATE) até o fim da transação, para
// o mesmo convite não ser usado duas vezes ao mesmo tempo.
export async function buscarConvite(db, codigo, perfil) {
  if (typeof codigo !== 'string' || !codigo.trim()) {
    return { erro: 'O cadastro da equipe precisa de um convite. Peça o link à administração da rede.' };
  }
  const convite = await db('convite_equipe')
    .where('cnv_codigo_hash', hashCodigo(codigo))
    .forUpdate()
    .first();
  if (!convite || convite.cnv_perfil !== perfil) {
    return { erro: 'Convite inválido. Confira o link recebido.' };
  }
  if (convite.cnv_usado_em) return { erro: 'Este convite já foi usado.' };
  if (convite.cnv_cancelado_em) return { erro: 'Este convite foi cancelado.' };
  if (new Date(convite.cnv_expira_em) < new Date()) return { erro: 'Este convite expirou. Peça um novo.' };
  return { convite };
}

// Senha provisória que já atende às regras de senha (maiúscula, minúscula,
// número e caractere especial). O funcionário troca no primeiro acesso.
export function gerarSenhaProvisoria() {
  const grupos = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '@#$%&*!?'];
  const todos = grupos.join('');
  const letras = grupos.map((g) => g[randomInt(g.length)]);
  while (letras.length < 10) letras.push(todos[randomInt(todos.length)]);
  for (let i = letras.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [letras[i], letras[j]] = [letras[j], letras[i]];
  }
  return letras.join('');
}

const falha = (status, erros) => ({ status, body: { sucesso: false, erros } });

// Cria um administrador ligado a uma unidade. Devolve { status, body }.
// Com senhaProvisoria, a senha é gerada aqui e devolvida uma única vez.
export async function cadastrarAdministrador(db, dados, { senhaProvisoria = false } = {}) {
  const { matricula, nome, email, telefone, cpf, posto_id } = dados ?? {};
  const senha = senhaProvisoria ? gerarSenhaProvisoria() : dados?.senha;

  const erros = coletarErros(
    validarMatricula(matricula),
    validarNome(nome),
    validarEmail(email),
    validarTelefone(telefone),
    validarCPF(cpf),
    idValido(posto_id) ? null : 'Selecione a unidade de saúde.',
    senhaProvisoria ? null : validarSenha(senha),
    senhaProvisoria ? null : validarConfirmacaoSenha(senha, dados?.confirmacao_senha),
  );
  if (erros.length) return falha(400, erros);

  // Duplicidades: todos os conflitos de uma vez, para o formulário
  // mostrar tudo o que precisa ser corrigido.
  const conflitos = [];
  const matriculaExiste = await db('administrador')
    .whereRaw(...whereMatricula('adm_matricula'), [chaveMatricula(matricula)])
    .first('adm_matricula');
  if (matriculaExiste) conflitos.push('Matrícula já cadastrada.');
  if (await emailEmUso(email)) conflitos.push('E-mail já cadastrado.');
  const cpfExiste = await db('administrador')
    .whereRaw(...whereCpf('adm_cpf'), [somenteDigitos(cpf)])
    .first('adm_cpf');
  if (cpfExiste) conflitos.push('CPF já cadastrado como administrador.');
  if (conflitos.length) return falha(409, conflitos);

  const postoExiste = await db('postosdesaude').where('pos_id', Number(posto_id)).first('pos_id');
  if (!postoExiste) return falha(400, ['Unidade de saúde não encontrada.']);

  // tp_universal nunca vem do formulário: admin universal só pelo banco.
  await db('administrador').insert({
    adm_matricula: normalizarMatricula(matricula),
    adm_nome: normalizarNome(nome),
    adm_email: normalizarEmail(email),
    adm_tel: formatarTelefone(telefone),
    adm_senha: await bcrypt.hash(senha, 10),
    adm_cpf: formatarCPF(cpf),
    pos_id: Number(posto_id),
    tp_universal: false,
    adm_ativo: true,
    adm_senha_provisoria: senhaProvisoria,
  });

  return {
    status: 201,
    body: {
      message: 'Administrador criado com sucesso',
      tp_universal: false,
      vinculado_a_posto: Number(posto_id),
      ...(senhaProvisoria ? { senha_provisoria: senha } : {}),
    },
  };
}

export async function cadastrarAutorizador(db, dados, { senhaProvisoria = false } = {}) {
  const { nome, email, telefone, cpf } = dados ?? {};
  const senha = senhaProvisoria ? gerarSenhaProvisoria() : dados?.senha;

  const erros = coletarErros(
    validarNome(nome),
    validarEmail(email),
    validarTelefone(telefone),
    validarCPF(cpf),
    senhaProvisoria ? null : validarSenha(senha),
    senhaProvisoria ? null : validarConfirmacaoSenha(senha, dados?.confirmacao_senha),
  );
  if (erros.length) return falha(400, erros);

  const conflitos = [];
  if (await emailEmUso(email)) conflitos.push('E-mail já cadastrado.');
  const cpfExiste = await db('autorizador')
    .whereRaw(...whereCpf('aut_cpf'), [somenteDigitos(cpf)])
    .first('aut_cpf');
  if (cpfExiste) conflitos.push('CPF já cadastrado como autorizador.');
  if (conflitos.length) return falha(409, conflitos);

  await db('autorizador').insert({
    aut_nome: normalizarNome(nome),
    aut_email: normalizarEmail(email),
    aut_tel: formatarTelefone(telefone),
    aut_senha: await bcrypt.hash(senha, 10),
    aut_cpf: formatarCPF(cpf),
    aut_ativo: true,
    aut_senha_provisoria: senhaProvisoria,
  });

  return {
    status: 201,
    body: {
      message: 'Autorizador criado com sucesso',
      ...(senhaProvisoria ? { senha_provisoria: senha } : {}),
    },
  };
}

// Cadastro aberto pelo link do convite: valida o convite, cria a conta e
// marca o convite como usado, tudo na mesma transação.
export async function cadastrarComConvite(perfil, dados) {
  return knex.transaction(async (trx) => {
    const { convite, erro } = await buscarConvite(trx, dados?.convite, perfil);
    if (erro) return falha(403, [erro]);

    // o admin fica na unidade escolhida por quem convidou
    const resultado = perfil === 'ADMIN'
      ? await cadastrarAdministrador(trx, { ...dados, posto_id: convite.pos_id ?? dados?.posto_id })
      : await cadastrarAutorizador(trx, dados);

    if (resultado.status === 201) {
      await trx('convite_equipe')
        .where('cnv_id', convite.cnv_id)
        .update({ cnv_usado_em: knex.fn.now(), cnv_usado_email: normalizarEmail(dados.email) });
    }
    return resultado;
  });
}
