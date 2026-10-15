// Validações de cadastro usadas pelos controllers.
// Espelham as regras do frontend (INSUMED/src/utils/validacoes.ts):
// o frontend dá o retorno imediato, mas é aqui que a regra vale de verdade.

export const somenteDigitos = (valor) => String(valor ?? "").replace(/\D/g, "");

const texto = (valor) => (typeof valor === "string" ? valor.trim() : "");

export function cpfValido(cpf) {
  const d = somenteDigitos(cpf);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;

  const digito = (base, pesoInicial) => {
    let soma = 0;
    for (let i = 0; i < base.length; i++) soma += Number(base[i]) * (pesoInicial - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };

  return (
    digito(d.slice(0, 9), 10) === Number(d[9]) &&
    digito(d.slice(0, 10), 11) === Number(d[10])
  );
}

const REGEX_EMAIL = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}$/;

export function validarEmail(email) {
  const valor = texto(email);
  if (!valor) return "Informe o e-mail.";
  if (valor.length > 254 || !REGEX_EMAIL.test(valor) || valor.includes(".."))
    return "E-mail inválido.";
  return null;
}

export function validarCPF(cpf) {
  if (!texto(cpf)) return "Informe o CPF.";
  if (!cpfValido(cpf)) return "CPF inválido.";
  return null;
}

export function validarNome(nome) {
  const valor = texto(nome).replace(/\s+/g, " ");
  if (!valor) return "Informe o nome completo.";
  if (!/^[A-Za-zÀ-ÖØ-öø-ÿ' -]+$/.test(valor)) return "O nome deve conter apenas letras.";
  const partes = valor.split(" ");
  if (partes.length < 2 || partes[0].length < 2 || partes[partes.length - 1].length < 2)
    return "Informe nome e sobrenome.";
  if (valor.length > 100) return "O nome deve ter no máximo 100 caracteres.";
  return null;
}

export function validarTelefone(telefone) {
  const d = somenteDigitos(telefone);
  if (!d) return "Informe o telefone.";
  if (d.length !== 10 && d.length !== 11) return "Telefone inválido. Use DDD + número.";
  if (Number(d.slice(0, 2)) < 11) return "DDD inválido.";
  if (d.length === 11 && d[2] !== "9") return "Celular deve começar com 9 após o DDD.";
  return null;
}

export function validarCEP(cep) {
  if (!texto(cep)) return "Informe o CEP.";
  if (somenteDigitos(cep).length !== 8) return "CEP inválido.";
  return null;
}

export function validarDataNascimento(data) {
  if (!texto(data)) return "Informe a data de nascimento.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto(data))) return "Data de nascimento inválida.";
  const nascimento = new Date(`${texto(data)}T00:00:00`);
  if (Number.isNaN(nascimento.getTime())) return "Data de nascimento inválida.";
  const hoje = new Date();
  if (nascimento > hoje) return "A data de nascimento não pode estar no futuro.";
  if (hoje.getFullYear() - nascimento.getFullYear() > 130) return "Data de nascimento inválida.";
  return null;
}

export function validarSenha(senha) {
  if (typeof senha !== "string" || !senha) return "Informe a senha.";
  if (senha.length < 8) return "A senha deve ter no mínimo 8 caracteres.";
  if (senha.length > 64) return "A senha deve ter no máximo 64 caracteres.";
  if (/\s/.test(senha)) return "A senha não pode conter espaços.";
  if (!/[a-z]/.test(senha)) return "A senha deve ter ao menos uma letra minúscula.";
  if (!/[A-Z]/.test(senha)) return "A senha deve ter ao menos uma letra maiúscula.";
  if (!/\d/.test(senha)) return "A senha deve ter ao menos um número.";
  if (!/[^A-Za-z0-9\s]/.test(senha)) return "A senha deve ter ao menos um caractere especial.";
  return null;
}

// Só valida a confirmação quando o cliente a enviou (clientes antigos não enviam).
export function validarConfirmacaoSenha(senha, confirmacao) {
  if (confirmacao === undefined) return null;
  return senha === confirmacao ? null : "As senhas não coincidem.";
}

export function validarObrigatorio(valor, rotulo) {
  return texto(String(valor ?? "")) ? null : `Informe ${rotulo}.`;
}

// Roda uma lista de validações e devolve só as mensagens de erro.
export const coletarErros = (...resultados) => resultados.filter(Boolean);

// Formatos padronizados para salvar no banco.
export const formatarCPF = (cpf) =>
  somenteDigitos(cpf).replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");

export const formatarCEP = (cep) => somenteDigitos(cep).replace(/(\d{5})(\d{3})/, "$1-$2");

export function formatarTelefone(telefone) {
  const d = somenteDigitos(telefone);
  return d.length === 11
    ? d.replace(/(\d{2})(\d{5})(\d{4})/, "($1) $2-$3")
    : d.replace(/(\d{2})(\d{4})(\d{4})/, "($1) $2-$3");
}

export const normalizarEmail = (email) => texto(email).toLowerCase();

export const normalizarNome = (nome) => texto(nome).replace(/\s+/g, " ");

// Compara CPF ignorando pontuação, para achar duplicados salvos em formatos diferentes.
export const whereCpf = (coluna) => [
  `REPLACE(REPLACE(REPLACE(${coluna}, '.', ''), '-', ''), ' ', '') = ?`,
];

// ---------------------------------------------------------------
// Datas, motivos e identificadores (agendamentos e solicitações)
// ---------------------------------------------------------------

// Data de hoje no fuso de Brasília, no formato YYYY-MM-DD (o servidor da
// Vercel roda em UTC; sem isso, depois das 21h "hoje" já seria amanhã).
export const dataHojeBrasil = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());

// Aceita só datas reais no formato YYYY-MM-DD (rejeita 2026-02-30, por exemplo).
export function validarDataISO(data) {
  if (typeof data !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data)) return "Data inválida.";
  const [ano, mes, dia] = data.split("-").map(Number);
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  if (d.getUTCFullYear() !== ano || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia)
    return "Data inválida.";
  return null;
}

