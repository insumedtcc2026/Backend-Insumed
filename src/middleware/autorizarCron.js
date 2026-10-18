// Rotas de tarefa automática (Vercel Cron). A Vercel envia
// "Authorization: Bearer <CRON_SECRET>" quando a variável existe no projeto.
export default (req, res, next) => {
    const segredo = process.env.CRON_SECRET;
    if (!segredo) {
        return res.status(503).json({ error: 'Tarefa automática não configurada (CRON_SECRET).' });
    }
    if (req.headers.authorization !== `Bearer ${segredo}`) {
        return res.status(401).json({ error: 'Não autorizado' });
    }
    return next();
};
