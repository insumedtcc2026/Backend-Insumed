// Limita leituras de QR Code que não encontram agendamento, para impedir
// que alguém com um token de admin tente adivinhar códigos em massa.
// Mesmo esquema do limiteLogin.js: contadores em memória, por instância.

const JANELA_MS = 10 * 60 * 1000;
const MAX_FALHAS = 30;

const registros = new Map();

setInterval(() => {
    const agora = Date.now();
    for (const [chave, r] of registros) {
        if (r.inicio + JANELA_MS < agora) registros.delete(chave);
    }
}, JANELA_MS).unref();

const chave = (req) => `${req.ip || req.socket?.remoteAddress || 'desconhecido'}:${req.session?.email ?? req.session?.id ?? ''}`;

function obter(req, agora) {
    const r = registros.get(chave(req));
    if (!r || r.inicio + JANELA_MS < agora) {
        const novo = { falhas: 0, inicio: agora };
        registros.set(chave(req), novo);
        return novo;
    }
    return r;
}

export function limiteLeituraQR(req, res, next) {
    const agora = Date.now();
    const r = obter(req, agora);
    if (r.falhas >= MAX_FALHAS) {
        const segundos = Math.ceil((r.inicio + JANELA_MS - agora) / 1000);
        res.set('Retry-After', String(segundos));
        return res.status(429).json({
            message: `Muitas leituras inválidas. Aguarde ${Math.ceil(segundos / 60)} minuto(s) e tente de novo.`
        });
    }
    next();
}

export function registrarFalhaLeituraQR(req) {
    obter(req, Date.now()).falhas += 1;
}
