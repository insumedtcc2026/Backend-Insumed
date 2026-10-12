export default function autorizarAut(req, res, next) {
    console.log("AUTORIZADOR - tipo:", req.session?.tipo);
    console.log("AUTORIZADOR - ID:", req.params.id);

    if (req.session?.tipo !== "AUTORIZADOR") {
        return res.status(403).json({
            error: "Acesso permitido somente para autorizadores.",
            tipoRecebido: req.session?.tipo ?? null
        });
    }

    next();
}