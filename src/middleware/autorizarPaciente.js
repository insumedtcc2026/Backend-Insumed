// Rotas de dados próprios do paciente (perfil, envio e consulta das próprias
// prescrições). Sem esta checagem, o token de um administrador/autorizador
// com o mesmo id numérico de um paciente enxergaria os dados desse paciente.
export default (req, res, next) => {
    if (req.session?.tipo !== "PACIENTE") {
        return res.status(403).json({
            error: "Acesso restrito a pacientes"
        });
    }

    return next();
};
