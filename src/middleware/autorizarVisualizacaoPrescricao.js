
export default (req, res, next) => {
    const tipo = req.session?.tipo;

    if (tipo !== "ADMIN" && tipo !== "AUTORIZADOR") {
        return res.status(403).json({
            error: "Você não tem permissão para visualizar esta prescrição."
        });
    }

    return next();
};
