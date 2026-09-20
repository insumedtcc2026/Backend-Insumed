export default (req, res, next) => {
    if (req.session?.tipo !== 'AUTORIZADOR') {
        return res.status(403).send({
            error: 'Acesso restrito a autorizadores'
        });
    }

    return next();
};