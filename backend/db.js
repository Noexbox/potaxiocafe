const { Pool } = require('pg');
require('dotenv').config();

// Pool del backend público (formulario de pedidos).
// Debe usar el usuario con permisos mínimos: app_cliente.
const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
});

// Pool del panel de administrador (admin.html).
// Usa el usuario admin_potaxio, que hereda rol_administrador.
const poolAdmin = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.ADMIN_DB_USER,
    password: process.env.ADMIN_DB_PASSWORD,
    database: process.env.DB_NAME,
});

async function probar(nombre, p) {
    try {
        const r = await p.query('SELECT current_user AS usuario');
        console.log(`[${nombre}] conectado a ${process.env.DB_NAME} como "${r.rows[0].usuario}"`);
    } catch (err) {
        console.error(`[${nombre}] error al conectar a PostgreSQL:`, err.message);
    }
}

probar('pedidos', pool);
probar('admin', poolAdmin);

module.exports = { pool, poolAdmin };