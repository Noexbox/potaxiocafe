const express = require('express');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();
const { pool, poolAdmin } = require('./db');

const app = express();

app.use(express.json());

// Carpetas internas que no deben ser accesibles desde el navegador
app.use(['/backend', '/bd', '/node_modules', '/.git', '/.vscode'], (req, res) => {
    res.status(404).send('Not found');
});

// Sirve el sitio (index.html, Pedidos.html, admin.html, css/, imgs/)
app.use(express.static(path.join(__dirname, '..')));


// ===================== ENDPOINT: crear un pedido (rol cliente) =====================
app.post('/api/pedidos', async (req, res) => {
    const { nombre, apellido, telefono, correo, notas, productos } = req.body;
    // productos = [{ id_producto: 1, cantidad: 2 }, { id_producto: 3, cantidad: 1 }]

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Crear el cliente
        const clienteResult = await client.query(
            `INSERT INTO clientes (nombre, apellido, telefono, correo)
             VALUES ($1, $2, $3, $4) RETURNING id_cliente`,
            [nombre, apellido, telefono, correo]
        );
        const id_cliente = clienteResult.rows[0].id_cliente;

        // 2. Crear el pedido (cabecera vacía, el total lo llenan los triggers)
        const pedidoResult = await client.query(
            `INSERT INTO pedidos (id_cliente, notas)
             VALUES ($1, $2) RETURNING id_pedido`,
            [id_cliente, notas]
        );
        const id_pedido = pedidoResult.rows[0].id_pedido;

        // 3. Insertar cada línea del pedido
        //    (precio_unitario se ignora, el trigger lo reemplaza con el real)
        for (const item of productos) {
            if (item.cantidad > 0) {
                await client.query(
                    `INSERT INTO detalle_pedido (id_pedido, id_producto, cantidad, precio_unitario)
                     VALUES ($1, $2, $3, 0)`,
                    [id_pedido, item.id_producto, item.cantidad]
                );
            }
        }

        // 4. Traer el total ya calculado por los triggers
        const totalResult = await client.query(
            'SELECT total FROM pedidos WHERE id_pedido = $1',
            [id_pedido]
        );

        await client.query('COMMIT');

        res.json({
            ok: true,
            id_pedido,
            total: totalResult.rows[0].total
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al crear el pedido:', error.message);
        res.status(400).json({ ok: false, error: error.message });
    } finally {
        client.release();
    }
});


// PANEL DE ADMINISTRADOR
// Todo lo que está debajo usa poolAdmin.

const ESTADOS = ['pendiente', 'en preparación', 'listo', 'entregado'];

// Protege los endpoints con la clave ADMIN_KEY del .env
function requireAdmin(req, res, next) {
    const recibida = Buffer.from(String(req.headers['x-admin-key'] || ''));
    const esperada = Buffer.from(String(process.env.ADMIN_KEY || ''));

    const valida = esperada.length > 0
        && recibida.length === esperada.length
        && crypto.timingSafeEqual(recibida, esperada);

    if (!valida) {
        return res.status(401).json({ ok: false, error: 'Clave incorrecta' });
    }
    next();
}

// ---------- Usuario de PostgreSQL con el que conecta el panel ----------
app.get('/api/admin/whoami', requireAdmin, async (req, res) => {
    try {
        const r = await poolAdmin.query('SELECT current_user AS usuario');
        res.json({ ok: true, usuario: r.rows[0].usuario });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ---------- Listar pedidos con cliente y líneas ----------
app.get('/api/admin/pedidos', requireAdmin, async (req, res) => {
    try {
        const r = await poolAdmin.query(`
            SELECT p.id_pedido, p.fecha, p.estado, p.notas, p.total,
                   c.nombre || ' ' || c.apellido AS cliente,
                   c.telefono, c.correo,
                   COALESCE(
                       json_agg(
                           json_build_object(
                               'producto', pr.nombre,
                               'cantidad', d.cantidad,
                               'precio_unitario', d.precio_unitario,
                               'subtotal', d.subtotal
                           ) ORDER BY d.id_detalle
                       ) FILTER (WHERE d.id_detalle IS NOT NULL),
                       '[]'
                   ) AS lineas
            FROM pedidos p
            JOIN clientes c ON c.id_cliente = p.id_cliente
            LEFT JOIN detalle_pedido d ON d.id_pedido = p.id_pedido
            LEFT JOIN productos pr ON pr.id_producto = d.id_producto
            GROUP BY p.id_pedido, c.id_cliente
            ORDER BY p.id_pedido DESC
        `);
        res.json({ ok: true, pedidos: r.rows });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ---------- Cambiar el estado de un pedido ----------
app.patch('/api/admin/pedidos/:id/estado', requireAdmin, async (req, res) => {
    const { estado } = req.body;
    if (!ESTADOS.includes(estado)) {
        return res.status(400).json({ ok: false, error: 'Estado no válido' });
    }
    try {
        const r = await poolAdmin.query(
            'UPDATE pedidos SET estado = $1 WHERE id_pedido = $2 RETURNING id_pedido, estado',
            [estado, req.params.id]
        );
        if (r.rowCount === 0) {
            return res.status(404).json({ ok: false, error: 'Pedido no encontrado' });
        }
        res.json({ ok: true, pedido: r.rows[0] });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ---------- Listar productos ----------
app.get('/api/admin/productos', requireAdmin, async (req, res) => {
    try {
        const r = await poolAdmin.query(
            'SELECT id_producto, nombre, precio, disponible FROM productos ORDER BY id_producto'
        );
        res.json({ ok: true, productos: r.rows });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ---------- Cambiar precio y/o disponibilidad de un producto ----------
app.patch('/api/admin/productos/:id', requireAdmin, async (req, res) => {
    const disponible = typeof req.body.disponible === 'boolean' ? req.body.disponible : null;
    const precio = req.body.precio === undefined ? null : Number(req.body.precio);

    if (precio !== null && !(precio >= 0 && precio <= 9999.99)) {
        return res.status(400).json({ ok: false, error: 'Precio no válido' });
    }
    try {
        const r = await poolAdmin.query(
            `UPDATE productos
             SET disponible = COALESCE($1, disponible),
                 precio = COALESCE($2, precio)
             WHERE id_producto = $3
             RETURNING id_producto, nombre, precio, disponible`,
            [disponible, precio, req.params.id]
        );
        if (r.rowCount === 0) {
            return res.status(404).json({ ok: false, error: 'Producto no encontrado' });
        }
        res.json({ ok: true, producto: r.rows[0] });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

// ---------- Demostración de roles ----------
// Ejecuta las mismas pruebas con ambos usuarios. Cada prueba corre dentro de una
// transacción que siempre termina en ROLLBACK, así que nunca modifica datos.
const PRUEBAS = [
    { nombre: 'Leer productos',                 sql: 'SELECT * FROM productos LIMIT 1' },
    { nombre: 'Leer clientes (datos personales)', sql: 'SELECT * FROM clientes LIMIT 1' },
    { nombre: 'Modificar productos',            sql: 'UPDATE productos SET precio = precio WHERE false' },
    { nombre: 'Borrar pedidos',                 sql: 'DELETE FROM pedidos WHERE false' },
    { nombre: 'Alterar la estructura de una tabla', sql: 'ALTER TABLE productos ADD COLUMN prueba_rol INT' }
];

async function correrPruebas(p) {
    const client = await p.connect();
    try {
        const u = await client.query('SELECT current_user AS usuario');
        const resultados = [];
        for (const prueba of PRUEBAS) {
            await client.query('BEGIN');
            try {
                await client.query(prueba.sql);
                resultados.push({ prueba: prueba.nombre, permitido: true });
            } catch (error) {
                resultados.push({ prueba: prueba.nombre, permitido: false, mensaje: error.message });
            }
            await client.query('ROLLBACK');
        }
        return { usuario: u.rows[0].usuario, resultados };
    } finally {
        client.release();
    }
}

app.get('/api/admin/roles-demo', requireAdmin, async (req, res) => {
    try {
        const [cliente, administrador] = await Promise.all([
            correrPruebas(pool),
            correrPruebas(poolAdmin)
        ]);
        res.json({ ok: true, cliente, administrador });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});