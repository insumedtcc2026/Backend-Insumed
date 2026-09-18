export default (req, res, next) => {
    if (req.session?.tipo !== 'ADMIN') {
        return res.status(403).send({
            error: 'Acesso restrito a administradores'
        });
    }

    return next();
};