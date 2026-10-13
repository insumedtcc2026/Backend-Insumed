// Limita tentativas de login para dificultar ataques de força bruta.
//
// - Por e-mail + IP: após MAX_POR_CONTA falhas na janela, bloqueia por BLOQUEIO_MS.
// - Por IP: após MAX_POR_IP falhas (qualquer e-mail), bloqueia o IP por BLOQUEIO_MS.
// Um login bem-sucedido zera o contador daquela conta.
//
// Os contadores ficam em memória. Na Vercel cada instância tem sua própria memória,
// então o limite vale por instância; para um limite global, guardar em uma tabela do banco.

const JANELA_MS = 15 * 60 * 1000;
const BLOQUEIO_MS = 15 * 60 * 1000;
const MAX_POR_CONTA = 5;
const MAX_POR_IP = 20;

const registros = new Map();

function obter(chave, agora) {
  const r = registros.get(chave);
  if (!r || (r.inicio + JANELA_MS < agora && r.bloqueadoAte < agora)) {
    const novo = { falhas: 0, inicio: agora, bloqueadoAte: 0 };
    registros.set(chave, novo);
    return novo;
  }
  return r;
}

// Limpeza periódica para o Map não crescer sem limite.
setInterval(() => {
  const agora = Date.now();
  for (const [chave, r] of registros) {
    if (r.inicio + JANELA_MS < agora && r.bloqueadoAte < agora) registros.delete(chave);
  }
}, JANELA_MS).unref();

const chaves = (req) => {
  const ip = req.ip || req.socket?.remoteAddress || "desconhecido";
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  return { conta: `conta:${ip}:${email}`, ip: `ip:${ip}` };
};

export function limiteLogin(req, res, next) {
  const agora = Date.now();
  const { conta, ip } = chaves(req);
  const bloqueadoAte = Math.max(obter(conta, agora).bloqueadoAte, obter(ip, agora).bloqueadoAte);

  if (bloqueadoAte > agora) {
    const segundos = Math.ceil((bloqueadoAte - agora) / 1000);
    res.set("Retry-After", String(segundos));
    return res.status(429).json({
      erro: `Muitas tentativas de login. Tente novamente em ${Math.ceil(segundos / 60)} minuto(s).`,
      tentar_novamente_em: segundos,
    });
  }

  next();
}

// Registra uma falha e devolve quantas tentativas ainda restam para a conta.
export function registrarFalhaLogin(req) {
  const agora = Date.now();
  const { conta, ip } = chaves(req);
  const rConta = obter(conta, agora);
  const rIp = obter(ip, agora);

  rConta.falhas += 1;
  rIp.falhas += 1;
  if (rConta.falhas >= MAX_POR_CONTA) rConta.bloqueadoAte = agora + BLOQUEIO_MS;
  if (rIp.falhas >= MAX_POR_IP) rIp.bloqueadoAte = agora + BLOQUEIO_MS;

  return Math.max(0, MAX_POR_CONTA - rConta.falhas);
}

export function registrarSucessoLogin(req) {
  registros.delete(chaves(req).conta);
}
