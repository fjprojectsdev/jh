const { registrarCliente, loginCliente } = require('../auth/authController.js');

function isPath(pathname, candidates) {
    return candidates.includes(pathname);
}

async function handleAuthRoutes(req, res, parsedUrl, helpers) {
    const pathname = parsedUrl.pathname;

    if (req.method === 'POST' && isPath(pathname, ['/auth/register', '/api/auth/register', '/auth/registro', '/api/auth/registro'])) {
        await registrarCliente(req, res, helpers);
        return true;
    }

    if (req.method === 'POST' && isPath(pathname, ['/auth/login', '/api/auth/login'])) {
        await loginCliente(req, res, helpers);
        return true;
    }

    return false;
}

module.exports = {
    handleAuthRoutes
};
