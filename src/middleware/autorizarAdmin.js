export default (req, res, next) => {
    if (req.session?.tipo !== "ADMIN") {
        console.log("Acesso negado ao administrador:", {
            tipo: req.session?.tipo
        });

        return res.status(403).json({
            error: "Acesso restrito a administradores"
        });
    }

    return next();
};