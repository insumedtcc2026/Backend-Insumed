// Só o administrador universal (tp_universal) — gestão da equipe da rede.
export default (req, res, next) => {
    if (req.session?.tipo !== "ADMIN" || !req.session?.tp_universal) {
        return res.status(403).json({
            error: "Acesso restrito ao administrador universal"
        });
    }

    return next();
};