export const TAMANHO_MAX_MOTIVO = 500;

// Motivo em texto livre e obrigatório (mesmo padrão da "não autorização").
export function validarMotivo(motivo, rotulo = "") {
  const valor = texto(motivo);
  const sufixo = rotulo ? ` ${rotulo}` : "";
  if (!valor) return `Informe o motivo${sufixo}.`;
  if (valor.length > TAMANHO_MAX_MOTIVO)
    return `O motivo${sufixo} deve ter no máximo ${TAMANHO_MAX_MOTIVO} caracteres.`;
  return null;
}

// Id numérico positivo vindo da URL ou do corpo da requisição.
export const idValido = (valor) => /^\d+$/.test(String(valor ?? "")) && Number(valor) > 0;

// ---------------------------------------------------------------
// Gênero e cor/raça (opcionais no cadastro do paciente)
// ---------------------------------------------------------------

// Opções do formulário -> letra gravada em pac_sexo. Vazio = "N" (não
// informado). Aceita também a própria letra, para clientes que já a enviam.
const SEXOS = {
  masculino: "M",
  feminino: "F",
  outro: "O",
  "prefiro não responder": "N",
  "prefiro nao responder": "N",
  "prefiro não informar": "N",
  "não informado": "N",
  m: "M", f: "F", o: "O", n: "N",
};

// Devolve a letra do gênero, ou undefined se o valor não for reconhecido.
export function normalizarSexo(sexo) {
  const valor = texto(String(sexo ?? "")).normalize("NFC").toLowerCase();
  if (!valor) return "N";
  return SEXOS[valor];
}

// Categorias do IBGE + as respostas de quem não quer informar.
export const RACA_NAO_INFORMADA = "Não informado";
const RACAS = ["Branca", "Preta", "Parda", "Amarela", "Indígena", "Outra", "Prefiro não responder"];

// Devolve o texto gravado em pac_raca, ou undefined se o valor não for reconhecido.
export function normalizarRaca(raca) {
  const valor = texto(String(raca ?? "")).normalize("NFC");
  if (!valor) return RACA_NAO_INFORMADA;
  const sem = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (sem(valor) === "outro") return "Outra";
  if (sem(valor) === sem(RACA_NAO_INFORMADA)) return RACA_NAO_INFORMADA;
  return RACAS.find((r) => sem(r) === sem(valor));
}

// ---------------------------------------------------------------
// Matrícula do administrador
// ---------------------------------------------------------------
// Não existe um formato oficial único entre as unidades, então a regra
// aceita os formatos comuns de matrícula de servidor ("12345", "A-1234",
// "2024.0001", "SMS/123"): letras, números e os separadores . - /
// Ela é gravada em maiúsculas, sem espaços, e a comparação de duplicidade
// ignora os separadores ("A-1234" e "a1234" são a mesma matrícula).

export const normalizarMatricula = (matricula) =>
  texto(String(matricula ?? "")).replace(/\s+/g, "").toUpperCase();

// Chave usada para comparar (só letras e números)
export const chaveMatricula = (matricula) => normalizarMatricula(matricula).replace(/[^A-Z0-9]/g, "");

export function validarMatricula(matricula) {
  const valor = normalizarMatricula(matricula);
  if (!valor) return "Informe a matrícula.";
  if (!/^[A-Z0-9./-]+$/.test(valor)) return "A matrícula deve ter apenas letras, números e os separadores . - /";
  if (!/\d/.test(valor)) return "A matrícula deve conter ao menos um número.";
  const chave = chaveMatricula(valor);
  if (chave.length < 3) return "A matrícula deve ter ao menos 3 letras ou números.";
  if (valor.length > 20) return "A matrícula deve ter no máximo 20 caracteres.";
  return null;
}

// Mesma comparação no SQL (para achar duplicadas gravadas em outro formato)
export const whereMatricula = (coluna) => [
  `UPPER(REGEXP_REPLACE(${coluna}, '[^A-Za-z0-9]', '', 'g')) = ?`,
];

// Erros do Postgres que viram mensagem clara em vez de "erro genérico"
export function mensagemErroBanco(error) {
  if (error?.code === "22001") return "Algum campo passou do tamanho permitido. Confira os dados e tente novamente.";
  if (error?.code === "23505") return "Já existe um cadastro com estes dados.";
  if (error?.code === "23514" || error?.code === "22P02") return "Algum campo tem um valor não aceito. Confira os dados e tente novamente.";
  if (error?.code === "23502") return "Algum campo obrigatório ficou em branco.";
  return null;
}
